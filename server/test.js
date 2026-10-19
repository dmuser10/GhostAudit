// End-to-end tests against the real HTTP API. Each run uses a throwaway
// schema in the DATABASE_URL database, dropped afterwards, so real data is untouched.
// Run: npm test   (forces OCR + rules mode so no API key is needed)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.GHOSTAUDIT_SCHEMA = `ghostaudit_test_${crypto.randomBytes(4).toString('hex')}`;
process.env.ANTHROPIC_API_KEY = '';
const { app, ready } = require('./index');

let server, base, db;
before(async () => {
  db = await ready();
  await new Promise(r => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); });
});
after(async () => {
  server?.close();
  if (db) {
    await db.query(`DROP SCHEMA IF EXISTS ${db.schema} CASCADE`);
    await db.close();
  }
});

// Tests say who is acting with a `userId` (in the body or query). The helper signs
// in as that person with their password and sends their session cookie instead;
// the server itself ignores userId.
const DEMO = { user_alex: 'alex@ghostaudit.demo', user_jamie: 'jamie@ghostaudit.demo', user_finance: 'finance@ghostaudit.demo',
  user_priya: 'priya@koalalabs.demo', user_ben: 'ben@koalalabs.demo', user_morgan: 'morgan@koalalabs.demo' };
const creds = Object.fromEntries(Object.entries(DEMO).map(([id, email]) => [id, { email, password: 'demo1234' }]));
const cookies = {};
const cookieFrom = (res) => (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).find(c => c.startsWith('ga_session=') && c !== 'ga_session=');
async function signIn(userId) {
  const { email, password } = creds[userId];
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 200, `sign in as ${userId}`);
  return (cookies[userId] = cookieFrom(res));
}
async function call(method, url, body) {
  const u = new URL(base + url);
  const userId = body?.userId || u.searchParams.get('userId');
  u.searchParams.delete('userId');
  if (body) { body = { ...body }; delete body.userId; }
  const headers = { 'content-type': 'application/json' };
  if (userId) headers.cookie = cookies[userId] || await signIn(userId);
  const res = await fetch(u, { method, headers, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), res };
}
const claim = (userId, text, extra = {}) => call('POST', '/api/expenses/text', { userId, text, ...extra });

test('sign-in is required, and a userId in the request is ignored', async () => {
  const anon = await fetch(`${base}/api/expenses?userId=user_finance`);
  assert.equal(anon.status, 401);
  assert.equal((await fetch(`${base}/api/session`)).status, 401);
  const wrong = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'alex@ghostaudit.demo', password: 'nope' }) });
  assert.equal(wrong.status, 401);
  // Alex's session can't be turned into Taylor's by sending Taylor's id.
  const r = await call('GET', '/api/dashboard', { userId: 'user_alex' });
  assert.equal(r.status, 403);
});

test('one demo company owns both workspaces; the owner sees both, members see their own', async () => {
  const owner = await call('GET', '/api/session?userId=user_finance');
  assert.equal(owner.body.company.name, 'Demo Company');
  assert.equal(owner.body.user.is_owner, true);
  assert.deepEqual(owner.body.workspaces.map(w => [w.name, w.role, w.members]), [['Ghost Labs', 'finance', 3], ['Koala Labs', 'finance', 3]]);
  assert.equal(owner.body.active_org_id, 'org_demo');
  const morgan = await call('GET', '/api/session?userId=user_morgan');
  assert.deepEqual(morgan.body.workspaces.map(w => w.name), ['Koala Labs']);
  const alex = await call('GET', '/api/session?userId=user_alex');
  assert.deepEqual([alex.body.role, alex.body.workspaces.length], ['employee', 1]);
  const team = (await call('GET', '/api/users?userId=user_finance')).body;
  assert.deepEqual(team.map(u => u.name).sort(), ['Alex Morgan', 'Jamie Chen', 'Taylor Finance']);
});

test('meal over cap is Capped at $75 with 2.1 citation', async () => {
  const r = await claim('user_alex', 'The Corner Bistro\nDate: 2026-10-12\nLunch\nTotal: $92.50');
  assert.equal(r.body.status, 'Capped');
  assert.equal(r.body.approved_amount, 75);
  assert.match(r.body.policy_citation, /Section 2\.1/);
});

test('identical receipt from same employee is Rejected as duplicate (4.1)', async () => {
  const r = await claim('user_alex', 'THE CORNER BISTRO.\nDate: 12 Oct 2026\nLunch\nTotal: $92.50');
  assert.equal(r.body.status, 'Rejected');
  assert.equal(r.body.approved_amount, 0);
  assert.match(r.body.policy_citation, /Section 4\.1/);
});

test('same receipt from a different employee is not a duplicate', async () => {
  const r = await claim('user_jamie', 'The Corner Bistro\nDate: 2026-10-12\nLunch\nTotal: $92.50');
  assert.equal(r.body.status, 'Capped');
});

test('alcohol is Rejected (3.1)', async () => {
  const r = await claim('user_alex', 'Pub Grill\nDate: 2026-10-13\nBurger $20.00\nHouse wine $12.00\nTotal: $32.00');
  assert.equal(r.body.status, 'Rejected');
  assert.match(r.body.policy_citation, /Section 3\.1/);
});

test('ginger ale is not alcohol', async () => {
  const r = await claim('user_alex', 'Joes Diner\nDate: 2026-10-13\nBurger $15.00\nGinger ale $4.00\nTotal: $19.00');
  assert.equal(r.body.status, 'Approved');
});

test('rideshare over cap is Capped at $80 and vendor is Uber', async () => {
  const r = await claim('user_alex', 'Uber receipt\nDate: 2026-10-14\nTotal: $95.00');
  assert.equal(r.body.vendor, 'Uber');
  assert.equal(r.body.status, 'Capped');
  assert.equal(r.body.approved_amount, 80);
  assert.match(r.body.policy_citation, /Section 2\.2/);
});

test('Uber Eats is a meal, not rideshare', async () => {
  const r = await claim('user_alex', 'Uber Eats\nDate: 2026-10-14\nTotal: $40.00');
  assert.equal(r.body.category, 'Meals');
  assert.equal(r.body.status, 'Approved');
});

test('flight over $1,000 without pre-approval is Rejected (3.2)', async () => {
  const r = await claim('user_alex', 'Qantas Airways\nFlight SYD-LAX\nDate: 2026-10-15\nTotal: $1,450.00');
  assert.equal(r.body.status, 'Rejected');
  assert.match(r.body.policy_citation, /Section 3\.2/);
});

test('card "Authorization code" and typed "pre-approved" do NOT bypass 3.2', async () => {
  const r = await claim('user_alex', 'Delta Airlines\nFlight JFK-LAX\nDate: 2026-10-16\nTotal: $1450.00\nVISA ****1234 Authorization code 0482\nPre-approved by my manager');
  assert.equal(r.body.status, 'Rejected');
});

test('flight with recorded pre-approval is Approved and consumes it', async () => {
  const r = await claim('user_jamie', 'United Airlines flight\nSYD-SFO\nDate: 2026-10-16\nTotal: $1,450.00');
  assert.equal(r.body.status, 'Approved');
  assert.equal(r.body.approved_amount, 1450);
  const again = await claim('user_jamie', 'United Airlines flight\nSFO-SYD\nDate: 2026-10-10\nTotal: $1,300.00');
  assert.equal(again.body.status, 'Rejected', 'pre-approval must be single use');
});

test('total without a $ sign is found', async () => {
  const r = await claim('user_alex', 'Joes Cafe\nDate: 2026-10-17\nSandwich 12.50\nTOTAL 12.50');
  assert.equal(r.status, 201);
  assert.equal(r.body.claimed_amount, 12.5);
});

test('written-out date is normalised to ISO', async () => {
  const r = await claim('user_alex', 'Figma Inc\nOct 12, 2026\nSubscription\nTotal: $45.00');
  assert.equal(r.body.date, '2026-10-12');
  assert.equal(r.body.category, 'Software');
});

test('cash tendered / change are ignored when picking the total', async () => {
  const r = await claim('user_alex', 'Noodle House\nDate: 2026-10-18\nLunch\nTotal: $30.00\nCash: $100.00\nChange: $70.00');
  assert.equal(r.body.claimed_amount, 30);
  assert.equal(r.body.status, 'Approved');
});

test('subtotal is not mistaken for total', async () => {
  const r = await claim('user_alex', 'Thai Kitchen\nDate: 2026-10-18\nSubtotal $50.00\nTip $10.00\nTotal $60.00');
  assert.equal(r.body.claimed_amount, 60);
});

test('"Airport Cafe" is a meal and gets capped', async () => {
  const r = await claim('user_alex', 'Airport Cafe\nDate: 2026-10-18\nLunch\nTotal: $90.00');
  assert.equal(r.body.category, 'Meals');
  assert.equal(r.body.status, 'Capped');
});

test('meal cap is per person', async () => {
  const r = await claim('user_alex', 'Team Bistro\nDate: 2026-10-09\nGuests: 3\nDinner\nTotal: $200.00');
  assert.equal(r.body.attendees, 3);
  assert.equal(r.body.status, 'Approved');
  const r2 = await claim('user_alex', 'Team Bistro\nDate: 2026-10-09\nDinner\nTotal: $260.00', { attendees: 3 });
  assert.equal(r2.body.status, 'Capped');
  assert.equal(r2.body.approved_amount, 225);
});

test('AUD is the home currency: plain "$" is AUD, dates read day-first, other currencies are converted', async () => {
  const aud = await claim('user_alex', 'Sydney Bistro\nDate: 05/10/2026\nLunch\nTotal: $150.00');
  assert.equal(aud.body.currency, 'AUD');
  assert.equal(aud.body.date, '2026-10-05', '05/10 is 5 October');
  assert.equal(aud.body.approved_amount, 75, 'A$75 meal cap');
  // A$75 cap = USD 49.50 at the demo rates (AUD 0.66, USD 1).
  const usd = await claim('user_alex', 'NYC Diner\nDate: 18/10/2026\nLunch\nTotal: USD 150.00');
  assert.equal(usd.body.currency, 'USD');
  assert.equal(usd.body.date, '2026-10-18');
  assert.equal(usd.body.status, 'Capped');
  assert.equal(usd.body.approved_amount, 49.5);
  assert.ok(Math.abs(usd.body.fx_rate_to_base - 1 / 0.66) < 1e-9, 'totals convert USD to AUD');
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.base_currency, 'AUD');
});

test('multiple violations are all cited', async () => {
  await claim('user_jamie', 'Wine Bar\nDate: 2026-10-01\nPinot noir $40.00\nTotal: $40.00');
  const r = await claim('user_jamie', 'Wine Bar\nDate: 2026-10-01\nPinot noir $40.00\nTotal: $40.00');
  assert.match(r.body.policy_citation, /3\.1/);
  assert.match(r.body.policy_citation, /4\.1/);
});

test('missing total gives a clear error and no row', async () => {
  const before = (await call('GET', '/api/expenses?userId=user_alex')).body.length;
  const r = await claim('user_alex', 'Some Shop\nDate: 2026-10-01\nThanks!');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /total/i);
  assert.equal((await call('GET', '/api/expenses?userId=user_alex')).body.length, before);
});

test('employee correction overrides extraction and is logged under the employee id', async () => {
  const r = await claim('user_alex', 'Corner Store\nDate: 2026-10-02\nTotal: $10.00', { amount: '12.00' });
  assert.equal(r.body.claimed_amount, 12);
  const logs = (await call('GET', `/api/expenses/${r.body.id}/logs?userId=user_alex`)).body;
  assert.ok(logs.some(l => l.actor === 'user_alex' && l.action === 'fields_corrected_by_employee'));
});

test('every decision writes extractor + auditor entries to AuditLog', async () => {
  const r = await claim('user_alex', 'Notion Labs\nDate: 2026-10-03\nTotal: $8.00');
  const logs = (await call('GET', `/api/expenses/${r.body.id}/logs?userId=user_alex`)).body;
  const actions = logs.map(l => l.action);
  assert.deepEqual(actions, ['receipt_extracted', 'policy_evaluated', 'decision_finalised']);
});

test('finance editing a cap changes enforcement and the cited text', async () => {
  const upd = await call('PUT', '/api/policy/2.1', { userId: 'user_finance', value: 50 });
  assert.equal(upd.status, 200);
  assert.match(upd.body.body, /\$50/);
  const r = await claim('user_jamie', 'Lunch Spot\nDate: 2026-10-04\nLunch\nTotal: $60.00');
  assert.equal(r.body.approved_amount, 50);
  assert.match(r.body.policy_citation, /\$50/);
  await call('PUT', '/api/policy/2.1', { userId: 'user_finance', value: 75 });
});

test('role checks: employees cannot see dashboard or edit policy; finance cannot submit', async () => {
  assert.equal((await call('GET', '/api/dashboard?userId=user_alex')).status, 403);
  assert.equal((await call('PUT', '/api/policy/2.1', { userId: 'user_alex', value: 1000 })).status, 403);
  assert.equal((await claim('user_finance', 'X\nDate: 2026-10-01\nTotal: $5.00')).status, 403);
  const other = (await call('GET', '/api/expenses?userId=user_jamie')).body[0];
  assert.equal((await call('GET', `/api/expenses/${other.id}/logs?userId=user_alex`)).status, 404);
});

test('dashboard totals reconcile: claimed = paid + saved', async () => {
  const d = (await call('GET', '/api/dashboard?userId=user_finance')).body;
  assert.ok(Math.abs(d.totals.claimed - (d.totals.paid + d.totals.saved)) < 0.01);
  assert.ok(d.totals.saved_caps > 0 && d.totals.saved_rejections > 0);
});

test('future-dated receipt is refused with a clear message', async () => {
  const r = await claim('user_alex', 'Future Cafe\nDate: 2099-01-01\nTotal: $10.00');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /future/i);
});

/* ---------------- policy manager ---------------- */

const fs = require('fs');
const path = require('path');
const { openDatabase } = require('./db');
const F = 'user_finance';
const rules = async (userId = F) => (await call('GET', `/api/policy?userId=${userId}`)).body;
const importPdf = async (file) => {
  const fd = new FormData();
  fd.append('userId', F);
  fd.append('policy', new Blob([fs.readFileSync(file)], { type: 'application/pdf' }), path.basename(file));
  const res = await fetch(base + '/api/policy/import', { method: 'POST', body: fd, headers: { cookie: cookies[F] || await signIn(F) } });
  return { status: res.status, body: await res.json() };
};

test('switching the alcohol rule off allows wine; switching it on rejects again', async () => {
  assert.equal((await call('PUT', '/api/policy/3.1', { userId: F, enabled: false })).body.enabled, false);
  const r = await claim('user_alex', 'Cellar Door\nDate: 2026-09-01\nHouse wine $20.00\nTotal: $20.00');
  assert.equal(r.body.status, 'Approved');
  const logs = (await call('GET', `/api/expenses/${r.body.id}/logs?userId=user_alex`)).body;
  assert.deepEqual(logs.find(l => l.action === 'policy_evaluated').details.disabled_sections, ['3.1']);
  await call('PUT', '/api/policy/3.1', { userId: F, enabled: true });
  const r2 = await claim('user_alex', 'Cellar Door\nDate: 2026-09-02\nHouse wine $21.00\nTotal: $21.00');
  assert.equal(r2.body.status, 'Rejected');
});

test('preset checkbox bans tobacco with its own keywords and section', async () => {
  const presets = (await call('GET', '/api/policy/presets')).body;
  assert.ok(presets.some(p => p.item === 'tobacco') && presets.some(p => p.item === 'alcohol'));
  const created = await call('POST', '/api/policy', { userId: F, preset: 'tobacco' });
  assert.equal(created.status, 201);
  assert.equal(created.body.section, '4.2');
  const r = await claim('user_alex', 'Corner Store\nDate: 2026-09-03\nCigarettes $18.00\nTotal: $18.00');
  assert.equal(r.body.status, 'Rejected');
  assert.match(r.body.policy_citation, /Section 4\.2: Tobacco and vaping/);
  // Unticking switches it off rather than deleting it.
  await call('PUT', '/api/policy/4.2', { userId: F, enabled: false });
  assert.equal((await claim('user_alex', 'Corner Store\nDate: 2026-09-04\nCigarettes $19.00\nTotal: $19.00')).body.status, 'Approved');
  assert.equal((await call('POST', '/api/policy', { userId: F, preset: 'tobacco' })).body.enabled, true);
});

test('finance adds a custom cap and a custom banned item; duplicates are refused', async () => {
  const cap = await call('POST', '/api/policy', { userId: F, rule: { rule_type: 'cap', category: 'Travel', expense_types: ['hotel'], per: 'claim', limit: 200 } });
  assert.equal(cap.status, 201);
  assert.match(cap.body.body, /Accommodation: capped at \$200 per claim/);
  const r = await claim('user_alex', 'Harbour Hotel\nDate: 2026-09-05\nRoom 1 night\nTotal: $300.00');
  assert.equal(r.body.status, 'Capped');
  assert.equal(r.body.approved_amount, 200);
  const again = await call('POST', '/api/policy', { userId: F, rule: { rule_type: 'cap', category: 'Travel', expense_types: ['hotel'], limit: 150 } });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /already covers/);

  const gym = await call('POST', '/api/policy', { userId: F, section: '9.1', rule: { rule_type: 'prohibited_item', item: 'Gym memberships', keywords: 'gym, fitness first' } });
  assert.equal(gym.body.section, '9.1');
  assert.equal((await claim('user_alex', 'Fitness First\nDate: 2026-09-06\nMonthly membership\nTotal: $55.00')).body.status, 'Rejected');
  assert.equal((await call('POST', '/api/policy', { userId: F, rule: { rule_type: 'cap', limit: -5 } })).status, 400);
});

test('deleting a rule stops enforcing it, and seed rules do not come back on restart', async () => {
  assert.equal((await call('DELETE', `/api/policy/9.1?userId=${F}`)).status, 200);
  assert.equal((await claim('user_alex', 'Fitness First\nDate: 2026-09-07\nMonthly membership\nTotal: $56.00')).body.status, 'Approved');
  await call('DELETE', `/api/policy/4.1?userId=${F}`);
  const reopened = await openDatabase(process.env.DATABASE_URL, { schema: db.schema });
  await reopened.close();
  assert.ok(!(await rules()).some(r => r.section === '4.1'), 'deleted seed rule must stay deleted');
  // Put the duplicate rule back for anything that runs later.
  assert.equal((await call('POST', '/api/policy', { userId: F, section: '4.1', rule: { rule_type: 'duplicate' } })).body.section, '4.1');
});

const POLICY_PDF = path.join(__dirname, '..', 'ghostaudit-demo-receipts', '10_company_policy.pdf');
const KOALA_PDF = path.join(__dirname, '..', 'ghostaudit-demo-receipts', '11_koala_labs_policy.pdf');
// Receipt dates relative to today, so the receipt-age rule doesn't make these tests expire.
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test('policy PDF upload updates existing rules and adds new ones straight away', async () => {
  await call('PUT', '/api/policy/3.1', { userId: F, enabled: false });
  const p = await importPdf(POLICY_PDF);
  assert.equal(p.status, 200);
  const by = (pred) => p.body.rules.find(pred);
  assert.deepEqual(p.body.updated.sort(), ['2.1', '2.2', '3.1', '3.2', '4.3']);
  assert.deepEqual(p.body.added.sort(), ['3.3', '3.4', '4.4']);
  assert.deepEqual(p.body.unchanged.sort(), ['4.1', '4.2']);
  assert.deepEqual(by(r => r.params.item === 'alcohol').changes, ['turned on']);
  assert.equal(by(r => r.rule_type === 'receipt_age').params.max_days, 60);
  assert.deepEqual(by(r => r.params.item === 'gym memberships').params.keywords, ['gym memberships', 'gym membership']);
  assert.deepEqual(p.body.unmatched, []);

  const now = await rules();
  assert.equal(now.find(r => r.section === '2.1').params.limit, 60);
  assert.equal(now.find(r => r.section === '3.2').params.threshold, 800);
  assert.equal(now.find(r => r.section === '3.1').enabled, true);
  assert.equal(now.find(r => r.section === '3.3').source, 'pdf:10_company_policy.pdf');
  assert.equal((await claim('user_jamie', `Noodle Bar\nDate: ${daysAgo(3)}\nLunch\nTotal: $70.00`)).body.approved_amount, 60);

  // Uploading the same PDF again changes nothing.
  const again = await importPdf(POLICY_PDF);
  assert.deepEqual([again.body.added.length, again.body.updated.length], [0, 0]);

  // Undo the first import: back to the policy before it, including 3.1 being off and no 3.3.
  assert.equal((await call('POST', '/api/policy/restore', { userId: F, snapshot_id: p.body.snapshot_id })).status, 200);
  const undone = await rules();
  assert.equal(undone.find(r => r.section === '2.1').params.limit, 75);
  assert.equal(undone.find(r => r.section === '3.1').enabled, false);
  assert.ok(!undone.some(r => r.section === '3.3'));
  await call('PUT', '/api/policy/3.1', { userId: F, enabled: true });
});

test('clear all removes every rule, can be undone, and clear + upload gives just the PDF policy', async () => {
  const before = await rules();
  const cleared = await call('DELETE', `/api/policy?userId=${F}`);
  assert.equal(cleared.body.cleared, before.length);
  assert.equal((await rules()).length, 0);
  const r = await claim('user_alex', 'Cellar Door\nDate: 2026-09-09\nHouse wine $30.00\nTotal: $30.00');
  assert.equal(r.body.status, 'Approved');
  assert.equal(r.body.policy_citation, 'No enabled policy rule applies to this claim.');

  await call('POST', '/api/policy/restore', { userId: F, snapshot_id: cleared.body.snapshot_id });
  assert.deepEqual((await rules()).map(x => x.section), before.map(x => x.section));

  await call('DELETE', `/api/policy?userId=${F}`);
  const p = await importPdf(POLICY_PDF);
  assert.equal(p.body.updated.length, 0);
  assert.deepEqual((await rules()).map(x => x.section).sort(), ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '3.4', '4.1', '4.2']);
});

test('Koala Labs policy: all 6 numbered rules are imported and enforced', async () => {
  await call('DELETE', `/api/policy?userId=${F}`);
  const p = await importPdf(KOALA_PDF);
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.added, ['4.1', '4.2', '5.1', '5.2', '6.1', '7.1']);
  assert.deepEqual(p.body.rules.map(r => r.rule_type),
    ['cap', 'prohibited_item', 'preapproval_required', 'prohibited_item', 'receipt_age', 'preapproval_required']);
  // "unless pre-approved" (4.2) and "require VP sign-off … otherwise" (5.2) become pre-approval exceptions.
  assert.equal(p.body.rules.find(r => r.section === '4.2').params.allow_preapproval, true);
  assert.equal(p.body.rules.find(r => r.section === '5.2').params.allow_preapproval, true);
  assert.match(p.body.rules.find(r => r.section === '5.2').notes.join(' '), /sign-off/);
  assert.ok(p.body.unmatched.every(u => !/^\d/.test(u.section || '')), 'every numbered clause became a rule');

  const ok = await claim('user_alex', `Koala Cafe\nDate: ${daysAgo(2)}\nLunch\nTotal: $40.00`);
  assert.equal(ok.body.status, 'Approved');
  const upgrade = await claim('user_alex', `Qantas flight SYD-MEL\nDate: ${daysAgo(2)}\nBusiness class upgrade\nTotal: $600.00`);
  assert.equal(upgrade.body.status, 'Rejected');
  assert.match(upgrade.body.policy_citation, /Section 5\.2/);
  // "upgrade" only counts on flights: a software plan upgrade is fine (and under the $50 threshold).
  const plan = await claim('user_alex', `Figma Inc\nDate: ${daysAgo(2)}\nPlan upgrade subscription\nTotal: $30.00`);
  assert.equal(plan.body.status, 'Approved');
  const pricey = await claim('user_alex', `Notion Labs\nDate: ${daysAgo(2)}\nTeam subscription\nTotal: $80.00`);
  assert.match(pricey.body.policy_citation, /Section 7\.1/);
  const old = await claim('user_alex', `Old Cafe\nDate: ${daysAgo(90)}\nLunch\nTotal: $20.00`);
  assert.equal(old.body.status, 'Rejected');
  assert.match(old.body.decision_reason, /90 days old/);
  assert.match(old.body.policy_citation, /Section 6\.1: Receipts must be submitted within 60 days/);
  assert.equal((await call('PUT', '/api/policy/6.1', { userId: F, value: 120 })).body.params.max_days, 120);
  assert.equal((await claim('user_alex', `Old Cafe\nDate: ${daysAgo(91)}\nLunch\nTotal: $21.00`)).body.status, 'Approved');
});

test('"unless pre-approved": a finance pre-approval that allows the item lets one claim through', async () => {
  // Continues from the Koala policy: 4.2 alcohol and 5.2 flight upgrades accept pre-approvals.
  const wine = (n) => claim('user_alex', `Harbour Dinner\nDate: ${daysAgo(n)}\nDinner $40.00\nGlass of wine $15.00\nTotal: $55.00`);
  const r1 = await wine(1);
  assert.equal(r1.body.status, 'Rejected');
  assert.match(r1.body.decision_reason, /No unused meal pre-approval that allows alcohol/);

  const bad = await call('POST', '/api/preapprovals', { userId: F, employee_id: 'user_alex', expense_type: 'meal', description: 'x', max_amount: 100, allows: ['tobacco'] });
  assert.equal(bad.status, 400);
  const pa = await call('POST', '/api/preapprovals', { userId: F, employee_id: 'user_alex', expense_type: 'meal', description: 'Client dinner with wine', max_amount: 100, allows: ['alcohol'] });
  assert.equal(pa.status, 201);
  assert.deepEqual(pa.body.allows, ['alcohol']);

  const r2 = await wine(2);
  assert.equal(r2.body.status, 'Approved');
  assert.match(r2.body.decision_reason, /Allowed by pre-approval/);
  assert.match(r2.body.policy_citation, /Section 4\.2/);
  assert.equal((await wine(3)).body.status, 'Rejected', 'the pre-approval is single use');

  // A $1,100 business-class flight needs 5.1 (over $1,000) and 5.2 (upgrade): one pre-approval covers both.
  await call('POST', '/api/preapprovals', { userId: F, employee_id: 'user_alex', expense_type: 'flight', description: 'Board trip, business class', max_amount: 1200, allows: ['flight upgrades'] });
  const flight = await claim('user_alex', `Qantas flight SYD-PER\nDate: ${daysAgo(1)}\nBusiness class\nTotal: $1,100.00`);
  assert.equal(flight.body.status, 'Approved');
  assert.match(flight.body.policy_citation, /Section 5\.1.*Section 5\.2/);
  const logs = (await call('GET', `/api/expenses/${flight.body.id}/logs?userId=user_alex`)).body;
  assert.equal(logs.filter(l => l.action === 'preapproval_consumed').length, 1);

  // Finance can switch the exception off: the citation drops the "unless" wording.
  const off = await call('PUT', '/api/policy/4.2', { userId: F, allow_preapproval: false });
  assert.equal(off.body.params.allow_preapproval, undefined);
  assert.doesNotMatch(off.body.body, /unless/);
});

test('only finance can change the policy', async () => {
  assert.equal((await call('POST', '/api/policy', { userId: 'user_alex', preset: 'gambling' })).status, 403);
  assert.equal((await call('PUT', '/api/policy/3.1', { userId: 'user_alex', enabled: false })).status, 403);
  assert.equal((await call('DELETE', '/api/policy/3.1?userId=user_alex')).status, 403);
  assert.equal((await call('DELETE', '/api/policy?userId=user_alex')).status, 403);
  assert.equal((await call('POST', '/api/policy/restore', { userId: 'user_alex', snapshot_id: 'x' })).status, 403);
});

/* ---------------- workspaces ---------------- */

const KF = 'user_morgan'; // Koala Labs finance

test('Koala Labs has its own policy, seeded from its policy PDF', async () => {
  const koala = await rules(KF);
  assert.deepEqual(koala.map(r => r.section), ['4.1', '4.2', '5.1', '5.2', '6.1', '7.1']);
  assert.equal(koala.find(r => r.section === '4.2').params.allow_preapproval, true);
  assert.equal(koala.find(r => r.section === '6.1').params.max_days, 60);
});

test('workspaces are isolated: policy, claims, dashboard, pre-approvals and undo', async () => {
  const ghostBefore = await rules(F);
  const koalaBefore = await rules(KF);

  // Koala has no taxi cap, so the same Uber receipt is paid in full there.
  const uber = await claim('user_priya', `Uber receipt\nDate: ${daysAgo(1)}\nTotal: $95.00`);
  assert.equal(uber.body.status, 'Approved');
  assert.equal(uber.body.org_id, 'org_koala');

  // Koala finance changes only Koala's policy.
  assert.equal((await call('PUT', '/api/policy/4.1', { userId: KF, value: 50 })).body.params.limit, 50);
  assert.equal((await call('PUT', '/api/policy/2.2', { userId: KF, value: 1 })).status, 404, 'cannot reach another workspace\'s rule');
  const cleared = await call('DELETE', `/api/policy?userId=${KF}`);
  assert.equal(cleared.body.cleared, koalaBefore.length);
  assert.deepEqual((await rules(F)).map(r => [r.section, r.params]), ghostBefore.map(r => [r.section, r.params]), 'Ghost Labs untouched');
  // Ghost finance can't undo Koala's clear.
  assert.equal((await call('POST', '/api/policy/restore', { userId: F, snapshot_id: cleared.body.snapshot_id })).status, 404);
  await call('POST', '/api/policy/restore', { userId: KF, snapshot_id: cleared.body.snapshot_id });
  assert.equal((await rules(KF)).find(r => r.section === '4.1').params.limit, 50);

  // Claims, dashboards and audit logs stay inside their workspace.
  const koalaClaims = (await call('GET', `/api/expenses?userId=${KF}`)).body;
  assert.ok(koalaClaims.length >= 1 && koalaClaims.every(e => e.org_id === 'org_koala'));
  assert.ok((await call('GET', `/api/expenses?userId=${F}`)).body.every(e => e.org_id === 'org_demo'));
  assert.equal((await call('GET', `/api/dashboard?userId=${KF}`)).body.totals.count, koalaClaims.length);
  const ghostClaim = (await call('GET', `/api/expenses?userId=${F}`)).body[0];
  assert.equal((await call('GET', `/api/expenses/${ghostClaim.id}/logs?userId=${KF}`)).status, 404);

  // Pre-approvals only for employees in your own workspace.
  const cross = await call('POST', '/api/preapprovals', { userId: KF, employee_id: 'user_alex', expense_type: 'meal', description: 'x', max_amount: 10 });
  assert.equal(cross.status, 400);
  assert.ok((await call('GET', `/api/preapprovals?userId=${KF}`)).body.every(p => p.org_id === 'org_koala'));
});

const post = (url, body, cookie) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

test('a company signs up, gets its own workspace and policy, and stays separate', async () => {
  const weak = await post('/api/auth/signup', { company: 'Wombat Works', name: 'Sky Patel', email: 'sky@wombat.demo', password: 'short' });
  assert.equal(weak.status, 400);
  const res = await post('/api/auth/signup', { company: 'Wombat Works', name: 'Sky Patel', email: 'Sky@Wombat.demo', password: 'wombat-pass-1', workspace: 'Wombat HQ' });
  assert.equal(res.status, 201);
  const s = await res.json();
  assert.deepEqual([s.company.name, s.user.is_owner, s.role, s.workspaces.map(w => w.name)], ['Wombat Works', true, 'finance', ['Wombat HQ']]);
  creds.sky = { email: 'sky@wombat.demo', password: 'wombat-pass-1' };
  cookies.sky = cookieFrom(res);
  assert.ok(cookies.sky, 'signed in straight after sign-up');
  assert.equal((await post('/api/auth/signup', { company: 'X', name: 'X', email: 'sky@wombat.demo', password: 'another-pass' })).status, 400, 'one account per email');

  // Starter policy, and nothing from the demo company is reachable.
  assert.deepEqual((await rules('sky')).map(x => x.section), ['2.1', '2.2', '3.1', '3.2', '4.1']);
  assert.equal((await call('POST', '/api/session/workspace', { userId: 'sky', org_id: 'org_demo' })).status, 404);
  assert.ok((await call('GET', '/api/expenses?userId=sky')).body.every(e => e.org_id === s.active_org_id));
  assert.equal((await call('POST', '/api/workspaces', { userId: KF, name: 'Sneaky' })).status, 403, 'only owners create workspaces');

  // The owner adds a second workspace (empty policy) and is switched into it.
  const ws2 = await call('POST', '/api/workspaces', { userId: 'sky', name: 'Wombat Labs', starter_policy: false });
  assert.equal(ws2.status, 201);
  assert.deepEqual(ws2.body.workspaces.map(w => w.name), ['Wombat HQ', 'Wombat Labs']);
  assert.deepEqual(await rules('sky'), []);
  // Reopening the database must not seed a policy into a workspace that chose to start empty.
  const reopened = await openDatabase(process.env.DATABASE_URL, { schema: db.schema });
  await reopened.close();
  assert.deepEqual(await rules('sky'), []);

  // An employee added with a starting password can sign in and claim.
  const jo = await call('POST', '/api/users', { userId: 'sky', name: 'Jo Kim', email: 'jo@wombat.demo', role: 'employee', password: 'jo-start-123' });
  assert.equal(jo.status, 201);
  creds.jo = { email: 'jo@wombat.demo', password: 'jo-start-123' };
  const c = await claim('jo', `Wombat Cafe\nDate: ${daysAgo(1)}\nLunch\nTotal: $90.00`);
  assert.equal(c.body.status, 'Approved', 'empty policy: paid in full');

  // Jo changes their password; the old one stops working.
  assert.equal((await call('PUT', '/api/me/password', { userId: 'jo', current: 'wrong', password: 'jo-new-pass-9' })).status, 400);
  assert.equal((await call('PUT', '/api/me/password', { userId: 'jo', current: 'jo-start-123', password: 'jo-new-pass-9' })).status, 200);
  assert.equal((await post('/api/auth/login', { email: 'jo@wombat.demo', password: 'jo-start-123' })).status, 401);
  assert.equal((await post('/api/auth/login', { email: 'jo@wombat.demo', password: 'jo-new-pass-9' })).status, 200);

  // Signing out ends the session.
  assert.equal((await post('/api/auth/logout', {}, cookies.sky)).status, 200);
  assert.equal((await fetch(`${base}/api/session`, { headers: { cookie: cookies.sky } })).status, 401);
  delete cookies.sky;
});

test('finance adds people to their workspace with a password, and can reset it', async () => {
  const noPass = await call('POST', '/api/users', { userId: KF, name: 'Dana Wu', email: 'dana@koalalabs.demo', role: 'employee' });
  assert.equal(noPass.status, 400);
  const added = await call('POST', '/api/users', { userId: KF, name: 'Dana Wu', email: 'dana@koalalabs.demo', role: 'employee', password: 'dana-pass-1' });
  assert.equal(added.status, 201);
  creds.dana = { email: 'dana@koalalabs.demo', password: 'dana-pass-1' };
  assert.equal((await call('POST', '/api/users', { userId: KF, name: 'Dana Again', email: 'DANA@koalalabs.demo', password: 'whatever-123' })).status, 400, 'already in this workspace');
  assert.equal((await call('POST', '/api/users', { userId: KF, email: 'sky@wombat.demo' })).status, 400, 'belongs to another company');
  assert.equal((await call('POST', '/api/users', { userId: 'user_priya', name: 'X', email: 'x@koalalabs.demo', password: 'whatever-123' })).status, 403);
  assert.equal((await call('GET', `/api/session?userId=${KF}`)).body.workspaces[0].members, 4);
  assert.equal((await claim('dana', `Koala Cafe\nDate: ${daysAgo(1)}\nLunch\nTotal: $20.00`)).status, 201);

  // The owner adds Dana (already in the company) to Ghost Labs too; Dana switches there.
  const both = await call('POST', '/api/users', { userId: 'user_finance', email: 'dana@koalalabs.demo', role: 'employee' });
  assert.equal(both.body.added_existing, true);
  const sw = await call('POST', '/api/session/workspace', { userId: 'dana', org_id: 'org_demo' });
  assert.deepEqual(sw.body.workspaces.map(w => w.name), ['Ghost Labs', 'Koala Labs']);
  assert.equal((await claim('dana', `Ghost Cafe\nDate: ${daysAgo(1)}\nLunch\nTotal: $21.00`)).body.org_id, 'org_demo');

  // Morgan resets Dana's password (signing Dana out everywhere); Morgan can't touch the owner.
  assert.equal((await call('PUT', `/api/users/${added.body.id}/password`, { userId: KF, password: 'dana-reset-2' })).status, 200);
  assert.equal((await post('/api/auth/login', creds.dana)).status, 401);
  creds.dana.password = 'dana-reset-2'; delete cookies.dana;
  assert.equal((await post('/api/auth/login', creds.dana)).status, 200);
  assert.notEqual((await call('PUT', '/api/users/user_finance/password', { userId: KF, password: 'taken-over-1' })).status, 200);
});

test('repeated wrong passwords are slowed down', async () => {
  const attempt = () => post('/api/auth/login', { email: 'nobody@example.demo', password: 'guess-guess' });
  for (let i = 0; i < 10; i++) assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 429);
});

test('the owner deletes someone: gone from every workspace and sign-in, history kept, can be brought back', async () => {
  const added = await call('POST', '/api/users', { userId: 'user_finance', name: 'Sam Temp', email: 'sam@ghostaudit.demo', role: 'employee', password: 'sam-pass-123' });
  assert.equal(added.status, 201);
  creds.sam = { email: 'sam@ghostaudit.demo', password: 'sam-pass-123' };
  const c = await claim('sam', `Sam Cafe\nDate: ${daysAgo(1)}\nLunch\nTotal: $18.00`);
  assert.equal(c.status, 201);
  const samCookie = cookies.sam;

  assert.equal((await call('DELETE', `/api/users/${added.body.id}`, { userId: KF })).status, 403, 'finance (not owner) cannot delete');
  assert.equal((await call('DELETE', '/api/users/user_finance', { userId: 'user_finance' })).status, 400, 'owner cannot delete themselves');
  const del = await call('DELETE', `/api/users/${added.body.id}`, { userId: 'user_finance' });
  assert.equal(del.status, 200);

  assert.equal((await fetch(`${base}/api/session`, { headers: { cookie: samCookie } })).status, 401, 'signed out');
  assert.equal((await post('/api/auth/login', creds.sam)).status, 401, 'cannot sign in');
  assert.ok(!(await call('GET', '/api/users?userId=user_finance')).body.some(u => u.id === added.body.id), 'not in the team list');
  const kept = (await call('GET', '/api/expenses?userId=user_finance')).body.find(e => e.id === c.body.id);
  assert.equal(kept.employee_name, 'Sam Temp', 'past claims keep their name');
  assert.equal((await call('DELETE', `/api/users/${added.body.id}`, { userId: 'user_finance' })).status, 404, 'already deleted');

  // Adding the same email again brings the account back with a new password.
  assert.equal((await call('POST', '/api/users', { userId: 'user_finance', email: 'sam@ghostaudit.demo' })).status, 400, 'needs a new password');
  const back = await call('POST', '/api/users', { userId: 'user_finance', email: 'sam@ghostaudit.demo', password: 'sam-back-456' });
  assert.equal(back.body.restored, true);
  assert.equal((await post('/api/auth/login', { email: 'sam@ghostaudit.demo', password: 'sam-back-456' })).status, 200);
});

test('only the owner can cancel the subscription; it ends on 5 November 2026 and can be resumed', async () => {
  const s = (await call('GET', '/api/session?userId=user_finance')).body;
  assert.deepEqual(s.company.subscription, { status: 'active', ends_on_if_cancelled: '2026-11-05' });
  assert.equal((await call('POST', '/api/company/subscription/cancel', { userId: KF })).status, 403);
  const cancelled = await call('POST', '/api/company/subscription/cancel', { userId: 'user_finance' });
  assert.deepEqual(cancelled.body.company.subscription, { status: 'cancelled', ends_on: '2026-11-05' });
  // Everyone in the company still works until then.
  assert.equal((await claim('user_alex', `Still Open Cafe\nDate: ${daysAgo(1)}\nLunch\nTotal: $12.00`)).status, 201);
  const resumed = await call('POST', '/api/company/subscription/resume', { userId: 'user_finance' });
  assert.equal(resumed.body.company.subscription.status, 'active');
});

test('Demo Company owner can reset all demo claims; accounts, policy and pre-approvals stay', async () => {
  const ghost = (await call('GET', '/api/expenses?userId=user_finance')).body;
  assert.ok(ghost.length > 0, 'earlier tests left claims to clear');
  const withReceipt = ghost.find(e => e.receipt_url) || null;
  const rulesBefore = (await rules('user_finance')).length;

  assert.equal((await call('POST', '/api/demo/reset-claims', { userId: KF })).status, 403, 'finance (not owner) cannot');
  assert.equal((await call('POST', '/api/demo/reset-claims', { userId: 'jo' })).status, 403, 'other companies cannot');
  const sky = await post('/api/auth/login', creds.sky);
  assert.equal((await post('/api/demo/reset-claims', {}, cookieFrom(sky))).status, 403, 'another company\'s owner cannot');
  const otherCompanyClaims = (await call('GET', '/api/expenses?userId=jo')).body.length;

  const r = await call('POST', '/api/demo/reset-claims', { userId: 'user_finance' });
  assert.equal(r.status, 200);
  assert.ok(r.body.expenses >= ghost.length);
  assert.deepEqual((await call('GET', '/api/expenses?userId=user_finance')).body, [], 'Ghost Labs empty');
  assert.deepEqual((await call('GET', '/api/expenses?userId=user_morgan')).body, [], 'Koala Labs empty');
  assert.equal((await call('GET', '/api/dashboard?userId=user_finance')).body.totals.count, 0);
  if (withReceipt) assert.equal((await call('GET', `${withReceipt.receipt_url}?userId=user_finance`)).status, 404, 'receipt files deleted');

  // Accounts, policy and pre-approvals are untouched; used pre-approvals are free again.
  assert.equal((await post('/api/auth/login', { email: 'alex@ghostaudit.demo', password: 'demo1234' })).status, 200);
  assert.equal((await rules('user_finance')).length, rulesBefore);
  const pas = (await call('GET', '/api/preapprovals?userId=user_finance')).body;
  assert.ok(pas.length > 0 && pas.every(p => !p.used_by_expense_id));
  assert.equal((await call('GET', '/api/expenses?userId=jo')).body.length, otherCompanyClaims, 'other companies untouched');
});
