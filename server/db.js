const { Pool, types } = require('pg');
const crypto = require('crypto');

const ORG = 'org_demo';
const now = () => new Date().toISOString();
const uid = (prefix) => `${prefix}_${crypto.randomUUID()}`;

// Return values in the same shapes the app used with SQLite:
// counts as numbers, dates as 'YYYY-MM-DD', timestamps as ISO strings.
types.setTypeParser(20, (v) => parseInt(v, 10));
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1184, (v) => new Date(v).toISOString());

// Policy rules live in the Knowledge Base. `params` is what the Auditor Agent
// actually evaluates; `body` is rendered from `body_template` so the citation
// text always matches the enforced numbers, even after finance edits a limit.
const POLICY_SEED = [
  {
    section: '2.1', title: 'Meals', rule_type: 'cap',
    params: { category: 'Meals', per: 'person', limit: 75 },
    body_template: 'Meals are capped at ${limit} per person. Amounts above the cap are not reimbursed.'
  },
  {
    section: '2.2', title: 'Taxis and rideshare', rule_type: 'cap',
    params: { category: 'Travel', expense_types: ['taxi', 'rideshare'], per: 'trip', limit: 80 },
    body_template: 'Taxis and rideshare are capped at ${limit} per trip. Amounts above the cap are not reimbursed.'
  },
  {
    section: '3.1', title: 'Alcohol', rule_type: 'prohibited_item',
    params: {
      item: 'alcohol',
      keywords: ['alcohol', 'alcoholic', 'beer', 'wine', 'vodka', 'whisky', 'whiskey', 'gin', 'rum', 'tequila', 'cocktail',
        'liquor', 'spirits', 'champagne', 'prosecco', 'cider', 'lager', 'ipa', 'pale ale', 'stout', 'pinot', 'merlot',
        'shiraz', 'chardonnay', 'sauvignon', 'cabernet', 'riesling', 'rose wine', 'bourbon', 'brandy', 'negroni',
        'spritz', 'mojito', 'sangria', 'soju', 'mezcal']
    },
    body_template: 'Alcohol is not reimbursable. Any claim containing alcohol is rejected in full.'
  },
  {
    section: '3.2', title: 'Flights', rule_type: 'preapproval_required',
    params: { expense_types: ['flight'], threshold: 1000 },
    body_template: 'Flights costing more than ${threshold} require a finance pre-approval recorded before submission.'
  },
  {
    section: '4.1', title: 'Duplicate receipts', rule_type: 'duplicate',
    params: { match_on: ['employee', 'vendor', 'amount', 'date'] },
    body_template: 'Duplicate receipts are rejected. A duplicate has the same employee, vendor, amount and date as an existing expense.'
  }
];

// Static demo rates, stored against USD. Caps are in the home currency (currency.js); claims in other currencies are
// converted with these rates. Replace with a live FX feed for production.
const FX_SEED = { USD: 1, AUD: 0.66, EUR: 1.08, GBP: 1.27, CAD: 0.73 };

function renderBody(template, params) {
  const fmt = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  // Amounts render as money; counts like max_days render as plain numbers.
  return template.replace(/\$\{(\w+)\}/g, (_m, key) => (key.endsWith('_days') ? String(params[key]) : fmt(params[key])));
}

// Tables live in their own schema so they don't collide with anything else in
// the Supabase project, and aren't exposed through Supabase's public REST API.
const SCHEMA_SQL = `
  -- A workspace is one company. Every other table carries the workspace id as org_id.
  CREATE TABLE IF NOT EXISTS Workspaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS Users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('employee','finance')), org_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS Expenses (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, employee_id TEXT NOT NULL REFERENCES Users(id),
    vendor TEXT NOT NULL, "date" DATE NOT NULL, claimed_amount DOUBLE PRECISION NOT NULL,
    approved_amount DOUBLE PRECISION NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
    category TEXT NOT NULL, line_items JSONB NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK(status IN ('Processing','Approved','Capped','Rejected')),
    decision_reason TEXT NOT NULL DEFAULT '', policy_citation TEXT NOT NULL DEFAULT '',
    receipt_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    attendees INTEGER NOT NULL DEFAULT 1, expense_type TEXT NOT NULL DEFAULT 'other',
    fx_rate_to_usd DOUBLE PRECISION NOT NULL DEFAULT 1, extraction_method TEXT NOT NULL DEFAULT 'rules'
  );
  CREATE TABLE IF NOT EXISTS AuditLog (
    seq BIGSERIAL, id TEXT PRIMARY KEY, expense_id TEXT NOT NULL REFERENCES Expenses(id),
    actor TEXT NOT NULL, action TEXT NOT NULL, details JSONB NOT NULL, "timestamp" TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS KnowledgeBase (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL,
    section TEXT NOT NULL, body TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
    rule_type TEXT, params JSONB, body_template TEXT, updated_by TEXT
  );
  CREATE TABLE IF NOT EXISTS PreApprovals (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, employee_id TEXT NOT NULL REFERENCES Users(id),
    expense_type TEXT NOT NULL, description TEXT NOT NULL,
    max_amount DOUBLE PRECISION NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
    approved_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
    used_by_expense_id TEXT REFERENCES Expenses(id)
  );
  CREATE TABLE IF NOT EXISTS FxRates (
    currency TEXT PRIMARY KEY, rate_to_usd DOUBLE PRECISION NOT NULL, updated_at TIMESTAMPTZ NOT NULL
  );
  -- Receipt files are kept in the database so the app needs no disk (serverless hosts have none).
  CREATE TABLE IF NOT EXISTS Receipts (
    id TEXT PRIMARY KEY, mimetype TEXT NOT NULL, data BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- One-off setup steps already done (so a rule finance deleted isn't re-seeded on restart).
  CREATE TABLE IF NOT EXISTS Meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- Copy of the whole policy taken before a PDF import or "clear all", so it can be undone.
  CREATE TABLE IF NOT EXISTS PolicySnapshots (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, reason TEXT NOT NULL, rules JSONB NOT NULL,
    created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- Banned items a pre-approval also allows, for rules like "alcohol, unless pre-approved".
  ALTER TABLE PreApprovals ADD COLUMN IF NOT EXISTS allows JSONB NOT NULL DEFAULT '[]';
  ALTER TABLE KnowledgeBase ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
  ALTER TABLE KnowledgeBase ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'seed';
  ALTER TABLE KnowledgeBase ADD COLUMN IF NOT EXISTS source_text TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_section ON KnowledgeBase(org_id, section);
  -- Sign-in. A company signs up and owns workspaces; people sign in with email +
  -- password and get a role per workspace (Memberships). Users.org_id/role stay
  -- as each person's home workspace and role.
  CREATE TABLE IF NOT EXISTS Companies (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE Workspaces ADD COLUMN IF NOT EXISTS company_id TEXT REFERENCES Companies(id);
  ALTER TABLE Users ADD COLUMN IF NOT EXISTS company_id TEXT REFERENCES Companies(id);
  ALTER TABLE Users ADD COLUMN IF NOT EXISTS password_hash TEXT;
  ALTER TABLE Users ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT false;
  CREATE TABLE IF NOT EXISTS Memberships (
    user_id TEXT NOT NULL REFERENCES Users(id), org_id TEXT NOT NULL REFERENCES Workspaces(id),
    role TEXT NOT NULL CHECK(role IN ('employee','finance')), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, org_id)
  );
  CREATE TABLE IF NOT EXISTS Sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES Users(id), active_org_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL
  );
  ALTER TABLE Receipts ADD COLUMN IF NOT EXISTS org_id TEXT;
  -- Deleted people keep their row so past claims and the audit log still show who made them.
  ALTER TABLE Users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  ALTER TABLE Companies ADD COLUMN IF NOT EXISTS subscription_cancelled_at TIMESTAMPTZ;
  ALTER TABLE Companies ADD COLUMN IF NOT EXISTS subscription_ends_on DATE;
  CREATE INDEX IF NOT EXISTS idx_users_email ON Users(lower(email));
  CREATE INDEX IF NOT EXISTS idx_memberships_org ON Memberships(org_id);
  CREATE INDEX IF NOT EXISTS idx_expenses_org ON Expenses(org_id);
  CREATE INDEX IF NOT EXISTS idx_expenses_dupe ON Expenses(employee_id, "date", claimed_amount);
  CREATE INDEX IF NOT EXISTS idx_audit_expense ON AuditLog(expense_id);
  ALTER TABLE Workspaces ENABLE ROW LEVEL SECURITY;
  ALTER TABLE Users ENABLE ROW LEVEL SECURITY;
  ALTER TABLE Expenses ENABLE ROW LEVEL SECURITY;
  ALTER TABLE AuditLog ENABLE ROW LEVEL SECURITY;
  ALTER TABLE KnowledgeBase ENABLE ROW LEVEL SECURITY;
  ALTER TABLE PreApprovals ENABLE ROW LEVEL SECURITY;
  ALTER TABLE FxRates ENABLE ROW LEVEL SECURITY;
  ALTER TABLE Receipts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE Meta ENABLE ROW LEVEL SECURITY;
  ALTER TABLE PolicySnapshots ENABLE ROW LEVEL SECURITY;
  ALTER TABLE Companies ENABLE ROW LEVEL SECURITY;
  ALTER TABLE Memberships ENABLE ROW LEVEL SECURITY;
  ALTER TABLE Sessions ENABLE ROW LEVEL SECURITY;
`;

// SQL is written with `?` placeholders (as with SQLite); Postgres wants $1, $2...
// Table names are also qualified with the app's schema here. A per-connection
// search_path would break behind Supabase's transaction pooler, where each
// query can run on a different server connection.
const TABLES = /\b(Companies|Workspaces|Users|Memberships|Sessions|Expenses|AuditLog|KnowledgeBase|PreApprovals|FxRates|Receipts|Meta|PolicySnapshots)\b/g;
const toPg = (sql, schema) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`).replace(TABLES, `${schema}.$1`); };

function wrap(runner, schema) {
  const query = (sql, params = []) => runner.query(toPg(sql, schema), params);
  return {
    query,
    all: async (sql, params) => (await query(sql, params)).rows,
    get: async (sql, params) => (await query(sql, params)).rows[0],
    run: async (sql, params) => { await query(sql, params); }
  };
}

// Supabase's session pooler (port 5432) gives each open connection one of a few
// slots (15 on the free plan), and serverless instances each hold their own, so
// they run out. The transaction pooler (6543) on the same host shares
// connections between queries, so use it. Set DATABASE_POOL_MODE=session to opt out.
function useTransactionPooler(url) {
  if (process.env.DATABASE_POOL_MODE === 'session') return url;
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('.pooler.supabase.com') && (u.port === '5432' || u.port === '')) {
      u.port = '6543';
      return u.toString();
    }
  } catch { /* not a URL we can parse: use it as given */ }
  return url;
}

async function openDatabase(connectionString, { schema = 'ghostaudit' } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is not set. Add your Supabase connection string to .env (see .env.example).');
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name "${schema}".`);
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  connectionString = useTransactionPooler(connectionString);
  // Small pool with short idle timeout: on serverless hosts every running instance
  // holds its own pool.
  const pool = new Pool({
    connectionString, ssl: local ? false : { rejectUnauthorized: false },
    max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000
  });
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));

  const db = {
    ...wrap(pool, schema),
    pool,
    schema,
    // Runs fn(tx) inside BEGIN/COMMIT on a single connection; rolls back on error.
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client, schema));
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };

  await db.transaction(async (tx) => {
    // Serialise setup so two servers starting at once don't race on CREATE TABLE.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext(?))', [`ghostaudit-setup-${schema}`]);
    await tx.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await tx.query(SCHEMA_SQL);
    await seed(tx);
  });
  return db;
}

// Adds the starter policy to a workspace (new workspaces, and Ghost Labs on first run).
async function seedStarterPolicy(tx, orgId) {
  for (const p of POLICY_SEED) {
    // Ghost Labs keeps the ids it has always had.
    const id = orgId === ORG ? `policy_${p.section.replace('.', '_')}` : uid('policy');
    await tx.run(`INSERT INTO KnowledgeBase (id,org_id,title,section,body,updated_at,rule_type,params,body_template,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
    [id, orgId, p.title, p.section, renderBody(p.body_template, p.params), now(), p.rule_type, JSON.stringify(p.params), p.body_template, 'seed']);
  }
}

// Second demo workspace: its own people and its own policy (the Koala Labs policy PDF).
const KOALA = 'org_koala';
const KOALA_POLICY = [
  { section: '4.1', rule_type: 'cap', category: 'Meals', per: 'person', limit: 75 },
  { section: '4.2', rule_type: 'prohibited_item', item: 'alcohol', allow_preapproval: true },
  { section: '5.1', rule_type: 'preapproval_required', expense_types: ['flight'], threshold: 1000 },
  { section: '5.2', rule_type: 'prohibited_item', item: 'flight upgrades', allow_preapproval: true },
  { section: '6.1', rule_type: 'receipt_age', max_days: 60 },
  { section: '7.1', rule_type: 'preapproval_required', expense_types: ['software'], threshold: 50 }
];

// Demo company that owns both demo workspaces. Every demo account (and any account
// created before sign-in existed) gets this password until it is changed.
const DEMO_COMPANY = 'co_demo';
const DEMO_PASSWORD = 'demo1234';

async function seed(tx) {
  await tx.run(`INSERT INTO Companies (id,name) VALUES (?, 'Demo Company') ON CONFLICT (id) DO NOTHING`, [DEMO_COMPANY]);
  await tx.run(`INSERT INTO Workspaces (id,name,company_id) VALUES (?, 'Ghost Labs', ?), (?, 'Koala Labs', ?) ON CONFLICT (id) DO NOTHING`,
    [ORG, DEMO_COMPANY, KOALA, DEMO_COMPANY]);
  for (const u of [
    ['user_alex', 'Alex Morgan', 'alex@ghostaudit.demo', 'employee', ORG],
    ['user_jamie', 'Jamie Chen', 'jamie@ghostaudit.demo', 'employee', ORG],
    ['user_finance', 'Taylor Finance', 'finance@ghostaudit.demo', 'finance', ORG],
    ['user_priya', 'Priya Nair', 'priya@koalalabs.demo', 'employee', KOALA],
    ['user_ben', 'Ben Carter', 'ben@koalalabs.demo', 'employee', KOALA],
    ['user_morgan', 'Morgan Lee', 'morgan@koalalabs.demo', 'finance', KOALA]
  ]) await tx.run('INSERT INTO Users (id,name,email,role,org_id,company_id) VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING', [...u, DEMO_COMPANY]);

  // One-off move to companies + sign-in for databases created before it existed.
  if (!(await tx.get(`SELECT 1 FROM Meta WHERE key='auth_backfill_v1'`))) {
    await tx.run('UPDATE Workspaces SET company_id=? WHERE id IN (?,?) AND company_id IS NULL', [DEMO_COMPANY, ORG, KOALA]);
    // Any other workspace was its own company under the old model: keep it that way.
    for (const w of await tx.all('SELECT id, name FROM Workspaces WHERE company_id IS NULL')) {
      await tx.run('INSERT INTO Companies (id,name) VALUES (?,?) ON CONFLICT (id) DO NOTHING', [`co_${w.id}`, w.name]);
      await tx.run('UPDATE Workspaces SET company_id=? WHERE id=?', [`co_${w.id}`, w.id]);
      await tx.run(`UPDATE Users SET is_owner=true WHERE id = (SELECT id FROM Users WHERE org_id=? AND role='finance' ORDER BY id LIMIT 1)`, [w.id]);
    }
    await tx.run('UPDATE Users u SET company_id=w.company_id FROM Workspaces w WHERE w.id=u.org_id AND u.company_id IS NULL');
    await tx.run('INSERT INTO Memberships (user_id,org_id,role) SELECT id, org_id, role FROM Users ON CONFLICT DO NOTHING');
    await tx.run(`UPDATE Users SET is_owner=true WHERE id='user_finance'`);
    await tx.run(`INSERT INTO Meta (key,value) VALUES ('auth_backfill_v1', ?)`, [now()]);
  }
  // Accounts without a password (demo seeds, or made before sign-in existed).
  const { hashPassword } = require('./auth');
  for (const u of await tx.all('SELECT id FROM Users WHERE password_hash IS NULL AND deleted_at IS NULL')) {
    await tx.run('UPDATE Users SET password_hash=? WHERE id=?', [await hashPassword(DEMO_PASSWORD), u.id]);
  }

  // Each workspace's policy is seeded once; after that it belongs to that workspace's finance team.
  // (Ghost Labs uses the original 'policy_seeded' key so existing databases aren't re-seeded.)
  if (!(await tx.get(`SELECT 1 FROM Meta WHERE key='policy_seeded'`))) {
    await seedStarterPolicy(tx, ORG);
    await tx.run(`INSERT INTO Meta (key,value) VALUES ('policy_seeded', ?)`, [now()]);
  }
  if (!(await tx.get(`SELECT 1 FROM Meta WHERE key=?`, [`policy_seeded:${KOALA}`]))) {
    const { validateRule } = require('./policy'); // loaded here: policy.js itself requires this file
    for (const { section, ...input } of KOALA_POLICY) {
      const r = validateRule(input);
      await tx.run(`INSERT INTO KnowledgeBase (id,org_id,title,section,body,updated_at,rule_type,params,body_template,updated_by,source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      [uid('policy'), KOALA, r.title, section, renderBody(r.body_template, r.params), now(), r.rule_type, JSON.stringify(r.params), r.body_template, 'seed', 'pdf:koala-labs-standard-policy.pdf']);
    }
    await tx.run(`INSERT INTO Meta (key,value) VALUES (?, ?)`, [`policy_seeded:${KOALA}`, now()]);
  }

  for (const [cur, rate] of Object.entries(FX_SEED)) {
    await tx.run('INSERT INTO FxRates (currency,rate_to_usd,updated_at) VALUES (?,?,?) ON CONFLICT (currency) DO NOTHING', [cur, rate, now()]);
  }

  // One pre-approval so the flight rule can be demoed both ways:
  // Jamie's $1,450 flight passes, Alex's is rejected.
  await tx.run(`INSERT INTO PreApprovals
    (id,org_id,employee_id,expense_type,description,max_amount,currency,approved_by,created_at)
    VALUES ('pa_seed_jamie',?,'user_jamie','flight','Client offsite: return flight to San Francisco',1500,'USD','user_finance',?)
    ON CONFLICT (id) DO NOTHING`, [ORG, now()]);
}

module.exports = { openDatabase, renderBody, seedStarterPolicy, ORG, DEMO_COMPANY, DEMO_PASSWORD, now, uid };
