const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Minimal .env loader (avoids an extra dependency). Real env vars win.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { openDatabase, renderBody, seedStarterPolicy, DEMO_COMPANY, now, uid } = require('./db');
const { extract, claudeEnabled, pdfText, CATEGORIES, EXPENSE_TYPES, TYPE_TO_CATEGORY, CURRENCIES, parseDate } = require('./extractor');
const { auditAndRecord, loadPolicy } = require('./auditor');
const { BASE_CURRENCY } = require('./currency');
const { PRESETS, validateRule, findMatch, describeChange, nextSection, previewPolicy } = require('./policy');
const {
  COOKIE, SESSION_DAYS, DAY, hashPassword, verifyPassword, passwordProblem, tokenId, createSession,
  readToken, setCookie, clearCookie, loginBlocked, recordFailure, clearFailures
} = require('./auth');

const PORT = process.env.PORT || 4000;
const PRODUCTION = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
// Receipts are stored in the database, so keep them small. Photos are shrunk in the
// browser before upload; this cap mainly applies to PDFs. (On Vercel, request bodies
// over 4.5 MB are rejected before reaching the app.)
const MAX_UPLOAD_MB = 10;

// Supabase Postgres. ready() resolves once the tables exist and demo data is seeded.
// A failed connection is retried on the next request instead of being cached.
let db, opening, baseRate = 1;
function ready() {
  opening ||= openDatabase(process.env.DATABASE_URL, { schema: process.env.GHOSTAUDIT_SCHEMA || 'ghostaudit' })
    .then(async (d) => {
      const r = await d.get('SELECT rate_to_usd FROM FxRates WHERE currency=?', [BASE_CURRENCY]);
      if (!r) throw new Error(`BASE_CURRENCY ${BASE_CURRENCY} has no exchange rate in FxRates.`);
      baseRate = r.rate_to_usd;
      db = d;
      return d;
    }, (e) => { opening = null; throw e; });
  return opening;
}

const app = express();
// Render (and most hosts) sit behind one proxy: trust it for the client IP and HTTPS,
// so sign-in rate limits see real IPs and the session cookie is marked Secure.
app.set('trust proxy', 1);
// No CORS: the app and API share one origin, and the session cookie is SameSite=Lax.
app.use(express.json({ limit: '4mb' }));
app.use('/api', (req, _res, next) => (req.path === '/health' ? next() : ready().then(() => next(), next)));

// Express 4 doesn't catch rejected promises; send them to the error handler.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ALLOWED_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/tiff': '.tiff', 'image/bmp': '.bmp', 'application/pdf': '.pdf' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES[file.mimetype]) return cb(null, true);
    cb(Object.assign(new Error('Upload a receipt image (PNG, JPG, WEBP) or a PDF.'), { status: 400 }));
  }
});

/* ---------------- helpers ---------------- */

// Workspaces a person can open, with their role in each. A company owner can open
// every workspace in their company as finance.
function workspacesFor(u) {
  const members = '(SELECT COUNT(*) FROM Memberships x WHERE x.org_id=w.id)';
  return u.is_owner
    ? db.all(`SELECT w.id, w.name, 'finance' AS role, ${members} AS members FROM Workspaces w WHERE w.company_id=? ORDER BY w.created_at, w.name`, [u.company_id])
    : db.all(`SELECT w.id, w.name, m.role, ${members} AS members FROM Memberships m JOIN Workspaces w ON w.id=m.org_id
        WHERE m.user_id=? AND w.company_id=? ORDER BY w.created_at, w.name`, [u.id, u.company_id]);
}

// The signed-in person, from the session cookie. The result has the same shape the
// routes have always used: id, name, org_id (active workspace), role (in it).
async function currentUser(req) {
  const token = readToken(req);
  if (!token) return null;
  const s = await db.get(`SELECT s.id AS session_id, s.active_org_id, s.expires_at, u.id, u.name, u.email, u.company_id, u.is_owner, c.name AS company_name,
    c.subscription_cancelled_at, c.subscription_ends_on
    FROM Sessions s JOIN Users u ON u.id=s.user_id JOIN Companies c ON c.id=u.company_id
    WHERE s.id=? AND s.expires_at > now() AND u.deleted_at IS NULL`, [tokenId(token)]);
  if (!s) return null;
  // Sliding expiry: someone who keeps using the app stays signed in (at most one write a day).
  if (Date.parse(s.expires_at) - Date.now() < (SESSION_DAYS - 1) * DAY) {
    await db.run('UPDATE Sessions SET expires_at=? WHERE id=?', [new Date(Date.now() + SESSION_DAYS * DAY).toISOString(), s.session_id]);
  }
  const workspaces = await workspacesFor(s);
  const active = workspaces.find(w => w.id === s.active_org_id) || workspaces[0] || null;
  return { ...s, workspaces, org_id: active?.id || null, role: active?.role || null, workspace_name: active?.name || null };
}

async function requireUser(req, res, role) {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: 'Please sign in.' }); return null; }
  if (!user.org_id) { res.status(403).json({ error: 'You are not a member of any workspace yet. Ask your finance team to add you.' }); return null; }
  if (role && user.role !== role) {
    res.status(403).json({ error: role === 'finance' ? 'Only finance users can do this.' : 'Only employees can submit claims.' });
    return null;
  }
  return user;
}

// A member of the given workspace, with their role there.
const memberOf = (orgId, userId) => db.get(`SELECT u.id, u.name, u.email, m.role FROM Memberships m JOIN Users u ON u.id=m.user_id
  WHERE m.org_id=? AND m.user_id=?`, [orgId, String(userId || '')]);
// fx_rate_to_base converts a claim's amounts into the home currency for totals.
const parseRow = (r) => ({ ...r, line_items: r.line_items || [], fx_rate_to_base: r.fx_rate_to_usd / baseRate });

// Employee corrections from the "Review / correct" panel. Returned separately
// so they can be written to the AuditLog under the employee's id.
function applyCorrections(fields, body) {
  const corrections = {};
  const set = (key, value) => { corrections[key] = { extracted: fields[key], corrected: value }; fields[key] = value; };
  if (body.vendor && String(body.vendor).trim()) set('vendor', String(body.vendor).trim().slice(0, 160));
  if (body.date) {
    const d = parseDate(body.date);
    if (!d) throw new Error('Corrected date is not a valid date.');
    set('date', d);
  }
  if (body.amount !== undefined && body.amount !== '') {
    const a = Math.round(Number(body.amount) * 100) / 100;
    if (!Number.isFinite(a) || a <= 0) throw new Error('Corrected amount must be a positive number.');
    set('amount', a);
  }
  if (body.currency && CURRENCIES.includes(body.currency) && body.currency !== fields.currency) set('currency', body.currency);
  if (body.attendees !== undefined && body.attendees !== '') {
    const n = parseInt(body.attendees, 10);
    if (!(n >= 1 && n <= 50)) throw new Error('Number of people must be between 1 and 50.');
    set('attendees', n);
  }
  if (body.category && CATEGORIES.includes(body.category) && body.category !== fields.category) {
    set('category', body.category);
    // Keep expense_type consistent with the corrected category.
    if (TYPE_TO_CATEGORY[fields.expense_type] !== body.category) {
      fields.expense_type = { Meals: 'meal', Travel: 'other_travel', Software: 'software', Other: 'other' }[body.category];
    }
  }
  return corrections;
}

async function handleClaim(req, res, { text, file }) {
  const user = await requireUser(req, res, 'employee');
  if (!user) return;
  let receiptId = null;
  try {
    const { fields, method, notes } = await extract({ text, file });
    const corrections = applyCorrections(fields, req.body);
    if (file) {
      receiptId = crypto.randomUUID();
      await db.run('INSERT INTO Receipts (id,mimetype,data,org_id) VALUES (?,?,?,?)', [receiptId, file.mimetype, file.buffer, user.org_id]);
    }
    const expense = await auditAndRecord(db, {
      user, fields, method, notes, corrections,
      receiptUrl: receiptId ? `/api/receipts/${receiptId}` : null
    });
    res.status(201).json({ ...parseRow(expense), extracted_text: fields.raw_text });
  } catch (e) {
    if (receiptId) await db.run('DELETE FROM Receipts WHERE id=?', [receiptId]).catch(() => {});
    // Postgres errors carry a 5-character SQLSTATE code; those are server faults, not bad input.
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) throw e;
    res.status(400).json({ error: e.message || 'Could not process this receipt.' });
  }
}

/* ---------------- routes ---------------- */

app.get('/api/health', (_req, res) => res.json({
  ok: true, persistence: 'Supabase Postgres', base_currency: BASE_CURRENCY, extractor: claudeEnabled() ? 'claude' : 'ocr+rules',
  model: claudeEnabled() ? (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5') : null
}));

// Receipt files: only for signed-in people who can open the receipt's workspace.
app.get('/api/receipts/:id', h(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  const r = await db.get('SELECT mimetype, data, org_id FROM Receipts WHERE id=?', [req.params.id]);
  // Receipts saved before sign-in existed have no workspace; any signed-in person may view those.
  if (!r || (r.org_id && !user.workspaces.some(w => w.id === r.org_id))) return res.status(404).json({ error: 'Receipt not found.' });
  res.set({ 'Content-Type': r.mimetype, 'Cache-Control': 'private, max-age=86400' }).send(r.data);
}));

const cleanName = (v, max = 80) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanEmail = (v) => String(v || '').trim().toLowerCase().slice(0, 120);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const sessionInfo = (u) => ({
  user: { id: u.id, name: u.name, email: u.email, is_owner: u.is_owner },
  company: {
    id: u.company_id, name: u.company_name,
    subscription: u.subscription_cancelled_at
      ? { status: 'cancelled', ends_on: u.subscription_ends_on }
      : { status: 'active', ends_on_if_cancelled: SUBSCRIPTION_END }
  },
  workspaces: u.workspaces, active_org_id: u.org_id, role: u.role
});

/* ---------------- sign-up, sign-in, session ---------------- */

// A company signs up: creates the company, its first workspace, and the owner's account.
app.post('/api/auth/signup', h(async (req, res) => {
  const company = cleanName(req.body.company), name = cleanName(req.body.name), email = cleanEmail(req.body.email);
  const workspace = cleanName(req.body.workspace) || company;
  if (!company) return res.status(400).json({ error: 'Enter your company name.' });
  if (!name || !validEmail(email)) return res.status(400).json({ error: 'Enter your name and a valid email.' });
  const bad = passwordProblem(req.body.password);
  if (bad) return res.status(400).json({ error: bad });
  if (await db.get('SELECT 1 FROM Users WHERE lower(email)=?', [email])) return res.status(400).json({ error: 'An account with this email already exists. Sign in instead.' });
  const hash = await hashPassword(req.body.password);
  const ids = await db.transaction(async (tx) => {
    const companyId = uid('co'), orgId = uid('org'), userId = uid('user');
    await tx.run('INSERT INTO Companies (id,name) VALUES (?,?)', [companyId, company]);
    await tx.run('INSERT INTO Workspaces (id,name,company_id) VALUES (?,?,?)', [orgId, workspace, companyId]);
    await tx.run('INSERT INTO Users (id,name,email,role,org_id,company_id,password_hash,is_owner) VALUES (?,?,?,?,?,?,?,true)',
      [userId, name, email, 'finance', orgId, companyId, hash]);
    await tx.run(`INSERT INTO Memberships (user_id,org_id,role) VALUES (?,?,'finance')`, [userId, orgId]);
    if (req.body.starter_policy !== false) await seedStarterPolicy(tx, orgId);
    await tx.run('INSERT INTO Meta (key,value) VALUES (?,?)', [`policy_seeded:${orgId}`, now()]);
    return { userId, orgId };
  });
  const token = await createSession(db, ids.userId, ids.orgId);
  setCookie(req, res, token);
  res.status(201).json(sessionInfo(await currentUser({ headers: { cookie: `${COOKIE}=${token}` } })));
}));

app.post('/api/auth/login', h(async (req, res) => {
  const email = cleanEmail(req.body.email);
  const key = `${req.ip}|${email}`;
  if (loginBlocked(key)) return res.status(429).json({ error: 'Too many failed attempts. Wait 15 minutes and try again.' });
  // Older data may have the same email in more than one place; accept whichever password matches.
  const candidates = email ? await db.all('SELECT id, org_id, password_hash FROM Users WHERE lower(email)=? AND deleted_at IS NULL', [email]) : [];
  let match = null;
  for (const c of candidates) if (await verifyPassword(req.body.password, c.password_hash)) { match = c; break; }
  if (!match) {
    recordFailure(key);
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  clearFailures(key);
  const token = await createSession(db, match.id, match.org_id);
  setCookie(req, res, token);
  res.json(sessionInfo(await currentUser({ headers: { cookie: `${COOKIE}=${token}` } })));
}));

app.post('/api/auth/logout', h(async (req, res) => {
  const token = readToken(req);
  if (token) await db.run('DELETE FROM Sessions WHERE id=?', [tokenId(token)]);
  clearCookie(req, res);
  res.json({ ok: true });
}));

app.get('/api/session', h(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  res.json(sessionInfo(user));
}));

// Switch workspace; remembered in the session, so it survives a refresh or restart.
app.post('/api/session/workspace', h(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  if (!user.workspaces.some(w => w.id === req.body.org_id)) return res.status(404).json({ error: 'Workspace not found.' });
  await db.run('UPDATE Sessions SET active_org_id=? WHERE id=?', [req.body.org_id, user.session_id]);
  res.json(sessionInfo(await currentUser(req)));
}));

app.put('/api/me/password', h(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  const row = await db.get('SELECT password_hash FROM Users WHERE id=?', [user.id]);
  if (!(await verifyPassword(req.body.current, row.password_hash))) return res.status(400).json({ error: 'Current password is incorrect.' });
  const bad = passwordProblem(req.body.password);
  if (bad) return res.status(400).json({ error: bad });
  await db.run('UPDATE Users SET password_hash=? WHERE id=?', [await hashPassword(req.body.password), user.id]);
  // Sign out other devices; keep this one.
  await db.run('DELETE FROM Sessions WHERE user_id=? AND id<>?', [user.id, user.session_id]);
  res.json({ ok: true });
}));

app.put('/api/company', h(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  if (!user.is_owner) return res.status(403).json({ error: 'Only the company owner can rename the company.' });
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Enter a company name.' });
  await db.run('UPDATE Companies SET name=? WHERE id=?', [name, user.company_id]);
  res.json(sessionInfo(await currentUser(req)));
}));

/* ---------------- workspaces and people ---------------- */

app.get('/api/workspaces', h(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  res.json(user.workspaces);
}));

// The company owner adds a workspace to their company and lands in it.
app.post('/api/workspaces', h(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  if (!user.is_owner) return res.status(403).json({ error: 'Only the company owner can create workspaces.' });
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Name the workspace.' });
  if (await db.get('SELECT 1 FROM Workspaces WHERE company_id=? AND lower(name)=lower(?)', [user.company_id, name])) {
    return res.status(400).json({ error: `Your company already has a workspace called "${name}".` });
  }
  const id = uid('org');
  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO Workspaces (id,name,company_id) VALUES (?,?,?)', [id, name, user.company_id]);
    await tx.run(`INSERT INTO Memberships (user_id,org_id,role) VALUES (?,?,'finance')`, [user.id, id]);
    if (req.body.starter_policy !== false) await seedStarterPolicy(tx, id);
    await tx.run('INSERT INTO Meta (key,value) VALUES (?,?)', [`policy_seeded:${id}`, now()]);
    await tx.run('UPDATE Sessions SET active_org_id=? WHERE id=?', [id, user.session_id]);
  });
  res.status(201).json(sessionInfo(await currentUser(req)));
}));

// People in the active workspace (for the team list, pre-approvals and audit names).
// Company owners can open every workspace, so they're listed too.
app.get('/api/users', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  res.json(await db.all(`SELECT u.id, u.name, u.email, COALESCE(m.role, 'finance') AS role, u.is_owner
    FROM Users u LEFT JOIN Memberships m ON m.user_id=u.id AND m.org_id=?
    WHERE u.company_id=? AND u.deleted_at IS NULL AND (m.user_id IS NOT NULL OR u.is_owner)
    ORDER BY CASE COALESCE(m.role, 'finance') WHEN 'finance' THEN 1 ELSE 0 END, u.name`, [user.org_id, user.company_id]));
}));

// Finance adds someone to the active workspace. A new person gets the password
// finance sets (to pass on to them); someone already in the company is just added.
app.post('/api/users', h(async (req, res) => {
  const user = await requireUser(req, res, 'finance');
  if (!user) return;
  const name = cleanName(req.body.name), email = cleanEmail(req.body.email);
  const role = req.body.role === 'finance' ? 'finance' : 'employee';
  if (!validEmail(email)) return res.status(400).json({ error: 'Add a valid email.' });
  const existing = await db.get('SELECT id, name, company_id, deleted_at FROM Users WHERE lower(email)=? ORDER BY deleted_at NULLS FIRST', [email]);
  if (existing && existing.company_id !== user.company_id) return res.status(400).json({ error: `${email} already belongs to another company.` });
  if (existing?.deleted_at) {
    const bad = passwordProblem(req.body.password);
    if (bad) return res.status(400).json({ error: `${email} was deleted earlier. ${bad} Set a new starting password to bring them back.` });
    const hash = await hashPassword(req.body.password);
    await db.transaction(async (tx) => {
      await tx.run('UPDATE Users SET deleted_at=NULL, password_hash=?, name=COALESCE(NULLIF(?, \'\'), name), org_id=?, role=? WHERE id=?',
        [hash, name, user.org_id, role, existing.id]);
      await tx.run('INSERT INTO Memberships (user_id,org_id,role) VALUES (?,?,?) ON CONFLICT DO NOTHING', [existing.id, user.org_id, role]);
    });
    return res.status(201).json({ id: existing.id, name: name || existing.name, email, role, restored: true });
  }
  if (existing) {
    if (await memberOf(user.org_id, existing.id)) return res.status(400).json({ error: `${email} is already in this workspace.` });
    await db.run('INSERT INTO Memberships (user_id,org_id,role) VALUES (?,?,?)', [existing.id, user.org_id, role]);
    return res.status(201).json({ id: existing.id, name: existing.name, email, role, added_existing: true });
  }
  if (!name) return res.status(400).json({ error: 'Add a name.' });
  const bad = passwordProblem(req.body.password);
  if (bad) return res.status(400).json({ error: `${bad} Set a starting password to give them.` });
  const id = uid('user'), hash = await hashPassword(req.body.password);
  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO Users (id,name,email,role,org_id,company_id,password_hash) VALUES (?,?,?,?,?,?,?)', [id, name, email, role, user.org_id, user.company_id, hash]);
    await tx.run('INSERT INTO Memberships (user_id,org_id,role) VALUES (?,?,?)', [id, user.org_id, role]);
  });
  res.status(201).json({ id, name, email, role });
}));

// The company owner deletes someone: removed from every workspace, signed out, and
// unable to sign in. Their row stays so past claims and the audit log keep their name.
app.delete('/api/users/:id', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!user.is_owner) return res.status(403).json({ error: 'Only the company owner can delete people.' });
  const target = await db.get('SELECT id, name, is_owner, company_id FROM Users WHERE id=? AND deleted_at IS NULL', [req.params.id]);
  if (!target || target.company_id !== user.company_id) return res.status(404).json({ error: 'Person not found.' });
  if (target.id === user.id || target.is_owner) return res.status(400).json({ error: 'The company owner can\'t be deleted.' });
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM Memberships WHERE user_id=?', [target.id]);
    await tx.run('DELETE FROM Sessions WHERE user_id=?', [target.id]);
    await tx.run('UPDATE Users SET deleted_at=now() WHERE id=?', [target.id]);
  });
  res.json({ deleted: target.id, name: target.name });
}));

// Demo Company only: its owner can wipe every claim in its workspaces (with their
// receipts and audit history) before a demo. Accounts, workspaces, policies and
// pre-approvals stay; pre-approvals used by the deleted claims become unused again.
// Real companies can't do this, so their records can't be wiped by accident.
app.post('/api/demo/reset-claims', h(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  if (user.company_id !== DEMO_COMPANY || !user.is_owner) return res.status(403).json({ error: 'Only the Demo Company owner can reset demo claims.' });
  const counts = await db.transaction(async (tx) => {
    const inDemo = `SELECT id FROM Workspaces WHERE company_id='${DEMO_COMPANY}'`;
    const claims = `SELECT id FROM Expenses WHERE org_id IN (${inDemo})`;
    await tx.run(`UPDATE PreApprovals SET used_by_expense_id=NULL WHERE used_by_expense_id IN (${claims})`);
    const audit = await tx.query(`DELETE FROM AuditLog WHERE expense_id IN (${claims})`);
    // Receipts saved before sign-in existed have no org_id; find those through the claim's link.
    const receipts = await tx.query(`DELETE FROM Receipts WHERE org_id IN (${inDemo})
      OR id IN (SELECT substring(receipt_url FROM '^/api/receipts/(.+)$') FROM Expenses WHERE org_id IN (${inDemo}) AND receipt_url LIKE '/api/receipts/%')`);
    const expenses = await tx.query(`DELETE FROM Expenses WHERE org_id IN (${inDemo})`);
    return { expenses: expenses.rowCount, receipts: receipts.rowCount, audit_entries: audit.rowCount };
  });
  res.json(counts);
}));

// Placeholder end date until billing exists: cancelling only records the request.
const SUBSCRIPTION_END = '2026-11-05';

app.post('/api/company/subscription/:action', h(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  if (!user.is_owner) return res.status(403).json({ error: 'Only the company owner can manage the subscription.' });
  if (req.params.action === 'cancel') {
    await db.run('UPDATE Companies SET subscription_cancelled_at=COALESCE(subscription_cancelled_at, now()), subscription_ends_on=? WHERE id=?', [SUBSCRIPTION_END, user.company_id]);
  } else if (req.params.action === 'resume') {
    await db.run('UPDATE Companies SET subscription_cancelled_at=NULL, subscription_ends_on=NULL WHERE id=?', [user.company_id]);
  } else {
    return res.status(404).json({ error: 'Unknown action.' });
  }
  res.json(sessionInfo(await currentUser(req)));
}));

// Finance resets the password of someone in their workspace (there is no email reset).
// Only the owner can reset an owner's password.
app.put('/api/users/:id/password', h(async (req, res) => {
  const user = await requireUser(req, res, 'finance');
  if (!user) return;
  const target = await db.get('SELECT id, is_owner, company_id FROM Users WHERE id=? AND deleted_at IS NULL', [req.params.id]);
  const inWorkspace = target && (await memberOf(user.org_id, target.id));
  if (!target || target.company_id !== user.company_id || (!inWorkspace && !user.is_owner)) return res.status(404).json({ error: 'Person not found in this workspace.' });
  if (target.is_owner && target.id !== user.id && !user.is_owner) return res.status(403).json({ error: 'Only the company owner can reset the owner\'s password.' });
  const bad = passwordProblem(req.body.password);
  if (bad) return res.status(400).json({ error: bad });
  await db.run('UPDATE Users SET password_hash=? WHERE id=?', [await hashPassword(req.body.password), target.id]);
  if (target.id !== user.id) await db.run('DELETE FROM Sessions WHERE user_id=?', [target.id]);
  res.json({ ok: true });
}));

const publicRule = ({ id, section, title, body, rule_type, params, enabled, source, source_text, updated_at, updated_by }) =>
  ({ id, section, title, body, rule_type, params, enabled, source, source_text, updated_at, updated_by });

app.get('/api/policy', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  res.json((await loadPolicy(db, user.org_id)).map(publicRule));
}));

app.get('/api/policy/presets', (_req, res) => res.json(PRESETS.map(({ item, title, keywords }) => ({ item, title, keywords }))));

// Inserts a validated rule, or updates `into` (an existing rule with the same scope).
async function saveRule(tx, rule, { user, source, source_text = null, section = null, into = null }) {
  const body = renderBody(rule.body_template, rule.params);
  if (into) {
    await tx.run(`UPDATE KnowledgeBase SET title=?, body=?, params=?, body_template=?, enabled=true, source=?, source_text=COALESCE(?, source_text),
      updated_at=?, updated_by=? WHERE id=?`,
    [rule.title, body, JSON.stringify(rule.params), rule.body_template, source, source_text, now(), user.id, into.id]);
    return into.section;
  }
  const taken = (await tx.all('SELECT section FROM KnowledgeBase WHERE org_id=?', [user.org_id])).map(r => r.section);
  const wanted = String(section || '').trim();
  if (wanted && !/^\d{1,3}(\.\d{1,3}){0,3}$/.test(wanted)) throw Object.assign(new Error('Section must look like 5.1'), { status: 400 });
  const sec = wanted && !taken.includes(wanted) ? wanted : nextSection(taken);
  await tx.run(`INSERT INTO KnowledgeBase (id,org_id,title,section,body,updated_at,rule_type,params,body_template,updated_by,enabled,source,source_text)
    VALUES (?,?,?,?,?,?,?,?,?,?,true,?,?)`,
  [uid('policy'), user.org_id, rule.title, sec, body, now(), rule.rule_type, JSON.stringify(rule.params), rule.body_template, user.id, source, source_text]);
  return sec;
}

// Finance adds one rule (from the form) or switches on a preset banned item.
app.post('/api/policy', h(async (req, res) => {
  const user = await requireUser(req, res, 'finance');
  if (!user) return;
  const input = req.body.preset
    ? { rule_type: 'prohibited_item', item: req.body.preset }
    : req.body.rule;
  if (req.body.preset && !PRESETS.some(p => p.item === req.body.preset)) return res.status(400).json({ error: 'Unknown preset.' });
  const rule = validateRule(input);
  const section = await db.transaction(async (tx) => {
    await lockPolicy(tx, user);
    const match = findMatch(rule, await loadPolicy(tx, user.org_id));
    if (match && !req.body.preset) {
      throw Object.assign(new Error(`Section ${match.section} (${match.title}) already covers this. Change it there instead.`), { status: 400 });
    }
    return saveRule(tx, rule, { user, source: 'manual', section: req.body.section, into: match });
  });
  res.status(201).json(publicRule((await loadPolicy(db, user.org_id)).find(r => r.section === section)));
}));

// Finance changes a rule's amount (cap limit / pre-approval threshold) or switches it on/off.
app.put('/api/policy/:section', h(async (req, res) => {
  const user = await requireUser(req, res, 'finance');
  if (!user) return;
  const rule = (await loadPolicy(db, user.org_id)).find(r => r.section === req.params.section);
  if (!rule) return res.status(404).json({ error: 'Policy section not found.' });
  let params = rule.params;
  if (req.body.value !== undefined) {
    const key = { cap: 'limit', preapproval_required: 'threshold', receipt_age: 'max_days' }[rule.rule_type];
    if (!key) return res.status(400).json({ error: `Section ${rule.section} has no editable amount.` });
    const value = key === 'max_days' ? Math.round(Number(req.body.value)) : Math.round(Number(req.body.value) * 100) / 100;
    const [min, max] = key === 'max_days' ? [1, 3650] : [key === 'threshold' ? 0 : 0.01, 1e6];
    if (!Number.isFinite(value) || value < min || value > max) {
      return res.status(400).json({ error: key === 'max_days' ? 'Enter a number of days between 1 and 3650.' : 'Enter a positive amount.' });
    }
    params = { ...rule.params, [key]: value };
  }
  let template = rule.body_template;
  if (req.body.allow_preapproval !== undefined) {
    if (rule.rule_type !== 'prohibited_item') return res.status(400).json({ error: 'Only banned-item rules can allow a pre-approval exception.' });
    // Rebuild from the rule so the citation text matches the new setting.
    const rebuilt = validateRule({ ...rule, params: { ...params, allow_preapproval: Boolean(req.body.allow_preapproval) }, title: rule.title });
    params = rebuilt.params;
    template = rebuilt.body_template;
  }
  const enabled = req.body.enabled === undefined ? rule.enabled : Boolean(req.body.enabled);
  await db.run('UPDATE KnowledgeBase SET params=?, body=?, body_template=?, enabled=?, updated_at=?, updated_by=? WHERE id=?',
    [JSON.stringify(params), renderBody(template, params), template, enabled, now(), user.id, rule.id]);
  res.json(publicRule((await loadPolicy(db, user.org_id)).find(r => r.section === rule.section)));
}));

app.delete('/api/policy/:section', h(async (req, res) => {
  const user = await requireUser(req, res, 'finance');
  if (!user) return;
  const rule = (await loadPolicy(db, user.org_id)).find(r => r.section === req.params.section);
  if (!rule) return res.status(404).json({ error: 'Policy section not found.' });
  // Past decisions keep their own copy of the cited text, so deleting a rule doesn't change history.
  await db.run('DELETE FROM KnowledgeBase WHERE id=?', [rule.id]);
  res.json({ deleted: rule.section });
}));

// Saves a copy of the whole policy so the next import / clear can be undone.
async function snapshotPolicy(tx, user, reason) {
  const id = uid('snap');
  const rows = await tx.all(`SELECT id,title,section,body,updated_at,rule_type,params,body_template,updated_by,enabled,source,source_text
    FROM KnowledgeBase WHERE org_id=? ORDER BY section`, [user.org_id]);
  await tx.run('INSERT INTO PolicySnapshots (id,org_id,reason,rules,created_by) VALUES (?,?,?,?,?)', [id, user.org_id, reason, JSON.stringify(rows), user.id]);
  return id;
}
const lockPolicy = (tx, user) => tx.query('SELECT pg_advisory_xact_lock(hashtext(?))', [`policy-${user.org_id}`]);

// Policy PDF upload: reads the PDF, then updates matching rules and adds new
// ones in one transaction. Rules the PDF doesn't mention are left as they are.
app.post('/api/policy/import', upload.single('policy'), h(async (req, res) => {
  const user = await requireUser(req, res, 'finance');
  if (!user) return;
  const file = req.file;
  if (file && file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Upload the policy as a PDF.' });
  if (!file && !String(req.body.text || '').trim()) return res.status(400).json({ error: 'Choose a policy PDF.' });
  let text = req.body.text || '';
  if (file) {
    try { text = await pdfText(file); } catch (e) { text = ''; }
  }
  const filename = String(file?.originalname || req.body.filename || 'policy.pdf').slice(0, 120);
  const fx = Object.fromEntries((await db.all('SELECT currency, rate_to_usd FROM FxRates')).map(r => [r.currency, r.rate_to_usd / baseRate]));
  // Reading (possibly a Claude call) happens outside the transaction; matching is redone inside it.
  const read = await previewPolicy({ pdfBuffer: file?.buffer, text, existing: await loadPolicy(db, user.org_id), fx });
  if (!read.rules.length) {
    return res.status(400).json({ error: 'No enforceable rules were found in this PDF. Add them with "Add rule" instead.', unmatched: read.unmatched });
  }
  const result = await db.transaction(async (tx) => {
    await lockPolicy(tx, user);
    const snapshot_id = await snapshotPolicy(tx, user, `Before importing ${filename}`);
    const rules = [];
    for (const r of read.rules) {
      const rule = validateRule(r);
      const into = findMatch(rule, await loadPolicy(tx, user.org_id)) || null;
      const change = describeChange({ ...rule, keywords_from_source: r.keywords_from_source }, into);
      if (change.action === 'unchanged') { rules.push({ ...r, ...change }); continue; }
      const section = await saveRule(tx, rule, { user, source: `pdf:${filename}`, source_text: r.source_text || null, section: r.source_section, into });
      rules.push({ ...r, ...change, section });
    }
    return { snapshot_id, rules };
  });
  const count = (a) => result.rules.filter(r => r.action === a).map(r => r.section);
  res.json({
    filename, method: read.method, notes: read.notes, unmatched: read.unmatched, snapshot_id: result.snapshot_id,
    rules: result.rules, added: count('new'), updated: count('update'), unchanged: count('unchanged')
  });
}));

// "Clear all": removes every rule (after a snapshot, so it can be undone).
app.delete('/api/policy', h(async (req, res) => {
  const user = await requireUser(req, res, 'finance');
  if (!user) return;
  const out = await db.transaction(async (tx) => {
    await lockPolicy(tx, user);
    const snapshot_id = await snapshotPolicy(tx, user, 'Before clearing all rules');
    const { rowCount } = await tx.query('DELETE FROM KnowledgeBase WHERE org_id=?', [user.org_id]);
    return { snapshot_id, cleared: rowCount };
  });
  res.json(out);
}));

// Undo: puts the policy back exactly as it was in a snapshot.
app.post('/api/policy/restore', h(async (req, res) => {
  const user = await requireUser(req, res, 'finance');
  if (!user) return;
  const snap = await db.get('SELECT * FROM PolicySnapshots WHERE id=? AND org_id=?', [String(req.body.snapshot_id || ''), user.org_id]);
  if (!snap) return res.status(404).json({ error: 'Nothing to undo.' });
  await db.transaction(async (tx) => {
    await lockPolicy(tx, user);
    await tx.run('DELETE FROM KnowledgeBase WHERE org_id=?', [user.org_id]);
    for (const r of snap.rules) {
      await tx.run(`INSERT INTO KnowledgeBase (id,org_id,title,section,body,updated_at,rule_type,params,body_template,updated_by,enabled,source,source_text)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [r.id, user.org_id, r.title, r.section, r.body, r.updated_at, r.rule_type, JSON.stringify(r.params), r.body_template, r.updated_by, r.enabled, r.source, r.source_text]);
    }
  });
  res.json({ restored: snap.rules.length, reason: snap.reason });
}));

app.get('/api/expenses', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const rows = user.role === 'finance'
    ? await db.all(`SELECT e.*,u.name AS employee_name FROM Expenses e JOIN Users u ON u.id=e.employee_id WHERE e.org_id=? ORDER BY e.created_at DESC`, [user.org_id])
    : await db.all(`SELECT e.*,u.name AS employee_name FROM Expenses e JOIN Users u ON u.id=e.employee_id WHERE e.org_id=? AND e.employee_id=? ORDER BY e.created_at DESC`, [user.org_id, user.id]);
  res.json(rows.map(parseRow));
}));

app.get('/api/expenses/:id/logs', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const exp = await db.get('SELECT employee_id, org_id FROM Expenses WHERE id=?', [req.params.id]);
  if (!exp || exp.org_id !== user.org_id || (user.role !== 'finance' && exp.employee_id !== user.id)) {
    return res.status(404).json({ error: 'Expense not found.' });
  }
  res.json(await db.all('SELECT * FROM AuditLog WHERE expense_id=? ORDER BY "timestamp" ASC, seq ASC', [req.params.id]));
}));

app.get('/api/dashboard', h(async (req, res) => {
  const user = await requireUser(req, res, 'finance');
  if (!user) return;
  // All money on the dashboard is reported in the home currency, using the rate stored on each claim.
  const totals = await db.get(`SELECT
      COALESCE(SUM(claimed_amount*fx_rate_to_usd),0)/? AS claimed,
      COALESCE(SUM(approved_amount*fx_rate_to_usd),0)/? AS paid,
      COALESCE(SUM(CASE WHEN status='Capped' THEN (claimed_amount-approved_amount)*fx_rate_to_usd ELSE 0 END),0)/? AS saved_caps,
      COALESCE(SUM(CASE WHEN status='Rejected' THEN claimed_amount*fx_rate_to_usd ELSE 0 END),0)/? AS saved_rejections,
      COUNT(*) AS count
    FROM Expenses WHERE org_id=? AND status!='Processing'`, [baseRate, baseRate, baseRate, baseRate, user.org_id]);
  totals.saved = totals.saved_caps + totals.saved_rejections;
  const byCategory = await db.all(`SELECT category, COUNT(*) AS count,
      COALESCE(SUM(claimed_amount*fx_rate_to_usd),0)/? AS claimed, COALESCE(SUM(approved_amount*fx_rate_to_usd),0)/? AS paid
    FROM Expenses WHERE org_id=? AND status!='Processing' GROUP BY category ORDER BY claimed DESC`, [baseRate, baseRate, user.org_id]);
  const byStatus = await db.all(`SELECT status, COUNT(*) AS count, COALESCE(SUM(claimed_amount*fx_rate_to_usd),0)/? AS claimed
    FROM Expenses WHERE org_id=? AND status!='Processing' GROUP BY status`, [baseRate, user.org_id]);
  const logs = await db.all(`SELECT a.*, e.vendor, e.claimed_amount, e.currency, u.name AS employee_name
    FROM AuditLog a JOIN Expenses e ON e.id=a.expense_id LEFT JOIN Users u ON u.id=e.employee_id
    WHERE e.org_id=? ORDER BY a."timestamp" DESC, a.seq DESC LIMIT 15`, [user.org_id]);
  const team = await db.all(`SELECT role, COUNT(*) AS n FROM Memberships WHERE org_id=? GROUP BY role`, [user.org_id]);
  res.json({ totals, byCategory, byStatus, team, logs });
}));

app.get('/api/preapprovals', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const base = `SELECT p.*, u.name AS employee_name FROM PreApprovals p JOIN Users u ON u.id=p.employee_id WHERE p.org_id=?`;
  const rows = user.role === 'finance'
    ? await db.all(`${base} ORDER BY p.created_at DESC`, [user.org_id])
    : await db.all(`${base} AND p.employee_id=? ORDER BY p.created_at DESC`, [user.org_id, user.id]);
  res.json(rows);
}));

app.post('/api/preapprovals', h(async (req, res) => {
  const user = await requireUser(req, res, 'finance');
  if (!user) return;
  const { employee_id, expense_type, description, max_amount, currency = BASE_CURRENCY } = req.body;
  // Banned items this pre-approval also allows (only rules that accept a pre-approval exception).
  const banned = (await loadPolicy(db, user.org_id)).filter(r => r.rule_type === 'prohibited_item' && r.params.allow_preapproval).map(r => r.params.item);
  const allows = (Array.isArray(req.body.allows) ? req.body.allows : []).map(String);
  const unknown = allows.filter(a => !banned.includes(a));
  if (unknown.length) return res.status(400).json({ error: `No banned-item rule allows a pre-approval for: ${unknown.join(', ')}.` });
  const emp = await memberOf(user.org_id, employee_id);
  if (!emp || emp.role !== 'employee') return res.status(400).json({ error: 'Choose an employee from this workspace.' });
  if (!EXPENSE_TYPES.includes(expense_type)) return res.status(400).json({ error: 'Choose an expense type.' });
  if (!String(description || '').trim()) return res.status(400).json({ error: 'Add a short description.' });
  const amount = Math.round(Number(max_amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Maximum amount must be a positive number.' });
  if (!CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Unsupported currency.' });
  const id = uid('pa');
  await db.run(`INSERT INTO PreApprovals (id,org_id,employee_id,expense_type,description,max_amount,currency,approved_by,created_at,allows)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, user.org_id, emp.id, expense_type, String(description).trim().slice(0, 200), amount, currency, user.id, now(), JSON.stringify([...new Set(allows)])]);
  res.status(201).json(await db.get('SELECT * FROM PreApprovals WHERE id=?', [id]));
}));

app.post('/api/expenses/text', h(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Paste the receipt email or text first.' });
  return handleClaim(req, res, { text });
}));

app.post('/api/expenses/upload', upload.single('receipt'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a receipt image or PDF.' });
  return handleClaim(req, res, { file: req.file });
}));

if (PRODUCTION) {
  const dist = path.join(__dirname, '..', 'dist');
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Error handler last so it also catches multer errors (file type / size) and database errors.
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: `Receipt is larger than ${MAX_UPLOAD_MB} MB.` });
  if (err.name === 'MulterError' || err.status === 400) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: `Server error: ${err.message || 'request failed'}` });
});

if (require.main === module) {
  ready().then(() => {
    app.listen(PORT, () => console.log(`GhostAudit API on http://localhost:${PORT} (database: Supabase, extractor: ${claudeEnabled() ? 'Claude' : 'OCR + rules'})`));
  }, (e) => {
    console.error(`Could not connect to the database: ${e.message}`);
    process.exit(1);
  });
}
module.exports = { app, ready };
