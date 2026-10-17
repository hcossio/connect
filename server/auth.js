// Sign-in for the people allowed to start meetings. There are no sign-ups:
// the one account comes from ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_PASSWORD,
// and its password can then be changed from the admin page. Sessions are
// signed cookies.
const crypto = require('crypto');
const store = require('./store');

const COOKIE = 'da_session';
const SESSION_DAYS = 30;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}
function checkPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

// Setting ADMIN_PASSWORD to a new value (on Railway, say) also resets the
// password, which is the way back in if it's forgotten.
const seed = process.env.ADMIN_PASSWORD && crypto.createHash('sha256').update(process.env.ADMIN_PASSWORD).digest('hex');
if (seed && seed !== store.data.seed) {
  let admin = store.data.users.find((u) => u.role === 'admin');
  if (!admin) {
    admin = { id: 1, role: 'admin', ver: 0 };
    store.data.users.push(admin);
  }
  Object.assign(admin, {
    username: process.env.ADMIN_USERNAME || admin.username || 'marcah',
    email: process.env.ADMIN_EMAIL || admin.email || 'hc@marcah.com',
    ver: admin.ver + 1,
    ...hashPassword(process.env.ADMIN_PASSWORD),
  });
  store.data.seed = seed;
  store.save();
} else if (!store.data.users.length) console.warn('No accounts yet: set ADMIN_PASSWORD so someone can sign in and start meetings.');

const sign = (s) => crypto.createHmac('sha256', store.data.secret).update(s).digest('base64url');

function issue(res, req, user) {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const value = `${user.id}.${user.ver}.${exp}`;
  res.cookie(COOKIE, `${value}.${sign(value)}`, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 86_400_000, path: '/',
  });
}

/** The signed-in user for a request (Express or a raw upgrade request), or null. */
function userFrom(req) {
  const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const parts = decodeURIComponent(raw.slice(COOKIE.length + 1)).split('.');
  if (parts.length !== 4) return null;
  const [id, ver, exp, mac] = parts;
  const expected = sign(`${id}.${ver}.${exp}`);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  if (Number(exp) < Date.now()) return null;
  const user = store.data.users.find((u) => u.id === Number(id));
  return user && user.ver === Number(ver) ? user : null; // a password change signs everyone out
}

// Slow down password guessing: a few tries per address every 15 minutes.
const attempts = new Map();
function tooManyTries(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60_000);
  attempts.set(ip, list);
  return list.length >= 10;
}

function routes(app, express) {
  const json = express.json({ limit: '10kb' });

  app.get('/api/me', (req, res) => {
    const u = userFrom(req);
    res.json({ user: u && { username: u.username, email: u.email, role: u.role, displayName: u.displayName || '' } });
  });

  app.post('/api/login', json, (req, res) => {
    if (tooManyTries(req.ip)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
    const login = String(req.body?.login || '').trim().toLowerCase();
    const user = store.data.users.find((u) => u.username.toLowerCase() === login || u.email.toLowerCase() === login);
    if (!user || !checkPassword(user, req.body?.password || '')) {
      attempts.get(req.ip).push(Date.now());
      return res.status(401).json({ error: 'That username or password is not right.' });
    }
    issue(res, req, user);
    res.json({ ok: true });
  });

  app.post('/api/logout', (_req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.post('/api/profile', json, (req, res) => {
    const user = userFrom(req);
    if (!user) return res.status(401).json({ error: 'Sign in first.' });
    const username = String(req.body?.username ?? user.username).trim();
    const email = String(req.body?.email ?? user.email).trim();
    const displayName = String(req.body?.displayName ?? user.displayName ?? '').trim().slice(0, 40);
    if (!/^[a-z0-9_.-]{3,32}$/i.test(username)) return res.status(400).json({ error: 'Usernames are 3 to 32 letters, numbers, dots, dashes or underscores.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'That email doesn\'t look right.' });
    Object.assign(user, { username, email, displayName });
    store.save();
    res.json({ ok: true });
  });

  app.post('/api/password', json, (req, res) => {
    const user = userFrom(req);
    if (!user) return res.status(401).json({ error: 'Sign in first.' });
    if (!checkPassword(user, req.body?.current || '')) return res.status(400).json({ error: 'Your current password is not right.' });
    const next = String(req.body?.next || '');
    if (next.length < 10) return res.status(400).json({ error: 'Use at least 10 characters.' });
    Object.assign(user, hashPassword(next), { ver: user.ver + 1 });
    store.save();
    issue(res, req, user); // keep this browser signed in
    res.json({ ok: true });
  });
}

/** Express middleware for admin-only routes. */
function requireAdmin(req, res, next) {
  const u = userFrom(req);
  if (u?.role === 'admin') return next();
  if (req.accepts('html') && req.method === 'GET' && !req.path.startsWith('/api/')) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  res.status(401).json({ error: 'Sign in first.' });
}

module.exports = { routes, userFrom, requireAdmin };
