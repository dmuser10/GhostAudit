import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, ArrowDownLeft, ArrowUpRight, Banknote, Building2, CheckCircle2, ChevronsUpDown, CircleAlert, Clock3, FileCheck2, FileText, FileUp, KeyRound, LogOut, Pencil,
  LayoutDashboard, LoaderCircle, Plane, Plus, ReceiptText, ShieldCheck, Sparkles, Trash2, Upload, Users, Wallet, XCircle
} from 'lucide-react';
import './style.css';

// The company's home currency (from /api/health; AUD unless the server sets BASE_CURRENCY).
// Policy limits and totals are in it. en-AU shows AUD as "$75.00" and others as "USD 75.00".
let BASE = 'AUD';
const money = (n, c = BASE) => {
  try { return new Intl.NumberFormat('en-AU', { style: 'currency', currency: c, maximumFractionDigits: 2 }).format(Number(n || 0)); }
  catch { return `${c} ${Number(n || 0).toFixed(2)}`; }
};
const dateFmt = (d) => d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const api = async (url, options = {}) => {
  const r = await fetch(url, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
};
const jsonPost = (url, body, method = 'POST') => api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const CURRENCIES = ['AUD', 'USD', 'GBP', 'EUR', 'CAD'];
const EMPTY_OVERRIDES = { vendor: '', date: '', amount: '', category: '', currency: '', attendees: '' };

// Phone photos are often 3-12 MB. Receipts are stored in the database (500 MB on
// Supabase's free plan), so large photos are shrunk in the browser first: at most
// ~4.5 megapixels, which keeps receipt text sharp for OCR, saved as JPEG. Small
// images and PDFs are sent unchanged. If the browser can't decode the image
// (e.g. HEIC in Chrome), the original is sent and the server's own limit applies.
const MAX_PIXELS = 4.5e6, MAX_SIDE = 3200, SHRINK_OVER_BYTES = 1.5 * 1024 * 1024;
async function prepareReceipt(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return file; }
  const { width, height } = bitmap;
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)), MAX_SIDE / Math.max(width, height));
  if (scale === 1 && file.size <= SHRINK_OVER_BYTES) { bitmap.close?.(); return file; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); // transparent PNGs → white, not black
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}
const METHOD_LABEL = { claude: 'Read by Claude', 'claude+ocr': 'OCR + Claude', 'ocr+rules': 'OCR + rules', rules: 'Text rules' };
const TYPE_LABEL = { flight: 'Flight', taxi: 'Taxi', rideshare: 'Rideshare', hotel: 'Hotel', train: 'Train', other_travel: 'Other travel', meal: 'Meal', software: 'Software', other: 'Other' };

function Status({ status }) {
  const icon = status === 'Approved' ? <CheckCircle2 size={13} /> : status === 'Capped' ? <CircleAlert size={13} /> : status === 'Rejected' ? <XCircle size={13} /> : <Clock3 size={13} />;
  return <span className={`status status-${String(status).toLowerCase()}`}>{icon}{status}</span>;
}
function Stat({ icon, label, value, sub, green, purple }) {
  return <div className="stat-card"><div className={`stat-icon ${green ? 'green' : purple ? 'purple' : ''}`}>{icon}</div><span className="stat-label">{label}</span><strong className="stat-value">{value}</strong><span className="stat-sub">{sub}</span></div>;
}
function Empty({ icon, title, text }) {
  return <div className="empty-state"><div>{icon}</div><strong>{title}</strong><p>{text}</p></div>;
}

function AuditTrail({ logs }) {
  return <details className="audit-details"><summary>Audit trail ({logs.length} events)</summary>
    {logs.map(l => <div className="log-line" key={l.id}><span className="log-dot" /><div>
      <strong>{l.actor}</strong><p>{l.action.replaceAll('_', ' ')}</p>
      {l.action === 'policy_evaluated' && Array.isArray(l.details?.checks) && <ul className="check-list">
        {l.details.checks.map(c => <li key={c.section} className={`check-${c.outcome.replace('/', '')}`}><b>§{c.section}</b> {c.outcome}: {c.detail}</li>)}
      </ul>}
      {l.action === 'fields_corrected_by_employee' && <ul className="check-list">
        {Object.entries(l.details || {}).map(([k, v]) => <li key={k}><b>{k}</b> {String(v.extracted ?? '—')} → {String(v.corrected)}</li>)}
      </ul>}
      <small>{new Date(l.timestamp).toLocaleString()}</small>
    </div></div>)}
  </details>;
}

function DecisionCard({ expense, logs, onClose }) {
  return <div className="decision-card">
    <div className="decision-top"><div><span className="eyebrow">FINAL DECISION</span><h3>{expense.vendor}</h3></div>
      <button className="icon-button" onClick={onClose} aria-label="Close decision"><XCircle size={17} /></button></div>
    <div className="decision-meta"><Status status={expense.status} /><span className="actor-tag">{TYPE_LABEL[expense.expense_type] || expense.category}</span>
      {expense.attendees > 1 && <span className="actor-tag">{expense.attendees} people</span>}
      <span className="actor-tag">{METHOD_LABEL[expense.extraction_method] || expense.extraction_method}</span>
      {expense.receipt_url && <a className="actor-tag" href={expense.receipt_url} target="_blank" rel="noreferrer">View receipt</a>}</div>
    <div className="decision-amounts"><div><span>Claimed</span><strong>{money(expense.claimed_amount, expense.currency)}</strong></div><ArrowDownLeft size={17} />
      <div><span>Approved</span><strong className="approved-value">{money(expense.approved_amount, expense.currency)}</strong></div></div>
    <p className="decision-reason">{expense.decision_reason}</p>
    <div className="citation"><ShieldCheck size={15} /><div><strong>Policy citation</strong>
      {String(expense.policy_citation).split(' | ').map((c, i) => <p key={i}>{c}</p>)}</div></div>
    {expense.line_items?.length > 0 && <details className="audit-details"><summary>Line items ({expense.line_items.length})</summary>
      <ul className="check-list">{expense.line_items.map((i, n) => <li key={n}>{i.description}{i.amount != null && <b> {money(i.amount, expense.currency)}</b>}</li>)}</ul></details>}
    <AuditTrail logs={logs} />
  </div>;
}

// Signed out: the sign-in / sign-up screen. Signed in: the app for the session's
// active workspace. The session cookie keeps people signed in for 30 days.
function App() {
  const [session, setSession] = useState(undefined); // undefined = checking, null = signed out
  const [health, setHealth] = useState(null);
  useEffect(() => {
    api('/api/session').then(setSession).catch(() => setSession(null));
    api('/api/health').then((h) => { BASE = h.base_currency || BASE; setHealth(h); }).catch(() => {});
  }, []);
  if (session === undefined) return <div className="auth-shell"><LoaderCircle className="spin" size={22} /></div>;
  if (!session) return <AuthScreen onSignedIn={setSession} />;
  // key: a different person or workspace starts from a clean screen.
  return <Workspace key={`${session.user.id}:${session.active_org_id}`} {...{ session, setSession, health }} />;
}

function Workspace({ session, setSession, health }) {
  const [team, setTeam] = useState([]);
  const [expenses, setExpenses] = useState([]), [dashboard, setDashboard] = useState(null), [policy, setPolicy] = useState([]), [preapprovals, setPreapprovals] = useState([]);
  const [mode, setMode] = useState('upload');
  const [file, setFile] = useState(null), [receiptText, setReceiptText] = useState('');
  const [overrides, setOverrides] = useState(EMPTY_OVERRIDES);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [selected, setSelected] = useState(null), [logs, setLogs] = useState([]);
  const [toast, setToast] = useState('');
  const [newWorkspace, setNewWorkspace] = useState(false), [changePassword, setChangePassword] = useState(false), [cancelSub, setCancelSub] = useState(false);
  const user = { ...session.user, role: session.role, org_id: session.active_org_id };
  const isFinance = user.role === 'finance';
  const workspace = session.workspaces.find(w => w.id === session.active_org_id);

  const refresh = async () => {
    if (!workspace) return;
    try {
      const [e, p, pa, d, t] = await Promise.all([
        api('/api/expenses'), api('/api/policy'), api('/api/preapprovals'),
        isFinance ? api('/api/dashboard') : Promise.resolve(null), api('/api/users')
      ]);
      setExpenses(e); setPolicy(p); setPreapprovals(pa); setDashboard(d); setTeam(t);
    } catch (err) {
      if (/sign in/i.test(err.message)) setSession(null); // session expired or signed out elsewhere
      else setError(err.message);
    }
  };
  const reloadSession = async () => setSession(await api('/api/session'));
  const loadPeople = async () => { await reloadSession(); setTeam(await api('/api/users')); };
  useEffect(() => { refresh(); }, []);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(''), 3500); return () => clearTimeout(t); } }, [toast]);

  // Claims in other currencies are converted to the home currency with the rate stored on each claim.
  const myTotals = useMemo(() => expenses.reduce((a, e) => ({
    claimed: a.claimed + e.claimed_amount * (e.fx_rate_to_base || 1),
    approved: a.approved + e.approved_amount * (e.fx_rate_to_base || 1)
  }), { claimed: 0, approved: 0 }), [expenses]);

  const openExpense = async (e) => {
    setSelected(e);
    try { setLogs(await api(`/api/expenses/${e.id}/logs`)); } catch { setLogs([]); }
  };
  // The chosen workspace is saved in the session, so it's still selected after a refresh.
  const switchWorkspace = async (orgId) => {
    try { setSession(await jsonPost('/api/session/workspace', { org_id: orgId })); } catch (err) { setError(err.message); }
  };
  const signOut = async () => { await jsonPost('/api/auth/logout', {}).catch(() => {}); setSession(null); };
  const resetDemoClaims = async () => {
    if (!window.confirm('Delete every claim in the Demo Company workspaces?\n\nAccounts, workspaces, policies and pre-approvals stay. This cannot be undone.')) return;
    try {
      const r = await jsonPost('/api/demo/reset-claims', {});
      setSelected(null); setLogs([]);
      await refresh();
      setToast(`Demo reset: ${r.expenses} claim${r.expenses === 1 ? '' : 's'} deleted`);
    } catch (err) { setError(err.message); }
  };
  const resumeSubscription = async () => {
    try { setSession(await jsonPost('/api/company/subscription/resume', {})); setToast('Subscription resumed'); } catch (err) { setError(err.message); }
  };
  const renameCompany = async () => {
    const name = window.prompt('Company name', session.company.name);
    if (!name || name.trim() === session.company.name) return;
    try { setSession(await jsonPost('/api/company', { name }, 'PUT')); setToast('Company renamed'); } catch (err) { setError(err.message); }
  };

  const submit = async (e) => {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      let result;
      const fields = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== ''));
      if (mode === 'upload') {
        if (!file) throw new Error('Choose a receipt image or PDF first.');
        const fd = new FormData();
        Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
        fd.append('receipt', await prepareReceipt(file));
        result = await api('/api/expenses/upload', { method: 'POST', body: fd });
      } else {
        if (!receiptText.trim()) throw new Error('Paste the receipt email or text first.');
        result = await jsonPost('/api/expenses/text', { text: receiptText, ...fields });
      }
      await refresh();
      await openExpense(result);
      setReceiptText(''); setFile(null); setOverrides(EMPTY_OVERRIDES);
      setToast(`${result.status}: ${money(result.approved_amount, result.currency)} approved`);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><ShieldCheck size={21} /></div><span>ghost<span className="brand-light">audit</span></span><span className="beta">BETA</span></div>
      <WorkspaceSwitcher workspaces={session.workspaces} current={workspace} onSwitch={switchWorkspace} onNew={session.user.is_owner ? () => setNewWorkspace(true) : null} />
      <div className="nav-label">WORKSPACE</div>
      {isFinance
        ? <button className="nav-item active"><LayoutDashboard size={17} />Finance overview</button>
        : <button className="nav-item active"><ReceiptText size={17} />My expenses</button>}
      <div className="sidebar-bottom">
        <div className="security-note"><div><Sparkles size={15} /><strong>No approval queue</strong></div>
          <p>Every claim is decided on submission against the written policy, and every step is logged.</p></div>
        <div className="profile"><div className="avatar">{initials(user.name)}</div>
          <div className="profile-name"><strong>{user.name}</strong><small>{session.user.is_owner ? 'Company owner' : isFinance ? 'Finance' : 'Employee'}</small></div></div>
      </div>
    </aside>
    <main className="main">
      <header className="topbar">
        <div className="topbar-title">
          <div className="company-name"><Building2 size={16} /><strong>{session.company.name}</strong>
            {session.user.is_owner && <button className="icon-button" onClick={renameCompany} aria-label="Rename company" title="Rename company"><Pencil size={12} /></button>}</div>
          <div className="breadcrumb">{workspace?.name || 'No workspace'} <span>/</span> <b>{isFinance ? 'Finance overview' : 'My expenses'}</b></div>
        </div>
        <div className="top-actions">
          {health && <span className="live-indicator"><span />Extractor: {health.extractor === 'claude' ? `Claude (${health.model})` : 'OCR + rules'}</span>}
          {session.user.is_owner && (session.company.subscription?.status === 'cancelled'
            ? <span className="subscription-pill"><span className="sub-long">Subscription ends</span><span className="sub-short">Ends</span> {dateFmt(session.company.subscription.ends_on)}
                <button type="button" className="link-button" onClick={resumeSubscription}>Resume</button></span>
            : <button type="button" className="button button-danger subscription-button" onClick={() => setCancelSub(true)}>Cancel subscription</button>)}
          <UserMenu {...{ user, isFinance, isOwner: session.user.is_owner, onChangePassword: () => setChangePassword(true), onSignOut: signOut,
            onResetDemo: session.user.is_owner && session.company.id === 'co_demo' ? resetDemoClaims : null }} />
        </div>
      </header>
      {error && <div className="error-banner" role="alert"><CircleAlert size={16} />{error}<button onClick={() => setError('')} aria-label="Dismiss"><XCircle size={15} /></button></div>}
      {!workspace && <div className="page"><Empty icon={<Users size={22} />} title="No workspace yet" text="You're signed in, but you aren't a member of any workspace. Ask your finance team to add you." /></div>}
      {workspace && !isFinance && <EmployeeScreen {...{ expenses, myTotals, mode, setMode, file, setFile, receiptText, setReceiptText, overrides, setOverrides, busy, submit, selected, setSelected, logs, openExpense, preapprovals, setError }} />}
      {workspace && isFinance && <FinanceScreen {...{ user, users: team, expenses, dashboard, policy, preapprovals, refresh, setError, setToast, selected, setSelected, logs, openExpense, loadPeople, workspace }} />}
      <footer className="footer"><span>© 2026 GhostAudit</span><span><span className="green-dot" /> Decisions by written policy, not approval chains.</span><span>Signed in as {user.email}</span></footer>
    </main>
    {toast && <div className="toast" role="status"><CheckCircle2 size={17} />{toast}</div>}
    {newWorkspace && <NewWorkspaceDialog onClose={() => setNewWorkspace(false)} onCreated={(s) => {
      setNewWorkspace(false);
      setSession(s);
    }} />}
    {changePassword && <ChangePasswordDialog onClose={() => setChangePassword(false)} onDone={() => { setChangePassword(false); setToast('Password changed. Other devices were signed out.'); }} />}
    {cancelSub && <CancelSubscriptionDialog session={session} onClose={() => setCancelSub(false)} onCancelled={(s) => {
      setCancelSub(false);
      setSession(s);
      setToast(`Subscription cancelled. It ends on ${dateFmt(s.company.subscription.ends_on)}.`);
    }} />}
  </div>;
}

const initials = (name) => String(name || '').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase() || 'GA';

function UserMenu({ user, isFinance, isOwner, onChangePassword, onSignOut, onResetDemo }) {
  const [open, setOpen] = useState(false);
  return <div className="user-menu">
    <button className="role-switch" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
      <span className="avatar small">{initials(user.name)}</span><span className="user-menu-name">{user.name}</span>
      <small>{isOwner ? 'owner' : isFinance ? 'finance' : 'employee'}</small><ChevronsUpDown size={13} />
    </button>
    {open && <div className="workspace-menu user-menu-list" role="menu">
      <div className="user-menu-email">{user.email}</div>
      <button role="menuitem" onClick={() => { setOpen(false); onChangePassword(); }}><KeyRound size={14} />Change password</button>
      {onResetDemo && <button role="menuitem" onClick={() => { setOpen(false); onResetDemo(); }}><Trash2 size={14} />Reset demo claims</button>}
      <button role="menuitem" onClick={() => { setOpen(false); onSignOut(); }}><LogOut size={14} />Sign out</button>
    </div>}
  </div>;
}

const DEMO_ACCOUNTS = [
  ['finance@ghostaudit.demo', 'Taylor Finance', 'Company owner · both workspaces'],
  ['alex@ghostaudit.demo', 'Alex Morgan', 'Employee · Ghost Labs'],
  ['morgan@koalalabs.demo', 'Morgan Lee', 'Finance · Koala Labs'],
  ['priya@koalalabs.demo', 'Priya Nair', 'Employee · Koala Labs']
];

function AuthScreen({ onSignedIn }) {
  const [tab, setTab] = useState('signin');
  const [form, setForm] = useState({ email: '', password: '', company: '', name: '', workspace: '', starter_policy: true });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      onSignedIn(tab === 'signin'
        ? await jsonPost('/api/auth/login', { email: form.email, password: form.password })
        : await jsonPost('/api/auth/signup', form));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <div className="auth-shell">
    <div className="auth-card panel">
      <div className="brand auth-brand"><div className="brand-mark"><ShieldCheck size={21} /></div><span>ghost<span className="brand-light">audit</span></span></div>
      <div className="tabs auth-tabs">
        <button type="button" className={tab === 'signin' ? 'selected' : ''} onClick={() => { setTab('signin'); setError(''); }}>Sign in</button>
        <button type="button" className={tab === 'signup' ? 'selected' : ''} onClick={() => { setTab('signup'); setError(''); }}>Create company account</button>
      </div>
      {error && <div className="error-banner modal-error" role="alert"><CircleAlert size={16} />{error}</div>}
      <form className="field-grid auth-form" onSubmit={submit}>
        {tab === 'signup' && <>
          <label className="wide-field">Company name<input required value={form.company} onChange={set('company')} placeholder="e.g. Wombat Works" autoComplete="organization" /></label>
          <label className="wide-field">Your name<input required value={form.name} onChange={set('name')} autoComplete="name" /></label>
        </>}
        <label className="wide-field">Email<input required type="email" value={form.email} onChange={set('email')} autoComplete="email" autoFocus /></label>
        <label className="wide-field">Password<input required type="password" minLength={tab === 'signup' ? 8 : undefined} value={form.password} onChange={set('password')}
          autoComplete={tab === 'signin' ? 'current-password' : 'new-password'} placeholder={tab === 'signup' ? 'At least 8 characters' : ''} /></label>
        {tab === 'signup' && <>
          <label className="wide-field">First workspace<input value={form.workspace} onChange={set('workspace')} placeholder="Defaults to the company name (e.g. a team or office)" /></label>
          <label className="wide-field inline-check"><input type="checkbox" checked={form.starter_policy} onChange={e => setForm({ ...form, starter_policy: e.target.checked })} />
            Start with the starter policy. Untick to start empty and upload your own policy PDF.</label>
        </>}
        <button className="button button-primary wide-field" type="submit" disabled={busy}>
          {busy && <LoaderCircle className="spin" size={14} />}{tab === 'signin' ? 'Sign in' : 'Create account'}</button>
      </form>
      {tab === 'signin'
        ? <p className="field-help auth-foot">No account? <button type="button" className="link-button" onClick={() => setTab('signup')}>Create one for your company</button>. Employees: ask your finance team to add you.</p>
        : <p className="field-help auth-foot">You'll be the company owner: you can create workspaces and add finance staff and employees.</p>}
    </div>
    {tab === 'signin' && <div className="auth-demo panel">
      <strong>Demo accounts</strong><p>Password for all: <code>demo1234</code>. Click one to fill it in.</p>
      {DEMO_ACCOUNTS.map(([email, name, what]) => <button key={email} type="button" className="demo-account" onClick={() => setForm({ ...form, email, password: 'demo1234' })}>
        <span className="avatar small">{initials(name)}</span><span><b>{name}</b><small>{what}</small></span></button>)}
    </div>}
  </div>;
}

function ChangePasswordDialog({ onClose, onDone }) {
  const [form, setForm] = useState({ current: '', password: '' });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault(); setError(''); setBusy(true);
    try { await jsonPost('/api/me/password', form, 'PUT'); onDone(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <form className="modal panel" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="pw-title">
      <div className="panel-heading"><div><h2 id="pw-title">Change password</h2><p>Other devices will be signed out.</p></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><XCircle size={17} /></button></div>
      {error && <div className="error-banner modal-error" role="alert"><CircleAlert size={16} />{error}</div>}
      <div className="field-grid">
        <label className="wide-field">Current password<input required type="password" autoComplete="current-password" autoFocus value={form.current} onChange={e => setForm({ ...form, current: e.target.value })} /></label>
        <label className="wide-field">New password<input required type="password" minLength={8} autoComplete="new-password" placeholder="At least 8 characters" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></label>
      </div>
      <div className="import-foot"><button className="button button-primary" type="submit" disabled={busy}>{busy && <LoaderCircle className="spin" size={14} />}Change password</button>
        <button type="button" className="button button-ghost" onClick={onClose}>Cancel</button></div>
    </form>
  </div>;
}

const longDate = (d) => new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

function CancelSubscriptionDialog({ session, onClose, onCancelled }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const endsOn = session.company.subscription?.ends_on_if_cancelled;
  const confirm = async () => {
    setError(''); setBusy(true);
    try { onCancelled(await jsonPost('/api/company/subscription/cancel', {})); } catch (err) { setError(err.message); setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal panel" role="alertdialog" aria-modal="true" aria-labelledby="cancel-title" aria-describedby="cancel-desc">
      <div className="panel-heading"><div><h2 id="cancel-title">Cancel subscription?</h2>
        <p id="cancel-desc">Your subscription will end on <b>{endsOn ? longDate(endsOn) : 'the end of the billing period'}</b>. {session.company.name} keeps full access until then, and you can resume any time before that date.</p></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><XCircle size={17} /></button></div>
      {error && <div className="error-banner modal-error" role="alert"><CircleAlert size={16} />{error}</div>}
      <div className="import-foot"><button type="button" className="button button-danger" onClick={confirm} disabled={busy}>{busy && <LoaderCircle className="spin" size={14} />}Cancel subscription</button>
        <button type="button" className="button button-ghost" onClick={onClose} autoFocus>Keep subscription</button></div>
    </div>
  </div>;
}

function WorkspaceSwitcher({ workspaces, current, onSwitch, onNew }) {
  const [open, setOpen] = useState(false);
  return <div className="workspace-switcher">
    <button className="workspace" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
      <div className="workspace-avatar">{current?.name?.[0]?.toUpperCase() || '·'}</div>
      <div><strong>{current?.name || 'Loading…'}</strong><small>{current ? `${current.members} member${current.members === 1 ? '' : 's'} · switch` : 'Workspace'}</small></div>
      <ChevronsUpDown size={14} />
    </button>
    {open && <div className="workspace-menu" role="menu">
      <div className="nav-label">WORKSPACES</div>
      {workspaces.map(w => <button role="menuitem" key={w.id} className={w.id === current?.id ? 'active' : ''} onClick={() => { setOpen(false); onSwitch(w.id); }}>
        <span className="workspace-avatar small">{w.name[0].toUpperCase()}</span><span>{w.name}</span><small>{w.members}</small></button>)}
      {onNew && <button role="menuitem" className="workspace-new" onClick={() => { setOpen(false); onNew(); }}><Plus size={14} />New workspace</button>}
    </div>}
  </div>;
}

function NewWorkspaceDialog({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', starter_policy: true });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault(); setError(''); setBusy(true);
    try { onCreated(await jsonPost('/api/workspaces', form)); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <form className="modal panel" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="new-ws-title">
      <div className="panel-heading"><div><h2 id="new-ws-title">New workspace</h2><p>A team, office or entity in your company, with its own people, claims and policy. You can open it as finance; add people from its Team panel.</p></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><XCircle size={17} /></button></div>
      {error && <div className="error-banner modal-error" role="alert"><CircleAlert size={16} />{error}</div>}
      <div className="field-grid">
        <label className="wide-field">Workspace name<input required autoFocus value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Sydney office" /></label>
        <label className="wide-field inline-check"><input type="checkbox" checked={form.starter_policy} onChange={e => setForm({ ...form, starter_policy: e.target.checked })} />
          Start with the starter policy (meal and taxi caps, alcohol ban, flight pre-approval, duplicate check). Untick to start empty and upload your own PDF.</label>
      </div>
      <div className="import-foot"><button className="button button-primary" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}Create workspace</button>
        <button type="button" className="button button-ghost" onClick={onClose}>Cancel</button></div>
    </form>
  </div>;
}

const EMPTY_MEMBER = { name: '', email: '', role: 'employee', password: '' };

function TeamPanel({ user, users, workspace, loadPeople, setError, setToast }) {
  const [form, setForm] = useState(EMPTY_MEMBER);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const add = async (e) => {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      const u = await jsonPost('/api/users', form);
      setForm(EMPTY_MEMBER);
      await loadPeople();
      setToast(u.added_existing ? `${u.name} (already in the company) added to ${workspace?.name}` : `${u.name} added. Give them their email and the starting password.`);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  // There is no email service, so finance resets passwords and passes them on.
  // Owner only. Their past claims stay in the records under their name.
  const deletePerson = async (u) => {
    if (!window.confirm(`Delete ${u.name}?\n\nThey'll be removed from every workspace in your company, signed out, and won't be able to sign in. Their past claims and audit history stay in the records.`)) return;
    try {
      await api(`/api/users/${u.id}`, { method: 'DELETE' });
      await loadPeople();
      setToast(`${u.name} deleted`);
    } catch (err) { setError(err.message); }
  };
  const resetPassword = async (u) => {
    const password = window.prompt(`New password for ${u.name} (at least 8 characters). They'll be signed out everywhere.`);
    if (!password) return;
    try { await jsonPost(`/api/users/${u.id}/password`, { password }, 'PUT'); setToast(`Password reset for ${u.name}`); } catch (err) { setError(err.message); }
  };
  return <section className="panel"><div className="panel-heading"><div><h2>Team</h2><p>People who can sign in to {workspace?.name || 'this workspace'}. Someone already in your company only needs their email.</p></div><span className="count-pill">{users.length}</span></div>
    <form className="field-grid inline-form team-form" onSubmit={add}>
      <label>Name<input value={form.name} onChange={set('name')} placeholder="New person" /></label>
      <label>Email<input required type="email" value={form.email} onChange={set('email')} /></label>
      <label>Starting password<input type="text" minLength={8} value={form.password} onChange={set('password')} placeholder="8+ characters" autoComplete="off" /></label>
      <label>Role<select value={form.role} onChange={set('role')}><option value="employee">Employee</option><option value="finance">Finance</option></select></label>
      <button className="button button-dark" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}Add</button>
    </form>
    <div className="expense-list">{users.map(u => <div className="expense-row" key={u.id}>
      <div className="avatar">{initials(u.name)}</div>
      <div className="expense-main"><strong>{u.name}{u.id === user.id ? ' (you)' : ''}</strong><span>{u.email}</span></div>
      <div className="expense-money team-actions">
        <span className={`status ${u.is_owner ? 'status-approved' : u.role === 'finance' ? 'status-capped' : 'status-processing'}`}>{u.is_owner ? 'Owner' : u.role === 'finance' ? 'Finance' : 'Employee'}</span>
        {u.id !== user.id && <button type="button" className="icon-button" onClick={() => resetPassword(u)} title="Reset password" aria-label={`Reset password for ${u.name}`}><KeyRound size={13} /></button>}
        {user.is_owner && !u.is_owner && <button type="button" className="icon-button rule-delete" onClick={() => deletePerson(u)} title="Delete from company" aria-label={`Delete ${u.name}`}><Trash2 size={13} /></button>}
      </div>
    </div>)}</div>
  </section>;
}

function EmployeeScreen({ expenses, myTotals, mode, setMode, file, setFile, receiptText, setReceiptText, overrides, setOverrides, busy, submit, selected, setSelected, logs, openExpense, preapprovals, setError }) {
  const set = (k) => (e) => setOverrides({ ...overrides, [k]: e.target.value });
  const openApprovals = preapprovals.filter(p => !p.used_by_expense_id);
  return <div className="page">
    <div className="page-heading"><div><div className="eyebrow">EMPLOYEE PORTAL</div><h1>Expenses, without the wait.</h1><p>Submit a receipt and get a final decision straight away.</p></div></div>
    <div className="stat-grid three">
      <Stat icon={<Wallet size={18} />} label={`Total claimed (${BASE})`} value={money(myTotals.claimed)} sub={`${expenses.length} claims`} />
      <Stat icon={<Banknote size={18} />} label={`Approved for payment (${BASE})`} value={money(myTotals.approved)} sub="Final decisions" green />
      <Stat icon={<Activity size={18} />} label={`Not reimbursed (${BASE})`} value={money(Math.max(0, myTotals.claimed - myTotals.approved))} sub="Capped or rejected" />
    </div>
    <div className="content-grid">
      <div>
        <section className="panel submit-panel" id="submit-card">
          <div className="panel-heading"><div><h2>Submit a receipt</h2><p>Extraction and policy audit in one step</p></div></div>
          <div className="tabs">
            <button type="button" className={mode === 'upload' ? 'selected' : ''} onClick={() => { setMode('upload'); setError(''); }}><Upload size={15} />Upload file</button>
            <button type="button" className={mode === 'text' ? 'selected' : ''} onClick={() => { setMode('text'); setError(''); }}><FileText size={15} />Paste email</button>
          </div>
          <form onSubmit={submit}>
            {mode === 'upload'
              ? <label className={`dropzone ${file ? 'has-file' : ''}`} htmlFor="receipt-file">
                <input id="receipt-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" onChange={e => setFile(e.target.files?.[0] || null)} />
                <div className="upload-icon">{file ? <FileCheck2 size={22} /> : <Upload size={22} />}</div>
                <strong>{file ? file.name : 'Choose a receipt image or PDF'}</strong>
                <span>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB, ready` : 'Photo (any size, shrunk automatically) or PDF up to 10 MB'}</span>
                <small>{file ? 'Choose another file' : 'We read the vendor, date, total and line items'}</small>
              </label>
              : <label className="field-label">Receipt email or text
                <textarea className="receipt-textarea" rows="8" value={receiptText} onChange={e => setReceiptText(e.target.value)}
                  placeholder={'Paste the receipt email or text…\n\nExample:\nThe Corner Bistro\nDate: 2026-10-12\nGuests: 2\nLunch\nTotal: $92.50'} />
              </label>}
            <details className="manual-fields"><summary>Review or correct extracted fields <span>Optional</span></summary>
              <div className="field-grid">
                <label>Vendor<input placeholder="Auto-detected" value={overrides.vendor} onChange={set('vendor')} /></label>
                <label>Date<input type="date" value={overrides.date} onChange={set('date')} /></label>
                <label>Total amount<input type="number" min="0.01" step="0.01" placeholder="Auto-detected" value={overrides.amount} onChange={set('amount')} /></label>
                <label>Currency<select value={overrides.currency} onChange={set('currency')}><option value="">Auto-detect</option>{CURRENCIES.map(c => <option key={c}>{c}</option>)}</select></label>
                <label>Category<select value={overrides.category} onChange={set('category')}><option value="">Auto-detect</option><option>Meals</option><option>Travel</option><option>Software</option><option>Other</option></select></label>
                <label>People (meals)<input type="number" min="1" max="50" step="1" placeholder="Auto / 1" value={overrides.attendees} onChange={set('attendees')} /></label>
              </div>
              <p className="field-help">Corrections are recorded in the audit log under your name. The receipt itself is still checked against every policy rule.</p>
            </details>
            <button className="button button-primary submit-button" type="submit" disabled={busy}>
              {busy ? <><LoaderCircle className="spin" size={17} />Reading receipt…</> : <><Sparkles size={16} />Submit and get decision <ArrowUpRight size={16} /></>}
            </button>
            <div className="submit-foot"><ShieldCheck size={13} /> Decisions are final and written to the audit log.</div>
          </form>
        </section>
        {preapprovals.length > 0 && <section className="panel submit-panel stacked-panel">
          <div className="panel-heading"><div><h2>Your pre-approvals</h2><p>Recorded by finance. Used automatically when a matching claim arrives.</p></div><span className="count-pill">{openApprovals.length} open</span></div>
          <PreapprovalList rows={preapprovals} />
        </section>}
      </div>
      <section className="panel expenses-panel">
        <div className="panel-heading"><div><h2>My expenses</h2><p>Your claims and their final decisions</p></div><span className="count-pill">{expenses.length}</span></div>
        {selected && <DecisionCard expense={selected} logs={logs} onClose={() => setSelected(null)} />}
        {expenses.length === 0
          ? <Empty icon={<ReceiptText size={22} />} title="No claims yet" text="Submit a receipt on the left and the decision appears here." />
          : <ExpenseList expenses={expenses} selected={selected} onOpen={openExpense} />}
      </section>
    </div>
  </div>;
}

function ExpenseList({ expenses, selected, onOpen, showEmployee }) {
  return <div className="expense-list">{expenses.map(e =>
    <button className={`expense-row ${selected?.id === e.id ? 'row-selected' : ''}`} key={e.id} onClick={() => onOpen(e)}>
      <div className={`vendor-icon category-${e.category.toLowerCase()}`}>{e.category[0]}</div>
      <div className="expense-main"><strong>{e.vendor}</strong>
        <span>{dateFmt(e.date)} <i>·</i> {e.category}{showEmployee && <> <i>·</i> {e.employee_name}</>}</span>
        <Status status={e.status} /></div>
      <div className="expense-money"><strong>{money(e.approved_amount, e.currency)}</strong><span>of {money(e.claimed_amount, e.currency)}</span></div>
    </button>)}</div>;
}

function PreapprovalList({ rows, showEmployee }) {
  return <div className="expense-list">{rows.map(p =>
    <div className="expense-row" key={p.id}>
      <div className="vendor-icon category-travel"><Plane size={15} /></div>
      <div className="expense-main"><strong>{p.description}</strong>
        <span>{TYPE_LABEL[p.expense_type] || p.expense_type} up to {money(p.max_amount, p.currency)}{p.allows?.length > 0 && <> <i>·</i> also allows {p.allows.join(', ')}</>}{showEmployee && <> <i>·</i> {p.employee_name}</>}</span></div>
      <div className="expense-money"><span className={`status ${p.used_by_expense_id ? 'status-processing' : 'status-approved'}`}>{p.used_by_expense_id ? 'Used' : 'Open'}</span></div>
    </div>)}</div>;
}

function FinanceScreen({ user, users, expenses, dashboard, policy, preapprovals, refresh, setError, setToast, selected, setSelected, logs, openExpense, loadPeople, workspace }) {
  const t = dashboard?.totals;
  const employees = users.filter(u => u.role === 'employee');
  const [pa, setPa] = useState({ employee_id: '', expense_type: 'flight', description: '', max_amount: '', currency: BASE, allows: [] });
  // Banned items whose rule accepts a pre-approval ("alcohol, unless pre-approved").
  const allowable = policy.filter(p => p.rule_type === 'prohibited_item' && p.enabled && p.params.allow_preapproval);

  const createPa = async (e) => {
    e.preventDefault(); setError('');
    try {
      await jsonPost('/api/preapprovals', { ...pa });
      setPa({ ...pa, description: '', max_amount: '', allows: [] }); setToast('Pre-approval recorded'); refresh();
    } catch (err) { setError(err.message); }
  };

  return <div className="page">
    <div className="page-heading"><div><div className="eyebrow">FINANCE WORKSPACE</div><h1>Policy in control.</h1><p>Every claim accounted for. Amounts shown in {BASE}.</p></div>
      <div className="date-chip"><span className="green-dot" /> Live data from Supabase</div></div>
    <div className="stat-grid four">
      <Stat icon={<ReceiptText size={18} />} label="Total claimed" value={money(t?.claimed)} sub={`${t?.count || 0} decided claims`} />
      <Stat icon={<Banknote size={18} />} label="Total paid" value={money(t?.paid)} sub="Approved + capped amounts" green />
      <Stat icon={<ShieldCheck size={18} />} label="Saved by policy" value={money(t?.saved)} sub={`Caps ${money(t?.saved_caps)} · Rejections ${money(t?.saved_rejections)}`} purple />
      <Stat icon={<Users size={18} />} label="Team members" value={users.length} sub={`${employees.length} employees, ${users.length - employees.length} finance (incl. owner)`} />
    </div>
    <div className="finance-grid">
      <section className="panel"><div className="panel-heading"><div><h2>Spend by category</h2><p>Claimed versus paid</p></div></div>
        {!dashboard?.byCategory?.length ? <Empty icon={<Banknote size={22} />} title="No spend yet" text="The breakdown appears after the first claim." />
          : <div className="category-breakdown">{dashboard.byCategory.map(c => <div className="category-stat" key={c.category}>
            <div className="category-line"><span>{c.category}</span><strong>{money(c.claimed)}</strong></div>
            <div className="bar-track"><div className="bar-claimed" style={{ width: `${Math.max(3, c.claimed / Math.max(1, t.claimed) * 100)}%` }} />
              <div className="bar-approved" style={{ width: `${c.paid / Math.max(1, t.claimed) * 100}%` }} /></div>
            <div className="category-foot"><span>{c.count} claims</span><span>{money(c.paid)} paid</span></div></div>)}</div>}
        <div className="legend"><span><i className="legend-claimed" />Claimed</span><span><i className="legend-approved" />Paid</span></div></section>
      <section className="panel"><div className="panel-heading"><div><h2>Decision outcomes</h2><p>Final status across all claims</p></div></div>
        {!dashboard?.byStatus?.length ? <Empty icon={<Activity size={22} />} title="No decisions yet" text="Outcomes appear after the first claim." />
          : <div className="status-breakdown">{['Approved', 'Capped', 'Rejected'].map(s => {
            const d = dashboard.byStatus.find(x => x.status === s); const count = d?.count || 0; const total = t.count || 1;
            return <div className="status-stat" key={s}><div className="status-stat-top"><Status status={s} /><strong>{count}</strong></div>
              <div className="bar-track"><div className={`status-bar bar-${s.toLowerCase()}`} style={{ width: `${count / total * 100}%` }} /></div>
              <small>{Math.round(count / total * 100)}% of claims · {money(d?.claimed || 0)} claimed</small></div>;
          })}</div>}</section>
    </div>
    <div className="finance-grid">
      <section className="panel"><div className="panel-heading"><div><h2>All claims</h2><p>Select a claim to see its decision and audit trail</p></div><span className="count-pill">{expenses.length}</span></div>
        {selected && <DecisionCard expense={selected} logs={logs} onClose={() => setSelected(null)} />}
        {expenses.length === 0 ? <Empty icon={<ReceiptText size={22} />} title="No claims yet" text="Switch to an employee to submit one." />
          : <div className="scroll-list"><ExpenseList expenses={expenses} selected={selected} onOpen={openExpense} showEmployee /></div>}
      </section>
      <section className="panel"><div className="panel-heading"><div><h2>Pre-approvals</h2><p>Used by pre-approval rules and "unless pre-approved" exceptions in the policy below</p></div></div>
        <form className="field-grid inline-form" onSubmit={createPa}>
          <label>Employee<select value={pa.employee_id} onChange={e => setPa({ ...pa, employee_id: e.target.value })} required>
            <option value="">Choose…</option>{employees.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          <label>Type<select value={pa.expense_type} onChange={e => setPa({ ...pa, expense_type: e.target.value })}>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="wide-field">Description<input value={pa.description} onChange={e => setPa({ ...pa, description: e.target.value })} placeholder="e.g. Sales conference, return flight to Melbourne" required /></label>
          <label>Up to<input type="number" min="1" step="0.01" value={pa.max_amount} onChange={e => setPa({ ...pa, max_amount: e.target.value })} required /></label>
          <label>Currency<select value={pa.currency} onChange={e => setPa({ ...pa, currency: e.target.value })}>{CURRENCIES.map(c => <option key={c}>{c}</option>)}</select></label>
          {allowable.length > 0 && <div className="wide-field"><span className="mini-label">Also allows (banned unless pre-approved)</span>
            <div className="type-picker">{allowable.map(r => {
              const on = pa.allows.includes(r.params.item);
              return <label key={r.section} className={on ? 'picked' : ''}><input type="checkbox" checked={on}
                onChange={e => setPa({ ...pa, allows: e.target.checked ? [...pa.allows, r.params.item] : pa.allows.filter(x => x !== r.params.item) })} />{r.title} (§{r.section})</label>;
            })}</div></div>}
          <button className="button button-dark wide-field" type="submit">Record pre-approval</button>
        </form>
        {preapprovals.length > 0 && <div className="scroll-list"><PreapprovalList rows={preapprovals} showEmployee /></div>}
      </section>
    </div>
    <div className="team-row"><TeamPanel {...{ user, users, workspace, loadPeople, setError, setToast }} /></div>
    <section className="panel audit-panel"><div className="panel-heading"><div><h2>Recent audit activity</h2><p>Every extraction, correction and decision</p></div><span className="count-pill">{dashboard?.logs?.length || 0} events</span></div>
      {!dashboard?.logs?.length ? <Empty icon={<Activity size={22} />} title="Audit log is empty" text="Events appear here as claims are submitted." />
        : <div className="table-wrap"><table><thead><tr><th>Event</th><th>Expense</th><th>Actor</th><th>Details</th><th>Time</th></tr></thead><tbody>
          {dashboard.logs.map(l => <tr key={l.id}>
            <td><span className="event-icon"><Activity size={14} /></span><strong>{l.action.replaceAll('_', ' ')}</strong></td>
            <td><strong>{l.vendor}</strong><small>{l.employee_name} · {money(l.claimed_amount, l.currency)}</small></td>
            <td><span className="actor-tag">{users.find(u => u.id === l.actor)?.name || l.actor}</span></td>
            <td className="details-cell">{summariseLog(l)}</td>
            <td className="time-cell">{new Date(l.timestamp).toLocaleString()}</td></tr>)}
        </tbody></table></div>}</section>
    <PolicyManager {...{ user, policy, refresh, setError, setToast }} />
  </div>;
}

const RULE_TYPE_LABEL = { cap: 'Spending cap', prohibited_item: 'Banned item', preapproval_required: 'Needs pre-approval', receipt_age: 'Receipt age limit', duplicate: 'Duplicate check' };
const EDITABLE = { cap: 'limit', preapproval_required: 'threshold', receipt_age: 'max_days' };
const PER_LABEL = { person: 'per person', trip: 'per trip', claim: 'per claim' };
const sourceLabel = (s) => !s || s === 'seed' ? 'Starter policy' : s === 'manual' ? 'Added by finance' : s.startsWith('pdf:') ? `From ${s.slice(4)}` : s;
const EMPTY_RULE = { rule_type: 'cap', title: '', section: '', category: 'Meals', expense_types: [], per: 'person', limit: '', item: '', keywords: '', threshold: '', max_days: '', allow_preapproval: false };

function TypePicker({ value, onChange }) {
  return <div className="type-picker">{Object.entries(TYPE_LABEL).map(([k, v]) =>
    <label key={k} className={value.includes(k) ? 'picked' : ''}><input type="checkbox" checked={value.includes(k)}
      onChange={e => onChange(e.target.checked ? [...value, k] : value.filter(x => x !== k))} />{v}</label>)}</div>;
}

function PolicyManager({ user, policy, refresh, setError, setToast }) {
  const [presets, setPresets] = useState([]);
  const [edits, setEdits] = useState({});
  const [busy, setBusy] = useState('');
  // The last PDF import or "clear all", shown with an Undo button until dismissed.
  const [result, setResult] = useState(null);
  const [showAdd, setShowAdd] = useState(false), [form, setForm] = useState(EMPTY_RULE);
  useEffect(() => { api('/api/policy/presets').then(setPresets).catch(() => {}); }, []);

  const run = async (key, fn, done) => {
    setError(''); setBusy(key);
    try { await fn(); if (done) setToast(done); await refresh(); }
    catch (err) { setError(err.message); }
    finally { setBusy(''); }
  };
  const put = (section, body) => jsonPost(`/api/policy/${section}`, { ...body }, 'PUT');
  const enabledCount = policy.filter(p => p.enabled).length;
  // These rule types can exist once; the form offers them only when missing.
  const single = { duplicate: policy.some(p => p.rule_type === 'duplicate'), receipt_age: policy.some(p => p.rule_type === 'receipt_age') };

  const togglePreset = (preset, rule, on) => run(`preset-${preset.item}`,
    () => rule ? put(rule.section, { enabled: on }) : jsonPost('/api/policy', { preset: preset.item }),
    `${preset.title} ${on ? 'banned' : 'allowed'}`);
  const toggleRule = (p, on) => run(`toggle-${p.section}`, () => put(p.section, { enabled: on }), `Section ${p.section} turned ${on ? 'on' : 'off'}`);
  const saveAmount = (p) => run(`amount-${p.section}`, async () => { await put(p.section, { value: edits[p.section] }); setEdits({ ...edits, [p.section]: undefined }); }, `Section ${p.section} updated`);
  const remove = (p) => {
    if (!window.confirm(`Delete section ${p.section} (${p.title})? Past decisions keep their citations.`)) return;
    run(`delete-${p.section}`, () => api(`/api/policy/${p.section}`, { method: 'DELETE' }), `Section ${p.section} deleted`);
  };

  const readPdf = (file) => {
    if (!file) return;
    setResult(null);
    run('import', async () => {
      const fd = new FormData();
      fd.append('policy', file);
      const r = await api('/api/policy/import', { method: 'POST', body: fd });
      setResult({ kind: 'import', ...r });
      setToast(`Policy updated: ${r.added.length} added, ${r.updated.length} updated`);
    });
  };
  const clearAll = () => {
    if (!window.confirm(`Clear all ${policy.length} rules? Until you add rules again, every claim will be approved in full. You can undo this.`)) return;
    run('clear', async () => {
      const r = await api(`/api/policy`, { method: 'DELETE' });
      setResult({ kind: 'clear', ...r });
    }, 'All rules cleared');
  };
  const undo = () => run('undo', async () => {
    const r = await jsonPost('/api/policy/restore', { snapshot_id: result.snapshot_id });
    setResult(null);
    setToast(`Undone: ${r.restored} rules restored`);
  });

  const setF = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const addRule = (e) => {
    e.preventDefault();
    run('add', async () => {
      const { section, ...rule } = form;
      const saved = await jsonPost('/api/policy', { section, rule });
      setForm(EMPTY_RULE); setShowAdd(false);
      setToast(`Section ${saved.section} added`);
    });
  };

  return <section className="panel policy-panel">
    <div className="panel-heading"><div><h2>Knowledge base: expense policy</h2><p>The Auditor checks every claim against the rules that are switched on. Changes take effect immediately.</p></div>
      <div className="policy-actions">
        <span className="ai-chip"><ShieldCheck size={13} /> {enabledCount} of {policy.length} on</span>
        <label className="button button-dark">
          {busy === 'import' ? <LoaderCircle className="spin" size={14} /> : <FileUp size={14} />}{busy === 'import' ? 'Reading PDF…' : 'Upload policy PDF'}
          <input type="file" accept="application/pdf" hidden disabled={busy === 'import'} onChange={e => { readPdf(e.target.files?.[0]); e.target.value = ''; }} /></label>
        <button className="button button-primary" onClick={() => setShowAdd(!showAdd)}><Plus size={14} />Add rule</button>
        <button className="button button-danger" onClick={clearAll} disabled={!policy.length || busy === 'clear'}>
          {busy === 'clear' ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}Clear all</button>
      </div></div>

    {result?.kind === 'clear' && <div className="import-preview undo-bar">
      <div><strong>All {result.cleared} rules cleared.</strong><p>Every claim is approved in full until you add rules or upload a policy PDF.</p></div>
      <div className="import-foot"><button className="button button-dark" onClick={undo} disabled={busy === 'undo'}>Undo</button>
        <button className="button button-ghost" onClick={() => setResult(null)}>Dismiss</button></div>
    </div>}

    {result?.kind === 'import' && <div className="import-preview">
      <div className="import-head"><div><strong>Policy updated from {result.filename}</strong>
        <p>{result.added.length} added · {result.updated.length} updated · {result.unchanged.length} already up to date. {result.method === 'claude' ? 'Read by Claude.' : 'Read by the built-in policy reader.'} Rules the PDF doesn't mention were left as they were.</p></div>
        <button className="icon-button" onClick={() => setResult(null)} aria-label="Close summary"><XCircle size={17} /></button></div>
      {result.notes?.map((n, i) => <p className="field-help" key={i}>{n}</p>)}
      <div className="import-list">{result.rules.filter(r => r.action !== 'unchanged').map((r, i) => <div className="import-row" key={i}>
        <div><div className="import-tags">
          <span className={`status ${r.action === 'new' ? 'status-approved' : 'status-capped'}`}>{r.action === 'new' ? `Added §${r.section}` : `Updated §${r.section}`}</span>
          <span className="actor-tag">{RULE_TYPE_LABEL[r.rule_type]}</span>
          {r.changes?.length > 0 && <span className="actor-tag">{r.changes.join(', ')}</span>}</div>
          <strong>{r.title}</strong><p>{r.body}</p>
          {r.source_text && <small>From the PDF{r.source_section ? ` (§${r.source_section})` : ''}: “{r.source_text}”</small>}
          {r.notes?.map((n, k) => <small className="import-note" key={k}>{n}</small>)}</div>
      </div>)}</div>
      {result.unchanged.length > 0 && <details className="audit-details"><summary>Already up to date ({result.unchanged.length})</summary>
        <ul className="check-list">{result.rules.filter(r => r.action === 'unchanged').map((r, i) => <li key={i}><b>§{r.section}</b> {r.title}</li>)}</ul></details>}
      {result.unmatched?.length > 0 && <details className="audit-details"><summary>Not turned into rules ({result.unmatched.length}). Add these by hand if they matter.</summary>
        <ul className="check-list">{result.unmatched.map((u, i) => <li key={i}>{u.section && <b>§{u.section} </b>}{u.text}</li>)}</ul></details>}
      <div className="import-foot"><button className="button button-dark" onClick={undo} disabled={busy === 'undo'}>
        {busy === 'undo' ? <LoaderCircle className="spin" size={14} /> : null}Undo this import</button>
        <button className="button button-ghost" onClick={() => setResult(null)}>Done</button></div>
    </div>}

    {showAdd && <form className="add-rule" onSubmit={addRule}>
      <div className="field-grid">
        <label>Rule type<select value={form.rule_type} onChange={setF('rule_type')}>
          {Object.entries(RULE_TYPE_LABEL).map(([k, v]) => <option key={k} value={k} disabled={single[k]}>{v}{single[k] ? ' (already in policy)' : ''}</option>)}</select></label>
        <label>Section number<input placeholder="Auto" value={form.section} onChange={setF('section')} /></label>
        {form.rule_type === 'cap' && <>
          <label>Applies to<select value={form.category} onChange={setF('category')}><option value="Any">Any category</option><option>Meals</option><option>Travel</option><option>Software</option><option>Other</option></select></label>
          <label>Cap ({BASE})<div className="cap-inputs"><input type="number" min="1" step="0.01" required value={form.limit} onChange={setF('limit')} />
            <select value={form.per} onChange={setF('per')}>{Object.entries(PER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div></label>
          <div className="wide-field"><span className="mini-label">Only these expense types (optional)</span><TypePicker value={form.expense_types} onChange={v => setForm({ ...form, expense_types: v })} /></div>
        </>}
        {form.rule_type === 'prohibited_item' && <>
          <label>Banned item<input required placeholder="e.g. gym memberships" value={form.item} onChange={setF('item')} /></label>
          <label>Words to look for on receipts<input placeholder="e.g. gym, fitness, membership" value={form.keywords} onChange={setF('keywords')} /></label>
          <label className="wide-field inline-check"><input type="checkbox" checked={form.allow_preapproval} onChange={e => setForm({ ...form, allow_preapproval: e.target.checked })} />
            Allow it when finance has recorded a pre-approval that covers it ("unless pre-approved")</label>
        </>}
        {form.rule_type === 'preapproval_required' && <>
          <label className="wide-field">Needs pre-approval when over ({BASE}, 0 = always)<input type="number" min="0" step="0.01" required value={form.threshold} onChange={setF('threshold')} /></label>
          <div className="wide-field"><span className="mini-label">For these expense types</span><TypePicker value={form.expense_types} onChange={v => setForm({ ...form, expense_types: v })} /></div>
        </>}
        {form.rule_type === 'receipt_age' &&
          <label className="wide-field">Reject receipts older than (days)<input type="number" min="1" max="3650" step="1" required value={form.max_days} onChange={setF('max_days')} /></label>}
        <label className="wide-field">Title (optional)<input placeholder="Generated from the rule if left blank" value={form.title} onChange={setF('title')} /></label>
      </div>
      <div className="import-foot"><button className="button button-primary" type="submit" disabled={busy === 'add'}>{busy === 'add' ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}Add to policy</button>
        <button type="button" className="button button-ghost" onClick={() => { setShowAdd(false); setForm(EMPTY_RULE); }}>Cancel</button></div>
    </form>}

    {presets.length > 0 && <div className="preset-block"><span className="mini-label">Common restrictions: tick to ban, untick to allow</span>
      <div className="preset-grid">{presets.map(pr => {
        const rule = policy.find(p => p.rule_type === 'prohibited_item' && p.params.item === pr.item);
        const on = Boolean(rule?.enabled);
        return <label key={pr.item} className={`preset ${on ? 'on' : ''}`} title={`Looks for: ${pr.keywords.slice(0, 8).join(', ')}…`}>
          <input type="checkbox" checked={on} disabled={busy === `preset-${pr.item}`} onChange={e => togglePreset(pr, rule, e.target.checked)} />
          <span>{pr.title}</span>{rule && <small>§{rule.section}</small>}</label>;
      })}</div></div>}

    <div className="policy-list">{policy.map(p => {
      const key = EDITABLE[p.rule_type];
      return <div className={`policy-item ${p.enabled ? '' : 'rule-off'}`} key={p.section}>
        <label className="switch" title={p.enabled ? 'On: enforced' : 'Off: not enforced'}>
          <input type="checkbox" checked={p.enabled} disabled={busy === `toggle-${p.section}`} onChange={e => toggleRule(p, e.target.checked)} aria-label={`Enforce section ${p.section}`} /><span /></label>
        <span className="policy-number">{p.section}</span><div className="policy-body">
          <div className="policy-title"><strong>{p.title}</strong>{!p.enabled && <span className="status status-processing">Off</span>}
            <button className="icon-button rule-delete" onClick={() => remove(p)} aria-label={`Delete section ${p.section}`} title="Delete rule"><Trash2 size={13} /></button></div>
          <p>{p.body}</p>
          {p.rule_type === 'prohibited_item' && <label className="inline-check">
            <input type="checkbox" checked={Boolean(p.params.allow_preapproval)} disabled={busy === `allow-${p.section}`}
              onChange={e => run(`allow-${p.section}`, () => put(p.section, { allow_preapproval: e.target.checked }),
                e.target.checked ? `${p.title}: allowed with a pre-approval` : `${p.title}: no exceptions`)} />
            Allow with a pre-approval</label>}
          <div className="import-tags"><span className="actor-tag">{RULE_TYPE_LABEL[p.rule_type] || p.rule_type}</span><span className="actor-tag">{sourceLabel(p.source)}</span></div>
          {key && <div className="rule-edit">
            <label>{key === 'limit' ? `Cap (${BASE}, ${PER_LABEL[p.params.per] || 'per claim'})` : key === 'max_days' ? 'Days' : `Threshold (${BASE})`}
              <input type="number" min={key === 'threshold' ? 0 : 1} step="1" value={edits[p.section] ?? p.params[key]} onChange={e => setEdits({ ...edits, [p.section]: e.target.value })} /></label>
            {edits[p.section] !== undefined && Number(edits[p.section]) !== p.params[key] && <button className="button button-dark" onClick={() => saveAmount(p)}>Save</button>}
          </div>}
        </div></div>;
    })}</div>
    {policy.length === 0 && <Empty icon={<ShieldCheck size={22} />} title="No rules yet" text="Upload your policy PDF or add rules one by one. Until then every claim is approved in full." />}
  </section>;
}

function summariseLog(l) {
  const d = l.details;
  if (!d || typeof d !== 'object') return String(d ?? '');
  switch (l.action) {
    case 'receipt_extracted': return `${d.vendor}, ${d.date}, ${d.currency} ${d.claimed_amount}, ${d.category}${d.attendees > 1 ? `, ${d.attendees} people` : ''} (${METHOD_LABEL[d.method] || d.method})${d.notes?.length ? ` · ${d.notes.join(' ')}` : ''}`;
    case 'policy_evaluated': return d.checks.filter(c => c.outcome !== 'n/a').map(c => `§${c.section} ${c.outcome}`).join(', ');
    case 'decision_finalised': return `${d.status}: ${d.currency} ${d.approved_amount} of ${d.claimed_amount}. ${d.policy_citation}`;
    case 'fields_corrected_by_employee': return Object.entries(d).map(([k, v]) => `${k}: ${v.extracted ?? '—'} → ${v.corrected}`).join('; ');
    case 'preapproval_consumed': return `Used ${d.preapproval_id}`;
    default: return JSON.stringify(d);
  }
}

createRoot(document.getElementById('root')).render(<App />);
