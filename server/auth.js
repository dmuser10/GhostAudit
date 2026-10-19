// Sign-in: password hashing, database-backed sessions and the session cookie.
// Uses only Node's built-in crypto (no native modules), so it adds nothing to
// the build or to memory on small hosts.

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'ga_session';
const SESSION_DAYS = 30;
const DAY = 86400000;

// Stored as scrypt$N$r$p$salt$hash so the cost can be raised later without breaking old hashes.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const key = await scrypt(String(password), salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(key, expected);
}

function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < 8) return 'Password must be at least 8 characters.';
  if (p.length > 200) return 'Password is too long.';
  return null;
}

// The cookie holds a random token; the database stores only its SHA-256, so a
// leaked Sessions table can't be used to sign in.
const tokenId = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function createSession(db, userId, activeOrgId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.run('DELETE FROM Sessions WHERE expires_at < now()'); // tidy up while we're here
  await db.run('INSERT INTO Sessions (id,user_id,active_org_id,expires_at) VALUES (?,?,?,?)',
    [tokenId(token), userId, activeOrgId || null, new Date(Date.now() + SESSION_DAYS * DAY).toISOString()]);
  return token;
}

function readToken(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setCookie(req, res, token) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
function clearCookie(req, res) {
  res.append('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${req.secure ? '; Secure' : ''}`);
}

// Slows down password guessing: 10 failed sign-ins per email + IP in 15 minutes.
const failures = new Map();
const WINDOW = 15 * 60000, MAX_FAILURES = 10;
function loginBlocked(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW) { failures.delete(key); return false; }
  return f.count >= MAX_FAILURES;
}
function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW) failures.set(key, { count: 1, first: Date.now() });
  else f.count++;
  if (failures.size > 5000) failures.clear(); // keep memory bounded
}
const clearFailures = (key) => failures.delete(key);

module.exports = {
  COOKIE, SESSION_DAYS, DAY, hashPassword, verifyPassword, passwordProblem, tokenId, createSession,
  readToken, setCookie, clearCookie, loginBlocked, recordFailure, clearFailures
};
