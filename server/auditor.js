// Auditor Agent
// Deterministic policy engine. Every rule, limit and citation comes from the
// KnowledgeBase table, so editing a limit there changes enforcement and the
// cited text together. The LLM never decides; it only extracts.

const { now, uid } = require('./db');
const { BASE_CURRENCY } = require('./currency');

const round2 = (n) => Math.round(n * 100) / 100;
// Amounts in the home currency show as "$75.00"; others as "USD 75.00".
const fmtBase = (n) => `$${Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtMoney = (n, cur) => cur === BASE_CURRENCY ? fmtBase(n) : `${cur} ${Number(n).toFixed(2)}`;

function normaliseVendor(s) {
  return String(s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(the|inc|llc|ltd|pty|co|corp|corporation|limited)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function loadPolicy(db, orgId) {
  if (!orgId) throw new Error('loadPolicy needs a workspace id');
  return (await db.all('SELECT * FROM KnowledgeBase WHERE org_id=? ORDER BY section', [orgId]))
    .map(r => ({ ...r, params: r.params || {} }));
}

async function fxRate(db, currency) {
  const row = await db.get('SELECT rate_to_usd FROM FxRates WHERE currency=?', [currency]);
  if (!row) throw new Error(`Unsupported currency ${currency}. Supported: USD, AUD, EUR, GBP, CAD.`);
  return row.rate_to_usd;
}

function cite(rule) {
  return `Section ${rule.section}: ${rule.body}`;
}

function keywordHits(keywords, texts) {
  const hits = new Set();
  for (const kw of keywords) {
    const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i');
    for (const t of texts) if (re.test(t)) hits.add(kw);
  }
  return [...hits];
}

// Unused pre-approvals finance recorded for this employee and expense type, oldest first.
function openPreapprovals(db, claim) {
  return db.all(`SELECT p.*, f.rate_to_usd FROM PreApprovals p JOIN FxRates f ON f.currency=p.currency
    WHERE p.org_id=? AND p.employee_id=? AND p.expense_type=? AND p.used_by_expense_id IS NULL ORDER BY p.created_at`,
  [claim.org_id, claim.employee_id, claim.expense_type]);
}

/* Each checker returns { section, outcome: 'pass'|'violation'|'cap'|'n/a', detail, ... } */
const CHECKERS = {
  async duplicate(db, rule, claim) {
    const candidates = await db.all(`SELECT id, vendor, created_at FROM Expenses
      WHERE org_id=? AND employee_id=? AND "date"=? AND round(claimed_amount::numeric,2)=round(?::numeric,2) AND status!='Processing' AND id!=?`,
    [claim.org_id, claim.employee_id, claim.date, claim.amount, claim.id]);
    const target = normaliseVendor(claim.vendor);
    const match = candidates.find(c => normaliseVendor(c.vendor) === target);
    return match
      ? { outcome: 'violation', detail: `Duplicate of claim ${match.id} submitted ${match.created_at.slice(0, 10)} (same employee, vendor, amount and date).`, duplicate_of: match.id }
      : { outcome: 'pass', detail: 'No earlier claim with the same employee, vendor, amount and date.' };
  },

  async prohibited_item(db, rule, claim) {
    const { item, expense_types: types, allow_preapproval } = rule.params;
    if (types?.length && !types.includes(claim.expense_type)) return { outcome: 'n/a', detail: `Not a ${types.join('/')} expense.` };
    const texts = [claim.raw_text, claim.vendor, ...claim.line_items.map(i => i.description)];
    const hits = keywordHits(rule.params.keywords || [], texts);
    // Claude flags alcohol specifically, so its list only counts for the alcohol rule.
    const llmHits = item === 'alcohol' ? (claim.alcohol_items || []) : [];
    if (!hits.length && !llmHits.length) return { outcome: 'pass', detail: `No ${item || 'prohibited items'} detected.` };
    const found = `${item || 'Prohibited item'} found on receipt: ${[...new Set([...llmHits, ...hits])].slice(0, 6).join(', ')}.`;
    if (!allow_preapproval) return { outcome: 'violation', detail: found };
    // "Unless pre-approved": an unused pre-approval for this expense type that covers the
    // amount and lists this item under "also allows".
    const pa = (await openPreapprovals(db, claim)).find(a => (a.allows || []).includes(item) && a.max_amount * a.rate_to_usd / claim.base_rate + 0.005 >= claim.amount_base);
    return pa
      ? { outcome: 'pass', detail: `${found} Allowed by pre-approval ${pa.id} ("${pa.description}", up to ${fmtMoney(pa.max_amount, pa.currency)}).`, preapproval_id: pa.id }
      : { outcome: 'violation', detail: `${found} No unused ${claim.expense_type} pre-approval that allows ${item} covers this claim.` };
  },

  async preapproval_required(db, rule, claim) {
    const types = rule.params.expense_types || [];
    if (!types.includes(claim.expense_type)) return { outcome: 'n/a', detail: `Not a ${types.join('/')} expense.` };
    if (claim.amount_base <= rule.params.threshold) {
      return { outcome: 'pass', detail: `${fmtBase(claim.amount_base)} is within the ${fmtBase(rule.params.threshold)} threshold.` };
    }
    const approvals = await openPreapprovals(db, claim);
    const covers = (a) => a.max_amount * a.rate_to_usd / claim.base_rate + 0.005 >= claim.amount_base;
    const pa = approvals.find(a => a.id === claim.preapproval_in_use && covers(a)) || approvals.find(covers);
    if (pa) {
      return { outcome: 'pass', detail: `Covered by pre-approval ${pa.id} ("${pa.description}", up to ${fmtMoney(pa.max_amount, pa.currency)}).`, preapproval_id: pa.id };
    }
    const why = approvals.length ? 'existing pre-approvals are for a lower amount' : 'no unused pre-approval on record';
    return { outcome: 'violation', detail: `${fmtBase(claim.amount_base)} exceeds ${fmtBase(rule.params.threshold)} and ${why}.` };
  },

  receipt_age(_db, rule, claim) {
    const age = Math.floor((Date.now() - Date.parse(`${claim.date}T00:00:00Z`)) / 86400000);
    const max = rule.params.max_days;
    return age > max
      ? { outcome: 'violation', detail: `Receipt dated ${claim.date} is ${age} days old; receipts must be submitted within ${max} days.` }
      : { outcome: 'pass', detail: `Receipt is ${Math.max(0, age)} days old (limit ${max}).` };
  },

  cap(_db, rule, claim) {
    const p = rule.params;
    if (p.category && p.category !== claim.category) return { outcome: 'n/a', detail: `Not a ${p.category} expense.` };
    if (p.expense_types && !p.expense_types.includes(claim.expense_type)) return { outcome: 'n/a', detail: `Not a ${p.expense_types.join('/')} expense.` };
    const units = p.per === 'person' ? claim.attendees : 1;
    const capBase = p.limit * units;
    const capLocal = claim.currency === BASE_CURRENCY ? round2(capBase) : round2(capBase * claim.base_rate / claim.fx_rate);
    if (claim.amount > capLocal + 0.004) {
      const per = p.per === 'person' ? ` (${fmtBase(p.limit)} x ${units} ${units === 1 ? 'person' : 'people'})` : '';
      return { outcome: 'cap', cap_amount: capLocal, detail: `Claim ${fmtMoney(claim.amount, claim.currency)} exceeds cap of ${fmtMoney(capLocal, claim.currency)}${per}.` };
    }
    return { outcome: 'pass', detail: `Within cap of ${fmtMoney(capLocal, claim.currency)}.` };
  }
};

/**
 * Validates the extracted fields, then records and decides the claim in one
 * transaction. Returns the saved expense row.
 */
async function auditAndRecord(db, { user, fields, method, notes = [], corrections = {}, receiptUrl = null }) {
  if (!fields.amount) throw new Error('Could not find the total on this receipt. Open "Review / correct extracted fields" and enter the total amount.');
  if (!fields.date) throw new Error('Could not find the receipt date. Open "Review / correct extracted fields" and enter the date.');
  if (fields.date > new Date(Date.now() + 86400000).toISOString().slice(0, 10)) throw new Error('Receipt date is in the future. Check the date field.');

  // Rates are stored against USD; limits are in the home currency.
  const rate = await fxRate(db, fields.currency);
  const baseRate = await fxRate(db, BASE_CURRENCY);
  const claim = {
    ...fields,
    id: uid('exp'),
    org_id: user.org_id,
    employee_id: user.id,
    fx_rate: rate,
    base_rate: baseRate,
    amount_base: fields.currency === BASE_CURRENCY ? fields.amount : round2(fields.amount * rate / baseRate)
  };
  const allRules = await loadPolicy(db, user.org_id);
  const policy = allRules.filter(r => r.enabled);
  const disabled = allRules.filter(r => !r.enabled).map(r => r.section);

  const id = await db.transaction(async (tx) => {
    // One claim per employee at a time, so two identical receipts submitted
    // together can't both pass the duplicate check or share a pre-approval.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext(?))', [claim.employee_id]);
    await tx.run(`INSERT INTO Expenses (id,org_id,employee_id,vendor,"date",claimed_amount,approved_amount,currency,category,line_items,
        status,decision_reason,policy_citation,receipt_url,created_at,attendees,expense_type,fx_rate_to_usd,extraction_method)
      VALUES (?,?,?,?,?,?,0,?,?,?,'Processing','','',?,?,?,?,?,?)`,
    [claim.id, claim.org_id, claim.employee_id, claim.vendor, claim.date, claim.amount, claim.currency, claim.category,
      JSON.stringify(claim.line_items), receiptUrl, now(), claim.attendees, claim.expense_type, rate, method]);

    const log = (actor, action, details) => tx.run('INSERT INTO AuditLog (id,expense_id,actor,action,details,"timestamp") VALUES (?,?,?,?,?,?)',
      [uid('log'), claim.id, actor, action, JSON.stringify(details), now()]);

    await log('Extractor Agent', 'receipt_extracted', {
      method, vendor: claim.vendor, date: claim.date, claimed_amount: claim.amount, currency: claim.currency,
      category: claim.category, expense_type: claim.expense_type, attendees: claim.attendees,
      line_items: claim.line_items.length, alcohol_flagged_by_model: claim.alcohol_items.length, notes
    });
    if (Object.keys(corrections).length) await log(user.id, 'fields_corrected_by_employee', corrections);

    // Evaluate every rule so the audit trail shows the full picture. Banned-item rules go
    // first so a pre-approval they accept is the one a threshold rule reuses: one claim
    // uses up at most one pre-approval where possible.
    const byType = (r) => (r.rule_type === 'prohibited_item' ? 0 : 1);
    const results = new Map();
    for (const rule of [...policy].sort((a, b) => byType(a) - byType(b))) {
      const fn = CHECKERS[rule.rule_type];
      const r = fn ? await fn(tx, rule, claim) : { outcome: 'n/a', detail: `Unknown rule type ${rule.rule_type}` };
      if (r.preapproval_id && !claim.preapproval_in_use) claim.preapproval_in_use = r.preapproval_id;
      results.set(rule, r);
    }
    const checks = policy.map(rule => ({ section: rule.section, title: rule.title, rule, ...results.get(rule) }));
    await log('Auditor Agent', 'policy_evaluated', {
      policy_sections: policy.map(p => p.section),
      ...(disabled.length ? { disabled_sections: disabled } : {}),
      amount_base: claim.amount_base, base_currency: BASE_CURRENCY,
      checks: checks.map(c => ({ section: c.section, outcome: c.outcome, detail: c.detail }))
    });

    const violations = checks.filter(c => c.outcome === 'violation');
    const caps = checks.filter(c => c.outcome === 'cap');
    let status, approved, reason, citation;
    if (violations.length) {
      status = 'Rejected';
      approved = 0;
      reason = `Rejected. ${violations.map(v => v.detail).join(' ')} Breaking any policy rule rejects the whole claim.`;
      citation = violations.map(v => cite(v.rule)).join(' | ');
    } else if (caps.length) {
      const tightest = caps.reduce((a, b) => (b.cap_amount < a.cap_amount ? b : a));
      status = 'Capped';
      approved = tightest.cap_amount;
      reason = `Capped. ${tightest.detail} Approved ${fmtMoney(approved, claim.currency)}; ${fmtMoney(round2(claim.amount - approved), claim.currency)} is not reimbursable.`;
      citation = cite(tightest.rule);
    } else {
      status = 'Approved';
      approved = claim.amount;
      reason = `Approved in full. All ${checks.length} policy rules passed.`;
      const applicable = checks.filter(c => c.outcome === 'pass').map(c => c.section).join(', ');
      citation = applicable ? `Checked against Sections ${applicable}; no rule triggered.` : 'No enabled policy rule applies to this claim.';
      const paChecks = checks.filter(c => c.preapproval_id);
      if (paChecks.length) {
        reason = `Approved in full. ${paChecks.map(c => c.detail).join(' ')}`;
        citation = paChecks.map(c => cite(c.rule)).join(' | ');
      }
    }

    // A pre-approval is consumed only when the claim actually gets paid.
    if (status !== 'Rejected') {
      for (const paId of new Set(checks.map(c => c.preapproval_id).filter(Boolean))) {
        await tx.run('UPDATE PreApprovals SET used_by_expense_id=? WHERE id=?', [claim.id, paId]);
        await log('Auditor Agent', 'preapproval_consumed', { preapproval_id: paId });
      }
    }

    await tx.run('UPDATE Expenses SET approved_amount=?,status=?,decision_reason=?,policy_citation=? WHERE id=?',
      [round2(approved), status, reason, citation, claim.id]);
    await log('Auditor Agent', 'decision_finalised', {
      status, claimed_amount: claim.amount, approved_amount: round2(approved), currency: claim.currency, reason, policy_citation: citation
    });
    return claim.id;
  });

  return db.get('SELECT e.*, u.name AS employee_name FROM Expenses e JOIN Users u ON u.id=e.employee_id WHERE e.id=?', [id]);
}

module.exports = { auditAndRecord, loadPolicy, normaliseVendor };
