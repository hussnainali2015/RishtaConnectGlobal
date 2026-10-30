'use strict';
/**
 * Rishta Connect Global - backend (Node 18+)
 * Google/Apple sign-in, profile storage, Moyasar checkout, webhook, refunds, admin API.
 * Payment rule: a profile is ACTIVE only when a membership row has expires_at in the
 * future, and a membership is only ever created by a gateway-confirmed payment.
 */
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { OAuth2Client } = require('google-auth-library');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const { runBackup } = require('./backup');

const E = process.env;
for (const k of ['BASE_URL', 'JWT_SECRET', 'GOOGLE_CLIENT_ID', 'MOYASAR_PUBLISHABLE_KEY', 'MOYASAR_SECRET_KEY', 'MOYASAR_WEBHOOK_SECRET']) {
  if (!E[k]) { console.error('Missing environment variable: ' + k); process.exit(1); }
}
if (E.JWT_SECRET.length < 32) { console.error('JWT_SECRET must be at least 32 characters'); process.exit(1); }

const BK = { on: E.BACKUP_ENABLED === 'true', dir: path.resolve(E.BACKUP_DIR || path.join(__dirname, 'backups')), keep: parseInt(E.BACKUP_KEEP, 10) || 14, at: /^([01]\d|2[0-3]):[0-5]\d$/.test(E.BACKUP_AT || '') ? E.BACKUP_AT : '00:30', copy: E.BACKUP_COPY_DIR || '' }; // BACKUP_AT is UTC
if (BK.on && !/^[0-9a-f]{64}$/i.test(E.BACKUP_KEY || '')) { console.error('BACKUP_ENABLED is true but BACKUP_KEY is missing. Generate one with: openssl rand -hex 32'); process.exit(1); }
const CUR = E.CURRENCY || 'SAR';
// Moyasar. The publishable key may reach the browser; the secret key and webhook secret never leave this server.
const MZ = { base: 'https://api.moyasar.com/v1', pk: E.MOYASAR_PUBLISHABLE_KEY, sk: E.MOYASAR_SECRET_KEY, hook: E.MOYASAR_WEBHOOK_SECRET };
const mzMode = (k, kind) => (new RegExp('^' + kind + '_(test|live)_[A-Za-z0-9_-]{10,}$').exec(k || '') || [])[1];
MZ.mode = mzMode(MZ.pk, 'pk');
if (!MZ.mode || mzMode(MZ.sk, 'sk') !== MZ.mode) { console.error('MOYASAR_PUBLISHABLE_KEY must start with pk_test_ or pk_live_, and MOYASAR_SECRET_KEY with sk_test_ or sk_live_ of the SAME mode.'); process.exit(1); }
if (String(MZ.hook).length < 16) { console.error('MOYASAR_WEBHOOK_SECRET must be at least 16 characters (openssl rand -hex 24).'); process.exit(1); }
if (MZ.mode === 'test') console.warn('Moyasar is in TEST mode: no real money will move.');
const PLANS = { // prices live on the server only; the browser sends just the plan id
  basic: { name: 'Basic Plan', price: 29, months: 1 },
  prem: { name: 'Premium Plan', price: 69, months: 3 },
  plus: { name: 'Premium Plus', price: 119, months: 6 },
};
const admins = new Set((E.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

/* ---------- database ---------- */
const db = new Database(E.DB_FILE || path.join(__dirname, 'rishta.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(email TEXT PRIMARY KEY, name TEXT, provider TEXT, profile_json TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS payments(
  id TEXT PRIMARY KEY, email TEXT NOT NULL, plan TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL,
  status TEXT NOT NULL, tran_ref TEXT, refund_ref TEXT, created_at TEXT, paid_at TEXT, refunded_at TEXT);
CREATE INDEX IF NOT EXISTS pay_ref ON payments(tran_ref);
CREATE TABLE IF NOT EXISTS memberships(email TEXT PRIMARY KEY, plan TEXT, expires_at TEXT);
CREATE TABLE IF NOT EXISTS verification(email TEXT PRIMARY KEY, identity INTEGER DEFAULT 0, photo INTEGER DEFAULT 0, background INTEGER DEFAULT 0, revoked_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS member_status(email TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS brokers(email TEXT PRIMARY KEY, profile_json TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS conversations(id INTEGER PRIMARY KEY AUTOINCREMENT, u1 TEXT NOT NULL, u2 TEXT NOT NULL, created_at TEXT, UNIQUE(u1,u2));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id INTEGER NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT);
CREATE INDEX IF NOT EXISTS msg_conv ON messages(conv_id,id);
CREATE TABLE IF NOT EXISTS conv_reads(conv_id INTEGER, email TEXT, last_id INTEGER DEFAULT 0, PRIMARY KEY(conv_id,email));
CREATE TABLE IF NOT EXISTS uid_map(uid TEXT PRIMARY KEY, email TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blocks(blocker TEXT NOT NULL, blocked TEXT NOT NULL, created_at TEXT, PRIMARY KEY(blocker,blocked));
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT, reporter TEXT NOT NULL, reported TEXT NOT NULL, category TEXT NOT NULL, details TEXT, evidence_json TEXT,
  status TEXT NOT NULL DEFAULT 'open', outcome TEXT, admin_note TEXT, resolved_by TEXT, created_at TEXT, resolved_at TEXT);
CREATE INDEX IF NOT EXISTS rep_status ON reports(status,created_at);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, kind TEXT, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT, read_at TEXT);
CREATE INDEX IF NOT EXISTS notif_user ON notifications(email,read_at,id);
CREATE TABLE IF NOT EXISTS warnings(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, report_id INTEGER, category TEXT, message TEXT NOT NULL, created_by TEXT, status TEXT NOT NULL DEFAULT 'active', acknowledged_at TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS warn_user ON warnings(email,status);
CREATE TABLE IF NOT EXISTS appeals(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, kind TEXT NOT NULL, ref_id INTEGER, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  original_admin TEXT, admin_note TEXT, decided_by TEXT, created_at TEXT, resolved_at TEXT);
CREATE INDEX IF NOT EXISTS appeal_state ON appeals(status,created_at);
CREATE TABLE IF NOT EXISTS backup_log(id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, finished_at TEXT, status TEXT, trigger TEXT, files TEXT, bytes INTEGER, audit_rows INTEGER, error TEXT);
CREATE TABLE IF NOT EXISTS webhook_events(id TEXT PRIMARY KEY, type TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, admin TEXT, action TEXT, payment_id TEXT, reason TEXT, at TEXT);
CREATE INDEX IF NOT EXISTS audit_action ON audit(action,id);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;
`);
const now = () => new Date().toISOString();
// Upgrade databases created before reports recorded where they came from.
// Sign in with Apple: Apple's stable per-app user id, so a returning member is found even if Apple stops sending the email.
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'apple_sub')) db.exec('ALTER TABLE users ADD COLUMN apple_sub TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_apple ON users(apple_sub) WHERE apple_sub IS NOT NULL');
if (!db.prepare('PRAGMA table_info(reports)').all().some(c => c.name === 'source')) db.exec('ALTER TABLE reports ADD COLUMN source TEXT');
const addMonths = (d, m) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; };

/* ---------- Moyasar client (secret key, server only) ---------- */
async function mzCall(method, endpoint, body) {
  const r = await fetch(MZ.base + endpoint, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(MZ.sk + ':').toString('base64') },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || 'Moyasar request failed (' + r.status + ')');
  return j;
}
const MZ_ID = /^[0-9a-fA-F-]{36}$/; // Moyasar payment ids are UUIDs; anything else never reaches a URL
const CART = /^RC-[0-9a-f-]{36}$/;
const cartOf = q => (q.metadata && q.metadata.cart) || ((String(q.description || '').match(/\[(RC-[0-9a-f-]{36})\]/) || [])[1]) || null;

/* ---------- payment state changes (all idempotent) ---------- */
const settle = db.transaction((p, ref) => {
  const r = db.prepare("UPDATE payments SET status='paid', tran_ref=?, paid_at=? WHERE id=? AND status IN ('pending','failed')").run(ref, now(), p.id);
  if (!r.changes) return; // already processed: a repeated webhook does nothing
  const m = db.prepare('SELECT expires_at FROM memberships WHERE email=?').get(p.email);
  const base = m && new Date(m.expires_at) > new Date() ? new Date(m.expires_at) : new Date();
  const exp = addMonths(base, PLANS[p.plan].months).toISOString();
  db.prepare('INSERT INTO memberships(email,plan,expires_at) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET plan=excluded.plan, expires_at=excluded.expires_at').run(p.email, p.plan, exp);
  // Automatic approval: a confirmed payment also approves a member who was waiting for review (REQUIRE_APPROVAL=true).
  // A suspended member is never changed by paying.
  if (E.AUTO_APPROVE_ON_PAYMENT !== 'false') {
    const st = db.prepare('SELECT status FROM member_status WHERE email=?').get(p.email);
    if (st && st.status === 'pending') {
      db.prepare("UPDATE member_status SET status='approved', reason=NULL, updated_at=? WHERE email=?").run(now(), p.email);
      audit('system', 'auto-approve-on-payment', p.email, 'payment ' + p.id);
    }
  }
  notify(p.email, 'payment', 'Payment received. Your profile is active', PLANS[p.plan].name + ' is active until ' + new Date(exp).toLocaleDateString('en-GB') + '.');
});
const markRefunded = db.transaction((origRef, refundRef) => {
  const p = db.prepare('SELECT * FROM payments WHERE tran_ref=?').get(origRef);
  if (!p || p.status === 'refunded') return;
  db.prepare("UPDATE payments SET status='refunded', refund_ref=?, refunded_at=? WHERE id=?").run(refundRef, now(), p.id);
  const m = db.prepare('SELECT expires_at FROM memberships WHERE email=?').get(p.email);
  if (m) db.prepare('UPDATE memberships SET expires_at=? WHERE email=?').run(addMonths(m.expires_at, -PLANS[p.plan].months).toISOString(), p.email);
});

/** Never trust a redirect or a webhook body. Take only the payment id, fetch the real payment from Moyasar with the secret key,
 *  and compare status, amount, currency and our own cart id with what we recorded when checkout started. */
async function reconcile(mzId, expectCart) {
  if (!MZ_ID.test(String(mzId || ''))) return;
  const q = await mzCall('GET', '/payments/' + encodeURIComponent(mzId));
  const cart = cartOf(q);
  if (!cart || !CART.test(cart) || (expectCart && cart !== expectCart)) { console.error('Moyasar payment not matched to a checkout:', q.id); return; }
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(cart);
  if (!p) return;
  if (q.status === 'refunded') {
    if (typeof q.refunded === 'number' && q.refunded < q.amount) return; // partial refunds do not end a membership
    if (p.tran_ref === q.id) markRefunded(q.id, q.id);
    return;
  }
  if (q.status === 'failed') { db.prepare("UPDATE payments SET status='failed' WHERE id=? AND status='pending'").run(p.id); return; }
  if (q.status !== 'paid') return; // initiated (still in 3-D Secure), authorized, voided...: nothing to activate
  if (q.currency !== p.currency || q.amount !== Math.round(p.amount * 100) || (p.tran_ref && p.tran_ref !== q.id)
      || db.prepare('SELECT 1 FROM payments WHERE tran_ref=? AND id<>?').get(q.id, p.id)) {
    console.error('Payment mismatch, not activated:', p.id, q.id); return;
  }
  settle(p, q.id);
}

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"],
  // 'unsafe-inline' is needed only because the prototype keeps its script inline. Move it to a file and remove this.
  scriptSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com', 'https://appleid.cdn-apple.com', 'https://cdn.moyasar.com'],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com', 'https://cdn.moyasar.com'],
  fontSrc: ['https://fonts.gstatic.com', 'https://*.moyasar.com'], imgSrc: ["'self'", 'data:', 'https://*.moyasar.com'],
  frameSrc: ['https://accounts.google.com', 'https://appleid.apple.com', 'https://*.moyasar.com'], connectSrc: ["'self'", 'https://accounts.google.com', 'https://appleid.apple.com', 'https://api.moyasar.com'],
  formAction: ["'self'", 'https://*.moyasar.com', 'https://appleid.apple.com'],
} } }));
app.use(cookieParser());

// Webhook first: no cookies and no CSRF header (Moyasar calls it). Set the same secret in the Moyasar dashboard webhook.
const same = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
app.post('/api/moyasar/webhook', express.raw({ type: '*/*', limit: '200kb' }), async (req, res) => {
  let ev;
  try { ev = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  if (!ev || !same(ev.secret_token || '', MZ.hook)) return res.sendStatus(401);
  if (typeof ev.live === 'boolean' && ev.live !== (MZ.mode === 'live')) return res.sendStatus(200); // an event from the other mode
  try {
    const eid = ev.id ? String(ev.id).slice(0, 80) : null;
    if (eid && db.prepare('SELECT 1 FROM webhook_events WHERE id=?').get(eid)) return res.sendStatus(200); // already handled
    if (/^payment_/.test(String(ev.type)) && ev.data && ev.data.id) await reconcile(ev.data.id); // only the id is used; the payment is re-fetched
    if (eid) db.prepare('INSERT OR IGNORE INTO webhook_events(id,type,at) VALUES(?,?,?)').run(eid, String(ev.type).slice(0, 40), now());
    res.sendStatus(200);
  } catch (e) { console.error('webhook failed:', e.message); res.sendStatus(500); } // a non-2xx makes Moyasar retry
});

// The customer lands here after the card form (and 3-D Secure). Moyasar adds ?id=<payment id>. We verify it right away so
// activation does not wait for the webhook, then show the status page. The redirect itself is never trusted.
const returnLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
app.get('/payment/return/:cart', returnLimit, async (req, res) => {
  const cart = CART.test(String(req.params.cart)) ? String(req.params.cart) : '';
  if (cart) { try { await reconcile(req.query.id, cart); } catch (e) { console.error('return check failed:', e.message); } } // the webhook is the backup
  res.redirect(303, '/?payment=' + encodeURIComponent(cart));
});

app.use(express.json({ limit: '50kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));

const csrf = (req, res, next) => req.get('x-requested-with') === 'fetch' ? next() : res.status(403).json({ error: 'Bad request' });
function issue(res, email) {
  res.cookie('rcg_session', jwt.sign({ email }, E.JWT_SECRET, { expiresIn: '7d' }),
    { httpOnly: true, secure: E.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 864e5 });
}
function auth(req, res, next) {
  try {
    const { email } = jwt.verify(req.cookies.rcg_session || '', E.JWT_SECRET);
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!u) throw new Error('no user');
    u.status = mstatus(email);
    if (u.status === 'suspended' && !/^\/api\/(me|notifications|appeals)(\/|\?|$)/.test(req.originalUrl)) return res.status(403).json({ error: 'Your account is suspended. Contact support for help.' });
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Sign in required' }); }
}
const adminOnly = (req, res, next) => admins.has(req.user.email) ? next() : res.status(403).json({ error: 'Admin only' });
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Try again.' }); });

/* --- sign-in (Google). Apple: verify the identity token the same way, e.g. with the apple-signin-auth package --- */
const google = new OAuth2Client(E.GOOGLE_CLIENT_ID);
app.post('/api/auth/google', csrf, wrap(async (req, res) => {
  let p;
  try { p = (await google.verifyIdToken({ idToken: String(req.body.credential || ''), audience: E.GOOGLE_CLIENT_ID })).getPayload(); }
  catch { return res.status(401).json({ error: 'Google sign-in failed' }); }
  if (!p.email || !p.email_verified) return res.status(401).json({ error: 'Email not verified' });
  const email = p.email.toLowerCase();
  db.prepare("INSERT INTO users(email,name,provider,created_at) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name").run(email, p.name || '', 'google', now());
  issue(res, email); res.json({ ok: true });
}));
app.post('/api/auth/logout', csrf, (req, res) => { res.clearCookie('rcg_session'); res.json({ ok: true }); });

/* --- Sign in with Apple. We only verify Apple's signed identity token, so no Apple client secret or private key is needed. --- */
const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
const nonceCookie = { httpOnly: true, secure: E.NODE_ENV === 'production', sameSite: 'lax', maxAge: 10 * 60 * 1000 };
app.get('/api/auth/apple/nonce', (req, res) => { // a fresh one-time value tied to this browser; Apple echoes it back inside the token
  const n = crypto.randomBytes(16).toString('hex');
  res.cookie('rcg_nonce', jwt.sign({ n }, E.JWT_SECRET, { expiresIn: '10m' }), nonceCookie);
  res.json({ nonce: n });
});
app.all('/auth/apple/callback', (req, res) => res.redirect(303, '/')); // registered Return URL; popup mode delivers the result by postMessage
app.post('/api/auth/apple', csrf, wrap(async (req, res) => {
  if (!E.APPLE_CLIENT_ID) return res.status(503).json({ error: 'Apple sign-in is not configured' });
  let c, n;
  try { c = (await jwtVerify(String((req.body && req.body.id_token) || ''), appleKeys, { issuer: 'https://appleid.apple.com', audience: E.APPLE_CLIENT_ID, algorithms: ['RS256'] })).payload; }
  catch { return res.status(401).json({ error: 'Apple sign-in failed' }); }
  try { n = jwt.verify(req.cookies.rcg_nonce || '', E.JWT_SECRET).n; } catch { return res.status(401).json({ error: 'Sign-in expired. Please try again.' }); }
  if (c.nonce !== n && c.nonce !== crypto.createHash('sha256').update(n).digest('hex')) return res.status(401).json({ error: 'Apple sign-in failed' }); // replayed or foreign token
  res.clearCookie('rcg_nonce');
  const sub = String(c.sub || ''), email = c.email ? String(c.email).toLowerCase() : null, verified = c.email_verified === true || c.email_verified === 'true';
  const name = s(req.body.name, 60); // Apple shares the name only the first time, and the browser supplies it
  if (!sub) return res.status(401).json({ error: 'Apple sign-in failed' });
  let u = db.prepare('SELECT * FROM users WHERE apple_sub=?').get(sub);
  if (!u) {
    if (!email || !verified) return res.status(401).json({ error: 'Apple did not share a verified email. In your Apple ID settings, stop using Sign in with Apple for this site, then try again.' });
    u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (u && u.apple_sub && u.apple_sub !== sub) return res.status(409).json({ error: 'This email is linked to a different Apple account.' });
    if (u) db.prepare('UPDATE users SET apple_sub=? WHERE email=?').run(sub, email); // same verified email as an existing member: same person
    else { db.prepare('INSERT INTO users(email,name,provider,apple_sub,created_at) VALUES(?,?,?,?,?)').run(email, name, 'apple', sub, now()); u = { email }; }
  }
  if (name) db.prepare("UPDATE users SET name=? WHERE email=? AND (name IS NULL OR name='')").run(name, u.email);
  issue(res, u.email); res.json({ ok: true });
}));

const membership = email => {
  const m = db.prepare('SELECT plan,expires_at FROM memberships WHERE email=?').get(email);
  return m ? { ...m, active: new Date(m.expires_at) > new Date() } : { active: false };
};
app.get('/api/me', auth, (req, res) => res.json({
  email: req.user.email, name: req.user.name, isAdmin: admins.has(req.user.email),
  profile: req.user.profile_json ? JSON.parse(req.user.profile_json) : null, membership: membership(req.user.email), verification: vstate(req.user.email), status: req.user.status, broker: binfo(req.user.email),
  unread: unreadCount(req.user.email), warnings: activeWarnings(req.user.email), appeal: openAppeals(req.user.email),
}));

/* --- profile: payment unlocks only after a valid profile exists --- */
const s = (v, max) => String(v || '').trim().slice(0, max);
app.post('/api/profile', auth, csrf, wrap(async (req, res) => {
  const b = req.body || {}, age = parseInt(b.a, 10);
  const prof = { n: s(b.n, 60), g: b.g === 'Male' ? 'Male' : 'Female', a: age, c: s(b.c, 60), m: s(b.m, 20), e: s(b.e, 60), j: s(b.j, 60), x: s(b.x, 400), w: s(b.w, 300) };
  if (!(age >= 18 && age <= 70) || !prof.n || !prof.c || !prof.e || !prof.j || !prof.x || !prof.w) return res.status(400).json({ error: 'Complete every field. Age must be 18 to 70.' });
  db.prepare('UPDATE users SET profile_json=? WHERE email=?').run(JSON.stringify(prof), req.user.email);
  db.prepare('INSERT OR IGNORE INTO verification(email,updated_at) VALUES(?,?)').run(req.user.email, now());
  if (E.REQUIRE_APPROVAL === 'true') db.prepare("INSERT OR IGNORE INTO member_status(email,status,updated_at) VALUES(?,'pending',?)").run(req.user.email, now()); // new profiles wait for an admin
  res.json({ ok: true });
}));

/* --- checkout --- */
app.post('/api/checkout', auth, csrf, wrap(async (req, res) => {
  const plan = PLANS[req.body && req.body.plan];
  if (!plan) return res.status(400).json({ error: 'Choose a plan' });
  if (!req.user.profile_json) return res.status(409).json({ error: 'Create your profile before paying' });
  const id = 'RC-' + crypto.randomUUID();
  db.prepare('INSERT INTO payments(id,email,plan,amount,currency,status,created_at) VALUES(?,?,?,?,?,?,?)').run(id, req.user.email, req.body.plan, plan.price, CUR, 'pending', now());
  // The card form runs in the browser with the publishable key. Everything the browser needs is returned here; the secret key is not.
  res.json({
    payment_id: id, amount: Math.round(plan.price * 100), currency: CUR, // Moyasar amounts are in halalas
    description: 'Rishta Connect Global - ' + plan.name + ' [' + id + ']', metadata: { cart: id },
    publishable_key: MZ.pk, callback_url: E.BASE_URL + '/payment/return/' + id,
  });
}));
app.get('/api/payments/:id', auth, (req, res) => {
  const p = db.prepare('SELECT id,plan,amount,currency,status FROM payments WHERE id=? AND email=?').get(req.params.id, req.user.email);
  p ? res.json(p) : res.status(404).json({ error: 'Not found' });
});

/* --- admin: transactions and refunds --- */
app.get('/api/admin/payments', auth, adminOnly, (req, res) =>
  res.json(db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT 200').all()));

app.post('/api/admin/payments/:id/refund', auth, adminOnly, csrf, wrap(async (req, res) => {
  const reason = s(req.body && req.body.reason, 200);
  if (reason.length < 3) return res.status(400).json({ error: 'Enter a refund reason' });
  // Claim the payment atomically so two clicks can never refund twice.
  const claim = db.prepare("UPDATE payments SET status='refunding' WHERE id=? AND status='paid'").run(req.params.id);
  if (!claim.changes) return res.status(409).json({ error: 'Only paid payments can be refunded' });
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  try {
    if (!MZ_ID.test(String(p.tran_ref || ''))) throw new Error('This payment has no Moyasar payment id');
    const r = await mzCall('POST', '/payments/' + encodeURIComponent(p.tran_ref) + '/refund'); // full refund: no body
    if (r.status !== 'refunded') throw new Error('Moyasar did not confirm the refund (status: ' + r.status + ')');
  } catch (e) {
    db.prepare("UPDATE payments SET status='paid' WHERE id=? AND status='refunding'").run(p.id); // nothing was refunded: release the claim
    return res.status(502).json({ error: 'Refund failed: ' + e.message });
  }
  // Money is refunded. If the line below ever failed the payment stays 'refunding' (never back to 'paid') and Moyasar's refund webhook finishes it.
  markRefunded(p.tran_ref, p.tran_ref);
  audit(req.user.email, 'refund', p.id, reason);
  res.json({ ok: true });
}));

/* --- public config (the Google client id is public by design) --- */
app.get('/api/config', (req, res) => res.json({ paymentMode: MZ.mode, googleClientId: E.GOOGLE_CLIENT_ID, appleClientId: E.APPLE_CLIENT_ID || null, appleRedirectUri: E.APPLE_REDIRECT_URI || null }));

/* --- verification helpers --- */
const CHECKS = { identity: 'identity', photo: 'photo', background: 'background' }; // whitelist: only these column names reach SQL
function vstate(email) {
  const v = db.prepare('SELECT identity,photo,background,revoked_at FROM verification WHERE email=?').get(email) || {};
  const o = { identity: !!v.identity, photo: !!v.photo, background: !!v.background, revoked_at: v.revoked_at || null };
  o.verified = o.identity && o.photo && o.background; return o;
}
const opaque = email => { // members never see each other's email; the id is remembered so chat requests can be resolved
  const uid = crypto.createHmac('sha256', E.JWT_SECRET).update(email).digest('hex').slice(0, 16);
  db.prepare('INSERT OR IGNORE INTO uid_map(uid,email) VALUES(?,?)').run(uid, email);
  return uid;
};
const byUid = uid => { const r = db.prepare('SELECT email FROM uid_map WHERE uid=?').get(String(uid || '')); return r && r.email; };
const audit = (admin, action, ref, reason) => db.prepare('INSERT INTO audit(admin,action,payment_id,reason,at) VALUES(?,?,?,?,?)').run(admin, action, ref, reason || null, now());

/* --- member search: only members with an active paid membership may browse --- */
app.get('/api/members', auth, wrap(async (req, res) => {
  if (!membership(req.user.email).active) return res.status(403).json({ error: 'Activate your profile with a membership to search members.' });
  const q = req.query, lo = parseInt(q.lo, 10) || 18, hi = parseInt(q.hi, 10) || 70, city = String(q.c || '').toLowerCase().slice(0, 40);
  const rows = db.prepare('SELECT u.email,u.profile_json FROM users u JOIN memberships m ON m.email=u.email WHERE m.expires_at>? AND u.profile_json IS NOT NULL AND u.email<>?').all(now(), req.user.email);
  res.json(rows.map(r => ({ email: r.email, p: JSON.parse(r.profile_json) }))
    .filter(({ email }) => mstatus(email) === 'approved' && !isBlocked(req.user.email, email))
    .filter(({ p }) => (!q.g || p.g === q.g) && p.a >= lo && p.a <= hi && (!city || p.c.toLowerCase().includes(city)))
    .map(({ email, p }) => ({ id: opaque(email), n: p.n, g: p.g, a: p.a, c: p.c, j: p.j, x: p.x, verified: vstate(email).verified })));
}));

/* --- admin: verification queue --- */
app.get('/api/admin/verification', auth, adminOnly, (req, res) => {
  const rows = db.prepare('SELECT email,name FROM users WHERE profile_json IS NOT NULL ORDER BY created_at DESC').all();
  res.json(rows.map(u => ({ email: u.email, name: u.name, ...vstate(u.email) })));
});
const target = (req, res) => { // the member must exist and have a profile
  const u = db.prepare('SELECT email FROM users WHERE email=? AND profile_json IS NOT NULL').get(String(req.params.email || '').toLowerCase());
  if (!u) res.status(404).json({ error: 'Member not found' });
  return u && u.email;
};
app.post('/api/admin/verification/:email/check', auth, adminOnly, csrf, wrap(async (req, res) => {
  const email = target(req, res); if (!email) return;
  const col = CHECKS[req.body && req.body.check]; if (!col) return res.status(400).json({ error: 'Unknown check' });
  const val = req.body.value ? 1 : 0;
  db.prepare('INSERT OR IGNORE INTO verification(email) VALUES(?)').run(email);
  db.prepare(`UPDATE verification SET ${col}=?, updated_at=? WHERE email=?`).run(val, now(), email);
  audit(req.user.email, (val ? 'verify-' : 'unverify-') + col, email);
  res.json(vstate(email));
}));
app.post('/api/admin/verification/:email/approve', auth, adminOnly, csrf, wrap(async (req, res) => {
  const email = target(req, res); if (!email) return;
  db.prepare('INSERT OR IGNORE INTO verification(email) VALUES(?)').run(email);
  db.prepare('UPDATE verification SET identity=1, photo=1, background=1, revoked_at=NULL, updated_at=? WHERE email=?').run(now(), email);
  audit(req.user.email, 'verify-all', email);
  res.json(vstate(email));
}));
app.post('/api/admin/verification/:email/revoke', auth, adminOnly, csrf, wrap(async (req, res) => {
  const email = target(req, res); if (!email) return;
  const reason = s(req.body && req.body.reason, 200);
  if (reason.length < 3) return res.status(400).json({ error: 'Enter a reason for revoking' });
  db.prepare('INSERT OR IGNORE INTO verification(email) VALUES(?)').run(email);
  db.prepare('UPDATE verification SET identity=0, photo=0, background=0, revoked_at=?, updated_at=? WHERE email=?').run(now(), now(), email);
  audit(req.user.email, 'revoke-verification', email, reason);
  res.json(vstate(email));
}));


/* --- member status: approved (default) | pending (only when REQUIRE_APPROVAL=true) | suspended --- */
function mstatus(email) {
  const r = db.prepare('SELECT status FROM member_status WHERE email=?').get(email);
  return r ? r.status : 'approved';
}
const setStatus = (email, status, reason) => db.prepare(
  'INSERT INTO member_status(email,status,reason,updated_at) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET status=excluded.status, reason=excluded.reason, updated_at=excluded.updated_at'
).run(email, status, reason || null, now());

app.get('/api/admin/members', auth, adminOnly, (req, res) => {
  const rows = db.prepare('SELECT email,name FROM users WHERE profile_json IS NOT NULL ORDER BY created_at DESC').all();
  res.json(rows.map(u => {
    const r = db.prepare('SELECT status,reason FROM member_status WHERE email=?').get(u.email);
    return { email: u.email, name: u.name, status: r ? r.status : 'approved', reason: r ? r.reason : null, membership: membership(u.email) };
  }));
});
app.post('/api/admin/members/:email/suspend', auth, adminOnly, csrf, wrap(async (req, res) => {
  const email = target(req, res); if (!email) return;
  if (admins.has(email)) return res.status(400).json({ error: "Admin accounts can't be suspended" });
  const reason = s(req.body && req.body.reason, 200);
  if (reason.length < 3) return res.status(400).json({ error: 'Enter a reason for suspending' });
  setStatus(email, 'suspended', reason);
  audit(req.user.email, 'suspend-member', email, reason);
  notify(email, 'moderation', 'Your account was suspended', SUSPEND_TEXT);
  res.json({ status: 'suspended' });
}));
// Approve covers both cases: admit a pending member, or reinstate a suspended one.
app.post('/api/admin/members/:email/approve', auth, adminOnly, csrf, wrap(async (req, res) => {
  const email = target(req, res); if (!email) return;
  const before = mstatus(email);
  setStatus(email, 'approved', null);
  audit(req.user.email, before === 'suspended' ? 'reinstate-member' : 'approve-member', email);
  if (before !== 'approved') notify(email, 'moderation', before === 'suspended' ? 'Your account was reinstated' : 'Your profile was approved', before === 'suspended' ? 'Your account is active again.' : 'Your profile is approved and can now appear in search.');
  res.json({ status: 'approved' });
}));


/* ================= brokers ================= */
function bstatus(email) { const r = db.prepare('SELECT status FROM brokers WHERE email=?').get(email); return r ? r.status : null; }
function binfo(email) { return db.prepare('SELECT status,reason FROM brokers WHERE email=?').get(email) || null; }
const setBroker = (email, status, reason) => db.prepare('UPDATE brokers SET status=?, reason=?, updated_at=? WHERE email=?').run(status, reason || null, now(), email);

// Anyone signed in can apply; nobody is listed or shown as Verified until an admin approves.
app.post('/api/broker/apply', auth, csrf, wrap(async (req, res) => {
  const b = req.body || {}, prof = { n: s(b.n, 60), c: s(b.c, 60), e: s(b.e, 30), l: s(b.l, 60), s: s(b.s, 120), x: s(b.x, 400) };
  if (Object.values(prof).some(v => !v)) return res.status(400).json({ error: 'Complete every field.' });
  const cur = bstatus(req.user.email);
  if (cur === 'approved' || cur === 'suspended') return res.status(409).json({ error: 'Your broker account is ' + cur + '.' });
  db.prepare("INSERT INTO brokers(email,profile_json,status,created_at,updated_at) VALUES(?,?, 'pending',?,?) ON CONFLICT(email) DO UPDATE SET profile_json=excluded.profile_json, status='pending', reason=NULL, updated_at=excluded.updated_at")
    .run(req.user.email, JSON.stringify(prof), now(), now());
  res.json({ ok: true });
}));
app.get('/api/brokers', (req, res) => { // public list: approved brokers only, no emails
  const rows = db.prepare("SELECT email,profile_json FROM brokers WHERE status='approved' ORDER BY updated_at DESC").all();
  res.json(rows.filter(r => mstatus(r.email) !== 'suspended').map(r => ({ id: opaque(r.email), ...JSON.parse(r.profile_json) })));
});
app.get('/api/admin/brokers', auth, adminOnly, (req, res) => {
  const rows = db.prepare('SELECT * FROM brokers ORDER BY created_at DESC').all();
  res.json(rows.map(r => ({ email: r.email, status: r.status, reason: r.reason, ...JSON.parse(r.profile_json) })));
});
const bTarget = (req, res) => {
  const r = db.prepare('SELECT email,status FROM brokers WHERE email=?').get(String(req.params.email || '').toLowerCase());
  if (!r) res.status(404).json({ error: 'Broker not found' });
  return r;
};
app.post('/api/admin/brokers/:email/approve', auth, adminOnly, csrf, wrap(async (req, res) => {
  const r = bTarget(req, res); if (!r) return;
  setBroker(r.email, 'approved'); audit(req.user.email, r.status === 'suspended' ? 'reinstate-broker' : 'approve-broker', r.email);
  notify(r.email, 'broker', 'Your broker account is active', 'Your broker account is approved and listed.');
  res.json({ status: 'approved' });
}));
app.post('/api/admin/brokers/:email/reject', auth, adminOnly, csrf, wrap(async (req, res) => {
  const r = bTarget(req, res); if (!r) return;
  if (r.status === 'approved') return res.status(409).json({ error: 'Suspend an approved broker instead' });
  const reason = s(req.body && req.body.reason, 200); if (reason.length < 3) return res.status(400).json({ error: 'Enter a reason' });
  setBroker(r.email, 'rejected', reason); audit(req.user.email, 'reject-broker', r.email, reason);
  notify(r.email, 'broker', 'Your broker application was not approved', 'Open the Broker account tab to see the reason and apply again.');
  res.json({ status: 'rejected' });
}));
app.post('/api/admin/brokers/:email/suspend', auth, adminOnly, csrf, wrap(async (req, res) => {
  const r = bTarget(req, res); if (!r) return;
  if (r.status !== 'approved') return res.status(409).json({ error: 'Only approved brokers can be suspended' });
  const reason = s(req.body && req.body.reason, 200); if (reason.length < 3) return res.status(400).json({ error: 'Enter a reason' });
  setBroker(r.email, 'suspended', reason); audit(req.user.email, 'suspend-broker', r.email, reason);
  notify(r.email, 'broker', 'Your broker account was suspended', 'You can appeal from the Broker account tab.');
  res.json({ status: 'suspended' });
}));

/* ================= chat (members and brokers) ================= */
const pair = (a, b) => a < b ? [a, b] : [b, a];
const otherOf = (c, email) => c.u1 === email ? c.u2 : c.u1;
const cleanBody = b => String(b || '').trim().slice(0, 1000);
const sendLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'You are sending messages too fast. Wait a moment.' } });
function whoIs(email) {
  const bk = db.prepare("SELECT profile_json FROM brokers WHERE email=? AND status='approved'").get(email);
  if (bk) return { n: JSON.parse(bk.profile_json).n, kind: 'broker' };
  const u = db.prepare('SELECT name,profile_json FROM users WHERE email=?').get(email);
  const p = u && u.profile_json ? JSON.parse(u.profile_json) : null;
  return { n: (p && p.n) || (u && u.name) || 'Member', kind: 'member' };
}
/** Who may message whom. Returns an error string, or null when allowed. */
function gate(from, to, exists) {
  if (from === to) return "You can't message yourself";
  const fu = db.prepare('SELECT profile_json FROM users WHERE email=?').get(from), tu = db.prepare('SELECT profile_json FROM users WHERE email=?').get(to);
  if (!tu) return 'Recipient not found';
  if (isBlocked(from, to)) return 'This member is unavailable'; // same wording both ways so a blocked member is not told
  if (mstatus(to) === 'suspended') return 'This member is unavailable';
  const fb = bstatus(from), tb = bstatus(to);
  if (fb === 'suspended') return 'Your broker account is suspended';
  if (tb === 'suspended') return 'This broker is unavailable';
  if (fb === 'approved') return exists ? null : 'Brokers reply to clients; they cannot start conversations';
  if (tb === 'approved') return fu && fu.profile_json ? null : 'Create your profile before contacting a broker';
  // member to member: both sides need an approved profile and a paid, active membership
  if (!membership(from).active) return 'Activate your profile with a membership to message members';
  if (mstatus(from) !== 'approved') return 'Your profile is awaiting approval';
  if (!tu.profile_json || mstatus(to) !== 'approved' || !membership(to).active) return 'This member is unavailable';
  return null;
}
const convFor = (id, email) => { const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(id); return c && (c.u1 === email || c.u2 === email) ? c : null; }; // participants only
const addMsg = (conv, sender, body) => Number(db.prepare('INSERT INTO messages(conv_id,sender,body,created_at) VALUES(?,?,?,?)').run(conv, sender, body, now()).lastInsertRowid);
const markRead = (conv, email, last) => db.prepare('INSERT INTO conv_reads(conv_id,email,last_id) VALUES(?,?,?) ON CONFLICT(conv_id,email) DO UPDATE SET last_id=MAX(last_id,excluded.last_id)').run(conv, email, last);

app.get('/api/chats', auth, (req, res) => {
  const e = req.user.email;
  const out = db.prepare('SELECT * FROM conversations WHERE u1=? OR u2=?').all(e, e).map(c => {
    const o = otherOf(c, e), last = db.prepare('SELECT sender,body,created_at FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT 1').get(c.id);
    const rd = db.prepare('SELECT last_id FROM conv_reads WHERE conv_id=? AND email=?').get(c.id, e);
    const unread = db.prepare('SELECT COUNT(*) n FROM messages WHERE conv_id=? AND sender<>? AND id>?').get(c.id, e, rd ? rd.last_id : 0).n;
    return { id: c.id, with: { id: opaque(o), ...whoIs(o) }, last: last && { body: last.body, at: last.created_at, mine: last.sender === e }, unread,
      hid: !!db.prepare('SELECT 1 FROM blocks WHERE blocker=? AND blocked=?').get(e, o) };
  }).filter(c => c.last && !c.hid).sort((a, b) => b.last.at.localeCompare(a.last.at));
  res.json(out);
});
app.post('/api/chats', auth, csrf, sendLimit, wrap(async (req, res) => { // start a conversation with the first message
  const to = byUid(req.body && req.body.to), body = cleanBody(req.body && req.body.body);
  if (!to) return res.status(404).json({ error: 'Recipient not found' });
  if (!body) return res.status(400).json({ error: 'Write a message first' });
  const [u1, u2] = pair(req.user.email, to);
  let c = db.prepare('SELECT * FROM conversations WHERE u1=? AND u2=?').get(u1, u2);
  const err = gate(req.user.email, to, !!c); if (err) return res.status(403).json({ error: err });
  if (!c) c = { id: Number(db.prepare('INSERT INTO conversations(u1,u2,created_at) VALUES(?,?,?)').run(u1, u2, now()).lastInsertRowid) };
  markRead(c.id, req.user.email, addMsg(c.id, req.user.email, body));
  res.json({ id: c.id });
}));
app.get('/api/chats/:id', auth, (req, res) => {
  const e = req.user.email, c = convFor(Number(req.params.id), e);
  if (!c) return res.status(404).json({ error: 'Conversation not found' });
  const msgs = db.prepare('SELECT id,sender,body,created_at FROM messages WHERE conv_id=? AND id>? ORDER BY id LIMIT 200').all(c.id, parseInt(req.query.after, 10) || 0);
  if (msgs.length) markRead(c.id, e, msgs[msgs.length - 1].id);
  const o = otherOf(c, e);
  res.json({ with: { id: opaque(o), ...whoIs(o) }, messages: msgs.map(m => ({ id: m.id, mine: m.sender === e, body: m.body, at: m.created_at })) });
});
app.post('/api/chats/:id/messages', auth, csrf, sendLimit, wrap(async (req, res) => {
  const e = req.user.email, c = convFor(Number(req.params.id), e), body = cleanBody(req.body && req.body.body);
  if (!c) return res.status(404).json({ error: 'Conversation not found' });
  if (!body) return res.status(400).json({ error: 'Write a message first' });
  const err = gate(e, otherOf(c, e), true); if (err) return res.status(403).json({ error: err });
  const id = addMsg(c.id, e, body); markRead(c.id, e, id);
  res.json({ id });
}));


/* ================= block and report ================= */
const isBlocked = (a, b) => !!db.prepare('SELECT 1 FROM blocks WHERE (blocker=? AND blocked=?) OR (blocker=? AND blocked=?)').get(a, b, b, a);
const REPORT_CATS = ['harassment', 'scam', 'fake', 'inappropriate', 'other'];
const reportLimit = rateLimit({ windowMs: 3600_000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many reports. Try again later.' } });

app.post('/api/blocks', auth, csrf, wrap(async (req, res) => {
  const to = byUid(req.body && req.body.user);
  if (!to) return res.status(404).json({ error: 'Member not found' });
  if (to === req.user.email) return res.status(400).json({ error: "You can't block yourself" });
  db.prepare('INSERT OR IGNORE INTO blocks(blocker,blocked,created_at) VALUES(?,?,?)').run(req.user.email, to, now());
  res.json({ ok: true });
}));
app.post('/api/blocks/remove', auth, csrf, wrap(async (req, res) => {
  const to = byUid(req.body && req.body.user);
  if (!to) return res.status(404).json({ error: 'Member not found' });
  db.prepare('DELETE FROM blocks WHERE blocker=? AND blocked=?').run(req.user.email, to);
  res.json({ ok: true });
}));
app.get('/api/blocks', auth, (req, res) =>
  res.json(db.prepare('SELECT blocked FROM blocks WHERE blocker=? ORDER BY created_at DESC').all(req.user.email).map(r => ({ id: opaque(r.blocked), n: whoIs(r.blocked).n }))));

// A report keeps a snapshot of the last 20 messages so the evidence survives even if the conversation continues.
app.post('/api/reports', auth, csrf, reportLimit, wrap(async (req, res) => {
  const b = req.body || {}, e = req.user.email, to = byUid(b.user);
  if (!to) return res.status(404).json({ error: 'Member not found' });
  if (to === e) return res.status(400).json({ error: "You can't report yourself" });
  if (!REPORT_CATS.includes(b.category)) return res.status(400).json({ error: 'Choose what happened' });
  if (db.prepare("SELECT 1 FROM reports WHERE reporter=? AND reported=? AND status='open'").get(e, to)) return res.status(409).json({ error: 'You already have an open report for this member. We will review it soon.' });
  const [u1, u2] = pair(e, to), c = db.prepare('SELECT id FROM conversations WHERE u1=? AND u2=?').get(u1, u2);
  const ev = c ? db.prepare('SELECT sender,body,created_at FROM (SELECT * FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT 20) ORDER BY id').all(c.id)
    .map(m => ({ from: m.sender === e ? 'reporter' : 'reported', body: m.body, at: m.created_at })) : [];
  db.prepare('INSERT INTO reports(reporter,reported,category,details,evidence_json,source,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(e, to, b.category, s(b.details, 500), JSON.stringify(ev), ['chat', 'search', 'broker'].includes(b.source) ? b.source : 'chat', now());
  if (b.block) db.prepare('INSERT OR IGNORE INTO blocks(blocker,blocked,created_at) VALUES(?,?,?)').run(e, to, now());
  res.json({ ok: true });
}));

const repRow = r => ({
  id: r.id, source: r.source || 'chat', category: r.category, details: r.details, status: r.status, outcome: r.outcome, note: r.admin_note, created_at: r.created_at, resolved_at: r.resolved_at,
  reporter: { email: r.reporter, n: whoIs(r.reporter).n },
  reported: { email: r.reported, n: whoIs(r.reported).n, status: mstatus(r.reported), total: db.prepare('SELECT COUNT(*) n FROM reports WHERE reported=?').get(r.reported).n,
    warnings: db.prepare("SELECT COUNT(*) n FROM warnings WHERE email=? AND status='active'").get(r.reported).n },
  evidence: JSON.parse(r.evidence_json || '[]'),
});
app.get('/api/admin/reports', auth, adminOnly, (req, res) => res.json({
  open: db.prepare("SELECT * FROM reports WHERE status='open' ORDER BY created_at").all().map(repRow),
  resolved: db.prepare("SELECT * FROM reports WHERE status='resolved' ORDER BY resolved_at DESC LIMIT 20").all().map(repRow),
}));
app.post('/api/admin/reports/:id/resolve', auth, adminOnly, csrf, wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Report not found' });
  const outcome = req.body && req.body.outcome, note = s(req.body && req.body.note, 300);
  if (!['dismiss', 'warn', 'suspend'].includes(outcome)) return res.status(400).json({ error: 'Choose dismiss, warn or suspend' });
  if (note.length < 3) return res.status(400).json({ error: 'Enter a note for the record' });
  if (outcome !== 'dismiss' && admins.has(r.reported)) return res.status(400).json({ error: "Admin accounts can't be warned or suspended" });
  const claim = db.prepare("UPDATE reports SET status='resolved', outcome=?, admin_note=?, resolved_by=?, resolved_at=? WHERE id=? AND status='open'").run(outcome, note, req.user.email, now(), r.id);
  if (!claim.changes) return res.status(409).json({ error: 'This report was already resolved' });
  if (outcome === 'suspend') {
    setStatus(r.reported, 'suspended', 'Report #' + r.id + ': ' + note);
    if (bstatus(r.reported) === 'approved') setBroker(r.reported, 'suspended', 'Suspended after a safety review'); // the internal note is never shown to the member
  }
  if (outcome === 'warn') {
    const text = (WARN_TEXT[r.category] || WARN_TEXT.other) + ' Repeated warnings can lead to suspension.';
    db.prepare('INSERT INTO warnings(email,report_id,category,message,created_by,created_at) VALUES(?,?,?,?,?,?)').run(r.reported, r.id, r.category, text, req.user.email, now());
    notify(r.reported, 'moderation', 'Warning on your account', text + ' You can appeal from the Alerts page.');
  } else if (outcome === 'suspend') notify(r.reported, 'moderation', 'Your account was suspended', SUSPEND_TEXT);
  // The reporter learns the outcome, never the details: not what action was taken, and nothing about the other person.
  notify(r.reporter, 'report', 'Update on your report', outcome === 'dismiss'
    ? 'We reviewed your report and did not find a violation of our rules at this time. Thank you for helping keep the community safe.'
    : 'We reviewed your report and took action. For privacy we cannot share the details. Thank you for helping keep the community safe.');
  audit(req.user.email, 'report-' + outcome, r.reported, '#' + r.id + ' ' + note);
  res.json({ ok: true });
}));


/* ================= audit log: view and CSV export ================= */
const MAX_EXPORT = 50000;
function auditWhere(q) { // one filter builder shared by the on-screen view and the export, so they can never disagree
  const where = [], args = [];
  if (q.action) { where.push('action=?'); args.push(String(q.action).slice(0, 40)); }
  if (q.admin) { where.push('admin=?'); args.push(String(q.admin).toLowerCase().slice(0, 100)); }
  if (q.q) { // LIKE wildcards in the search text are escaped so they match literally
    const like = '%' + String(q.q).slice(0, 60).replace(/[\\%_]/g, '\\$&') + '%';
    where.push(`(payment_id LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\')`); args.push(like, like);
  }
  return { where, args };
}
app.get('/api/admin/audit', auth, adminOnly, (req, res) => {
  const q = req.query, limit = Math.min(parseInt(q.limit, 10) || 50, 200), { where, args } = auditWhere(q);
  const before = parseInt(q.before, 10); if (before > 0) { where.push('id<?'); args.push(before); }
  const rows = db.prepare(`SELECT id,admin,action,payment_id AS target,reason,at FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit + 1);
  res.json({ rows: rows.slice(0, limit), more: rows.length > limit, actions: db.prepare('SELECT DISTINCT action FROM audit ORDER BY action').all().map(r => r.action) });
});

// CSV cell: quote when needed, and neutralise spreadsheet formulas (=, +, -, @) so a hostile reason text
// cannot run as a formula when an admin opens the file in Excel or Sheets.
const csvCell = v => {
  let t = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};
app.get('/api/admin/audit/export', auth, adminOnly, (req, res) => {
  const { where, args } = auditWhere(req.query), W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM audit ${W}`).get(...args).n;
  const used = ['action', 'admin', 'q'].filter(k => req.query[k]).map(k => k + '=' + String(req.query[k]).slice(0, 40)).join(' ');
  audit(req.user.email, 'export-audit-log', null, `${Math.min(total, MAX_EXPORT)} of ${total} entries; ${used || 'no filters'}`); // exports are recorded, and appear in the file
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${now().slice(0, 10)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  if (total + 1 > MAX_EXPORT) res.setHeader('X-Truncated', 'true');
  res.write('\ufeffid,time,admin,action,target,reason\r\n'); // BOM so Excel reads Arabic and Urdu names correctly
  let buf = [];
  for (const r of db.prepare(`SELECT id,at,admin,action,payment_id AS target,reason FROM audit ${W} ORDER BY id DESC LIMIT ?`).iterate(...args, MAX_EXPORT)) {
    buf.push([r.id, r.at, r.admin, r.action, r.target, r.reason].map(csvCell).join(','));
    if (buf.length >= 500) { res.write(buf.join('\r\n') + '\r\n'); buf = []; }
  }
  if (buf.length) res.write(buf.join('\r\n') + '\r\n');
  res.end();
});


/* ================= notifications ================= */
function notify(email, kind, title, body) {
  db.prepare('INSERT INTO notifications(email,kind,title,body,created_at) VALUES(?,?,?,?,?)').run(email, kind, title, body, now());
}
const unreadCount = email => db.prepare('SELECT COUNT(*) n FROM notifications WHERE email=? AND read_at IS NULL').get(email).n;
const SUSPEND_TEXT = 'Your account was suspended after a safety review. You can appeal from the banner at the top of the site.';
app.get('/api/notifications', auth, (req, res) => res.json({
  rows: db.prepare('SELECT id,kind,title,body,created_at AS at,read_at IS NULL AS unread FROM notifications WHERE email=? ORDER BY id DESC LIMIT 50').all(req.user.email).map(r => ({ ...r, unread: !!r.unread })),
}));
app.post('/api/notifications/read', auth, csrf, (req, res) => {
  db.prepare('UPDATE notifications SET read_at=? WHERE email=? AND read_at IS NULL').run(now(), req.user.email);
  res.json({ ok: true });
});

/* ================= warnings ================= */
const WARN_TEXT = { // fixed wording per category: members never see an admin's private note or who reported them
  harassment: 'We reviewed a report about your messages and found they did not follow our respectful-conduct rules. Please keep conversations courteous.',
  scam: 'We reviewed a report and found behaviour that looks like asking for money or financial details. This is not allowed.',
  fake: 'We reviewed a report and found that your profile may be misleading. Please make sure your profile information is accurate.',
  inappropriate: 'We reviewed a report and found content that does not follow our community rules. Please remove or avoid it.',
  other: 'We reviewed a report about your account and found it did not follow our community rules.',
};
const activeWarnings = email => db.prepare("SELECT id,message,created_at AS at FROM warnings WHERE email=? AND status='active' AND acknowledged_at IS NULL ORDER BY id").all(email);
app.get('/api/warnings', auth, (req, res) => res.json(
  db.prepare(`SELECT id,message,created_at AS at, acknowledged_at IS NOT NULL AS acked,
    EXISTS(SELECT 1 FROM appeals a WHERE a.email=warnings.email AND a.kind='warning' AND a.ref_id=warnings.id) AS appealed
    FROM warnings WHERE email=? AND status='active' ORDER BY id DESC`).all(req.user.email).map(w => ({ ...w, acked: !!w.acked, appealed: !!w.appealed }))));
app.post('/api/warnings/:id/ack', auth, csrf, (req, res) => {
  db.prepare('UPDATE warnings SET acknowledged_at=? WHERE id=? AND email=? AND acknowledged_at IS NULL').run(now(), Number(req.params.id), req.user.email);
  res.json({ ok: true });
});

/* ================= appeals ================= */
const COOLDOWN_DAYS = 30;
const appealLimit = rateLimit({ windowMs: 3600_000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many appeals. Try again later.' } });
const openAppeals = email => { const k = db.prepare("SELECT kind FROM appeals WHERE email=? AND status='open'").all(email).map(x => x.kind); return { suspension: k.includes('suspension'), broker: k.includes('broker') }; };
const lastActor = (email, actions) => { // the admin who made the original decision, so the same person does not judge their own call
  const r = db.prepare(`SELECT admin FROM audit WHERE payment_id=? AND action IN (${actions.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`).get(email, ...actions);
  return r ? r.admin : null;
};
app.post('/api/appeals', auth, csrf, appealLimit, wrap(async (req, res) => {
  const e = req.user.email, b = req.body || {}, kind = b.kind, msg = s(b.message, 1000);
  if (msg.length < 20) return res.status(400).json({ error: 'Please explain in at least 20 characters why this decision should be reviewed.' });
  let ref = null, orig = null;
  if (kind === 'suspension') {
    if (mstatus(e) !== 'suspended') return res.status(409).json({ error: 'Your account is not suspended.' });
    orig = lastActor(e, ['suspend-member', 'report-suspend']);
  } else if (kind === 'warning') {
    const w = db.prepare("SELECT id,created_by FROM warnings WHERE id=? AND email=? AND status='active'").get(Number(b.ref), e);
    if (!w) return res.status(404).json({ error: 'Warning not found' });
    ref = w.id; orig = w.created_by;
  } else if (kind === 'broker') {
    if (bstatus(e) !== 'suspended') return res.status(409).json({ error: 'Your broker account is not suspended.' });
    orig = lastActor(e, ['suspend-broker', 'report-suspend']);
  } else return res.status(400).json({ error: 'Unknown appeal type' });
  const same = [e, kind, ref || 0];
  if (db.prepare("SELECT 1 FROM appeals WHERE email=? AND kind=? AND IFNULL(ref_id,0)=? AND status='open'").get(...same)) return res.status(409).json({ error: 'You already have an appeal waiting for review.' });
  const last = db.prepare("SELECT resolved_at FROM appeals WHERE email=? AND kind=? AND IFNULL(ref_id,0)=? AND status<>'open' ORDER BY id DESC LIMIT 1").get(...same);
  if (last && Date.now() - new Date(last.resolved_at).getTime() < COOLDOWN_DAYS * 864e5) return res.status(409).json({ error: `Your earlier appeal was decided less than ${COOLDOWN_DAYS} days ago.` });
  const id = Number(db.prepare('INSERT INTO appeals(email,kind,ref_id,message,original_admin,created_at) VALUES(?,?,?,?,?,?)').run(e, kind, ref, msg, orig, now()).lastInsertRowid);
  for (const a of admins) notify(a, 'admin', 'New appeal to review', `A member appealed a ${kind} decision (appeal #${id}). Open the admin panel to review it.`);
  notify(e, 'appeal', 'We received your appeal', 'A different reviewer will look at it. You will get a notification with the decision.');
  res.json({ id });
}));
app.get('/api/appeals', auth, (req, res) => res.json(
  db.prepare('SELECT id,kind,status,message,admin_note AS note,created_at,resolved_at FROM appeals WHERE email=? ORDER BY id DESC LIMIT 20').all(req.user.email)));

const apRow = (a, me) => ({
  id: a.id, kind: a.kind, email: a.email, name: whoIs(a.email).n, message: a.message, status: a.status, note: a.admin_note, created_at: a.created_at, resolved_at: a.resolved_at,
  original_admin: a.original_admin, own: !!a.original_admin && a.original_admin === me && admins.size > 1,
  warning: a.kind === 'warning' ? ((db.prepare('SELECT message FROM warnings WHERE id=?').get(a.ref_id) || {}).message || null) : null,
});
app.get('/api/admin/appeals', auth, adminOnly, (req, res) => res.json({
  open: db.prepare("SELECT * FROM appeals WHERE status='open' ORDER BY created_at").all().map(a => apRow(a, req.user.email)),
  resolved: db.prepare("SELECT * FROM appeals WHERE status<>'open' ORDER BY resolved_at DESC LIMIT 20").all().map(a => apRow(a, req.user.email)),
}));
app.post('/api/admin/appeals/:id/decide', auth, adminOnly, csrf, wrap(async (req, res) => {
  const a = db.prepare('SELECT * FROM appeals WHERE id=?').get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Appeal not found' });
  const decision = req.body && req.body.decision, note = s(req.body && req.body.note, 300);
  if (!['overturn', 'uphold'].includes(decision)) return res.status(400).json({ error: 'Choose overturn or uphold' });
  if (note.length < 3) return res.status(400).json({ error: 'Enter a note. The member will see it.' });
  if (a.original_admin && a.original_admin === req.user.email && admins.size > 1) return res.status(403).json({ error: 'A different admin must decide this appeal.' });
  const claim = db.prepare("UPDATE appeals SET status=?, admin_note=?, decided_by=?, resolved_at=? WHERE id=? AND status='open'").run(decision === 'overturn' ? 'overturned' : 'upheld', note, req.user.email, now(), a.id);
  if (!claim.changes) return res.status(409).json({ error: 'This appeal was already decided' });
  if (decision === 'overturn') {
    if (a.kind === 'suspension') setStatus(a.email, 'approved', null);
    else if (a.kind === 'warning') db.prepare("UPDATE warnings SET status='withdrawn' WHERE id=?").run(a.ref_id);
    else if (a.kind === 'broker') setBroker(a.email, 'approved');
  }
  notify(a.email, 'appeal', decision === 'overturn' ? 'Your appeal was successful' : 'Your appeal was reviewed',
    (decision === 'overturn' ? 'We reviewed your appeal and reversed the decision.' : 'We reviewed your appeal and the decision stands.') + ' Reviewer note: ' + note);
  audit(req.user.email, 'appeal-' + decision, a.email, '#' + a.id + ' (' + a.kind + ') ' + note);
  res.json({ ok: true });
}));

/* ================= scheduled backups ================= */
let bkRunning = false, bkLastTry = 0;
async function doBackup(trigger) {
  if (bkRunning) return { ok: false, error: 'A backup is already running' };
  bkRunning = true; bkLastTry = Date.now();
  const t0 = now();
  try {
    const r = await runBackup(db, { dir: BK.dir, key: Buffer.from(E.BACKUP_KEY, 'hex'), keep: BK.keep, copyDir: BK.copy });
    db.prepare("INSERT INTO backup_log(started_at,finished_at,status,trigger,files,bytes,audit_rows,error) VALUES(?,?,'ok',?,?,?,?,?)").run(t0, now(), trigger, r.files.join(', '), r.bytes, r.auditRows, r.copyError);
    return { ok: true, ...r };
  } catch (err) {
    console.error('Backup failed:', err.message);
    db.prepare("INSERT INTO backup_log(started_at,finished_at,status,trigger,error) VALUES(?,?,'failed',?,?)").run(t0, now(), trigger, String(err.message).slice(0, 300));
    return { ok: false, error: err.message };
  } finally { bkRunning = false; }
}
function backupDue() { // true once per day after BACKUP_AT (UTC); a missed time is caught up when the server is next running; failures retry hourly
  const d = new Date(), today = d.toISOString().slice(0, 10);
  if (d.toISOString().slice(11, 16) < BK.at || Date.now() - bkLastTry < 3600e3) return false;
  return !db.prepare("SELECT 1 FROM backup_log WHERE status='ok' AND started_at>=?").get(`${today}T${BK.at}:00`);
}
if (BK.on) setInterval(() => { if (!bkRunning && backupDue()) doBackup('schedule'); }, 60_000).unref();

app.get('/api/admin/backups', auth, adminOnly, (req, res) => {
  const ok = db.prepare("SELECT finished_at FROM backup_log WHERE status='ok' ORDER BY id DESC LIMIT 1").get();
  res.json({
    enabled: BK.on, at: BK.at, keep: BK.keep, copy: !!BK.copy, running: bkRunning, lastOk: ok ? ok.finished_at : null,
    stale: BK.on && (!ok || Date.now() - new Date(ok.finished_at).getTime() > 36 * 3600e3),
    runs: db.prepare('SELECT id,started_at,finished_at,status,trigger,files,bytes,audit_rows,error FROM backup_log ORDER BY id DESC LIMIT 10').all(),
  });
});
app.post('/api/admin/backups/run', auth, adminOnly, csrf, wrap(async (req, res) => {
  if (!BK.on) return res.status(409).json({ error: 'Backups are not enabled. Set BACKUP_ENABLED=true and BACKUP_KEY in .env, then restart.' });
  const r = await doBackup('manual');
  audit(req.user.email, 'run-backup', null, r.ok ? r.stamp : 'failed: ' + r.error);
  r.ok ? res.json({ ok: true, stamp: r.stamp }) : res.status(500).json({ error: 'Backup failed: ' + r.error });
}));

app.use(express.static(path.join(__dirname, 'public'))); // put the website's index.html in ./public
app.listen(Number(E.PORT) || 3000, () => console.log('Rishta Connect Global listening on ' + (E.PORT || 3000)));
