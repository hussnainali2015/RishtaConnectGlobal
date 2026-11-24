'use strict';
/**
 * Broker upgrade: contact number (admin-only), National ID upload (encrypted, admin-only, auto-deleted), live lead tracker,
 * admin-set commissions, and the broker's client list, where a client can be published as a "managed by a broker" profile. SQLite stays the source of truth.
 *
 * Money never passes through this site. A commission is a record that an admin writes ("this broker is owed X for this
 * match") and later marks as paid when it has been paid outside the site.
 */
const crypto = require('node:crypto');

module.exports = function brokerPlus({ app, express, db, E, auth, csrf, adminOnly, wrap, rateLimit, now, audit, notify, opaque, byUid, bstatus, s, scan, admins }) {
  db.exec(`
CREATE TABLE IF NOT EXISTS broker_contact(email TEXT PRIMARY KEY, phone TEXT NOT NULL, updated_at TEXT);
CREATE TABLE IF NOT EXISTS broker_ids(email TEXT PRIMARY KEY, data BLOB NOT NULL, uploaded_at TEXT NOT NULL, purge_at TEXT);
CREATE TABLE IF NOT EXISTS broker_leads(id INTEGER PRIMARY KEY AUTOINCREMENT, broker TEXT NOT NULL, member TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(broker, member));
CREATE INDEX IF NOT EXISTS idx_leads_broker ON broker_leads(broker, updated_at DESC);
CREATE TABLE IF NOT EXISTS broker_clients(id INTEGER PRIMARY KEY AUTOINCREMENT, broker TEXT NOT NULL, json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_clients_broker ON broker_clients(broker, updated_at DESC);
CREATE TABLE IF NOT EXISTS broker_commissions(id INTEGER PRIMARY KEY AUTOINCREMENT, broker TEXT NOT NULL, lead_id INTEGER, minor INTEGER NOT NULL, currency TEXT NOT NULL, note TEXT, status TEXT NOT NULL DEFAULT 'pending', created_by TEXT, created_at TEXT NOT NULL, paid_at TEXT);
CREATE INDEX IF NOT EXISTS idx_comm_broker ON broker_commissions(broker, created_at DESC);
`);
  { // numbers a broker had already given (from the short-lived SMS check) become plain contact numbers
    const old = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='broker_phone'").get();
    if (old) db.exec('INSERT OR IGNORE INTO broker_contact(email,phone,updated_at) SELECT email,phone,verified_at FROM broker_phone');
  }
  if (!db.prepare('PRAGMA table_info(broker_clients)').all().some(c => c.name === 'pub')) db.exec('ALTER TABLE broker_clients ADD COLUMN pub TEXT'); // NULL = private, else pending | approved | rejected

  const day = () => now().slice(0, 10);
  const RETAIN_DAYS = Math.max(1, parseInt(E.ID_RETENTION_DAYS, 10) || 90);
  const plusDays = n => new Date(Date.now() + n * 86400_000).toISOString();
  const KEY = crypto.scryptSync(E.ID_ENC_KEY || E.JWT_SECRET, 'rcg-broker-id-v1', 32);
  const seal = buf => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv), ct = Buffer.concat([c.update(buf), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]); };
  const unseal = buf => { const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28)); return Buffer.concat([d.update(buf.subarray(28)), d.final()]); };

  /* ---------- contact number: collected from the broker, visible to administrators only ---------- */
  const cleanPhone = v => { let p = String(v || '').replace(/[\s\-().]/g, ''); if (p.startsWith('00')) p = '+' + p.slice(2); return /^\+?[0-9]{7,15}$/.test(p) ? p : null; };
  const saveContact = (email, phone) => db.prepare('INSERT INTO broker_contact(email,phone,updated_at) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET phone=excluded.phone, updated_at=excluded.updated_at').run(email, phone, now());
  const kyc = email => {
    const ph = db.prepare('SELECT phone FROM broker_contact WHERE email=?').get(email), id = db.prepare('SELECT uploaded_at FROM broker_ids WHERE email=?').get(email);
    return { phone: ph ? ph.phone : null, hasId: !!id, idUploadedAt: id ? id.uploaded_at : null };
  };
  app.get('/api/broker/kyc', auth, (req, res) => { const k = kyc(req.user.email); res.json({ hasId: k.hasId, retentionDays: RETAIN_DAYS }); }); // never returns the number

  /* ---------- National ID: encrypted at rest, only an admin can open it, deleted automatically ---------- */
  const idLimit = rateLimit({ windowMs: 3600_000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many uploads. Try again later.' } });
  app.post('/api/broker/id', auth, csrf, idLimit, express.raw({ type: 'image/jpeg', limit: '3mb' }), wrap(async (req, res) => {
    const b = req.body;
    if (['approved', 'suspended'].includes(bstatus(req.user.email))) return res.status(409).json({ error: 'Your broker account is already ' + bstatus(req.user.email) + '.' });
    if (!Buffer.isBuffer(b) || b.length < 5_000 || b[0] !== 0xff || b[1] !== 0xd8) return res.status(400).json({ error: 'Please choose a clear JPEG or PNG picture of your National ID.' });
    db.prepare('INSERT INTO broker_ids(email,data,uploaded_at,purge_at) VALUES(?,?,?,NULL) ON CONFLICT(email) DO UPDATE SET data=excluded.data, uploaded_at=excluded.uploaded_at, purge_at=NULL').run(req.user.email, seal(b), now());
    res.json({ ok: true });
  }));
  app.get('/api/admin/brokers/:email/id', auth, adminOnly, (req, res) => {
    const email = String(req.params.email || '').toLowerCase(), r = db.prepare('SELECT data FROM broker_ids WHERE email=?').get(email);
    if (!r) return res.status(404).json({ error: 'No ID on file (it may have been deleted after the retention period).' });
    let img; try { img = unseal(r.data); } catch { return res.status(500).json({ error: 'Could not open the stored file.' }); }
    audit(req.user.email, 'view-broker-id', email);
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.end(img);
  });
  const purge = () => { try { return db.prepare('DELETE FROM broker_ids WHERE purge_at IS NOT NULL AND purge_at < ?').run(now()).changes; } catch (e) { console.error('ID purge failed:', e.message); return 0; } };
  purge(); setInterval(purge, 6 * 3600_000).unref();
  /** called whenever an admin decides on a broker: from then on the ID is kept only for the retention period */
  const decided = (email, status) => { if (['approved', 'rejected'].includes(status)) db.prepare('UPDATE broker_ids SET purge_at=? WHERE email=? AND purge_at IS NULL').run(plusDays(RETAIN_DAYS), email); };

  /* ---------- leads: members who came through the broker's link or started a chat ---------- */
  const isApproved = email => bstatus(email) === 'approved';
  const addLead = (broker, member, source) => { if (!broker || !member || broker === member || !isApproved(broker)) return; db.prepare('INSERT OR IGNORE INTO broker_leads(broker,member,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(broker, member, source, 'new', now(), now()); };
  const leadFromRef = (member, ref) => { const b = ref && byUid(String(ref).slice(0, 40)); if (b) addLead(b, member, 'referral'); };
  const leadFromChat = (member, broker) => addLead(broker, member, 'chat');

  const broker = (req, res, next) => isApproved(req.user.email) ? next() : res.status(403).json({ error: 'Only approved brokers can use this.' });
  const LEAD_ST = ['new', 'contacted', 'matched', 'closed'], CL_ST = ['new', 'active', 'matched', 'closed'];
  const money = m => Math.round(m) / 100;
  const first = n => String(n || '').split(/\s+/)[0];
  const cj = r => { let o = {}; try { o = JSON.parse(r.json); } catch { /* empty */ } return { id: r.id, ...o, pub: r.pub || null, status: r.status, created_at: r.created_at, updated_at: r.updated_at }; };

  function dashboard(email) {
    const leads = db.prepare('SELECT l.*, u.profile_json FROM broker_leads l LEFT JOIN users u ON u.email=l.member WHERE l.broker=? ORDER BY l.updated_at DESC LIMIT 300').all(email).map(l => {
      let p = {}; try { p = JSON.parse(l.profile_json || '{}'); } catch { /* none */ }
      return { id: l.id, mid: opaque(l.member), n: first(p.n) || 'Member', a: p.a || null, c: p.c || '', source: l.source, status: l.status, created_at: l.created_at, updated_at: l.updated_at };
    });
    const nameOf = new Map(leads.map(l => [l.id, l.n]));
    const rows = db.prepare('SELECT * FROM broker_commissions WHERE broker=? ORDER BY created_at DESC LIMIT 200').all(email).map(c => ({ id: c.id, amount: money(c.minor), currency: c.currency, note: c.note || '', status: c.status, created_at: c.created_at, paid_at: c.paid_at, lead: c.lead_id ? nameOf.get(c.lead_id) || null : null }));
    const by = {}; for (const c of db.prepare('SELECT currency,status,SUM(minor) m FROM broker_commissions WHERE broker=? AND status<>? GROUP BY currency,status').all(email, 'cancelled')) { (by[c.currency] = by[c.currency] || { currency: c.currency, pending: 0, paid: 0 })[c.status] = money(c.m); }
    const clients = db.prepare('SELECT * FROM broker_clients WHERE broker=? ORDER BY updated_at DESC LIMIT 300').all(email).map(cj);
    const cnt = k => leads.filter(l => l.status === k).length;
    return {
      refId: opaque(email), now: now(),
      stats: { leads: leads.length, new: cnt('new'), contacted: cnt('contacted'), matched: cnt('matched'), closed: cnt('closed'), referrals: leads.filter(l => l.source === 'referral').length, clients: clients.length, activeClients: clients.filter(c => c.status !== 'closed').length },
      commission: { totals: Object.values(by), rows }, leads, clients,
    };
  }
  app.get('/api/broker/dashboard', auth, broker, (req, res) => { res.set('Cache-Control', 'no-store'); res.json(dashboard(req.user.email)); });

  app.post('/api/broker/leads/:id', auth, csrf, broker, wrap(async (req, res) => {
    const st = req.body && req.body.status;
    if (!LEAD_ST.includes(st)) return res.status(400).json({ error: 'Choose a valid status.' });
    const r = db.prepare('UPDATE broker_leads SET status=?, updated_at=? WHERE id=? AND broker=?').run(st, now(), Number(req.params.id), req.user.email);
    if (!r.changes) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ok: true });
  }));

  /* ---------- the broker's own clients; a client can also be shown on the site as a profile "managed by a broker" ---------- */
  const MAX_CLIENTS = 300, MARITAL = ['Never married', 'Divorced', 'Widowed'];
  function clientBody(b) {
    const o = { n: s(b.n, 60), g: b.g === 'Male' ? 'Male' : b.g === 'Female' ? 'Female' : '', a: parseInt(b.a, 10) || null, c: s(b.c, 60), ph: s(b.ph, 30), r: s(b.r, 300), x: s(b.x, 500),
      m: MARITAL.includes(b.m) ? b.m : '', e: s(b.e, 60), j: s(b.j, 60), pa: s(b.pa, 400), w: s(b.w, 300) }; // ph, r and x stay private; the rest is what the public profile shows
    if (!o.n) return { error: 'Enter the client\'s name.' };
    if (o.a !== null && !(o.a >= 18 && o.a <= 80)) return { error: 'Age must be 18 to 80.' };
    if (o.ph && !/^[+\d][\d\s\-().]{5,28}$/.test(o.ph)) return { error: 'That phone number does not look right.' };
    const publish = b.publish === true;
    if (publish) {
      if (b.pconsent !== true) return { error: 'Please confirm the client agreed to have this profile shown on the site.' };
      if (!(o.g && o.a && o.c && o.m && o.e && o.j && o.pa && o.w)) return { error: 'To show a client on the site, fill in gender, age, city, marital status, education, occupation, the public description and what they are looking for.' };
    }
    return { o, publish };
  }
  /** a shown profile waits for an admin when approval is on, or when the automatic text check flags it */
  function pubState(o, brokerEmail, id) {
    const flagged = scan({ n: o.n, c: o.c, e: o.e, j: o.j, x: o.pa, w: o.w }).level === 'high';
    const st = E.REQUIRE_APPROVAL === 'true' || flagged ? 'pending' : 'approved';
    if (st === 'pending') for (const a of admins) notify(a, 'admin', 'A broker-managed profile needs approval', 'Open the admin panel, Broker-managed profiles.');
    return st;
  }
  app.post('/api/broker/clients', auth, csrf, broker, wrap(async (req, res) => {
    const b = req.body || {}, { o, error, publish } = clientBody(b);
    if (error) return res.status(400).json({ error });
    if (b.consent !== true) return res.status(400).json({ error: 'Please confirm the client agreed to share these details with you.' });
    if (db.prepare('SELECT COUNT(*) n FROM broker_clients WHERE broker=?').get(req.user.email).n >= MAX_CLIENTS) return res.status(409).json({ error: `You can keep up to ${MAX_CLIENTS} clients.` });
    const r = db.prepare('INSERT INTO broker_clients(broker,json,status,created_at,updated_at,pub) VALUES(?,?,?,?,?,?)').run(req.user.email, JSON.stringify(o), 'new', now(), now(), publish ? pubState(o) : null);
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  }));
  app.post('/api/broker/clients/:id', auth, csrf, broker, wrap(async (req, res) => {
    const b = req.body || {}, cur = db.prepare('SELECT * FROM broker_clients WHERE id=? AND broker=?').get(Number(req.params.id), req.user.email);
    if (!cur) return res.status(404).json({ error: 'Client not found' });
    let json = cur.json, st = cur.status, pub = cur.pub;
    if (b.status !== undefined) { if (!CL_ST.includes(b.status)) return res.status(400).json({ error: 'Choose a valid status.' }); st = b.status; }
    if (b.n !== undefined) { const { o, error, publish } = clientBody(b); if (error) return res.status(400).json({ error }); json = JSON.stringify(o); pub = publish ? pubState(o) : null; }
    db.prepare('UPDATE broker_clients SET json=?, status=?, updated_at=?, pub=? WHERE id=?').run(json, st, now(), pub, cur.id);
    res.json({ ok: true });
  }));
  app.post('/api/broker/clients/:id/delete', auth, csrf, broker, wrap(async (req, res) => {
    const r = db.prepare('DELETE FROM broker_clients WHERE id=? AND broker=?').run(Number(req.params.id), req.user.email);
    if (!r.changes) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true });
  }));

  /* the public side of a managed profile: no phone, no private notes, and the id leads to the broker, never to the client */
  const mid = id => 'bm' + id.toString(36) + '-' + crypto.createHmac('sha256', E.JWT_SECRET).update('managed:' + id).digest('hex').slice(0, 10);
  const parseMid = x => { const m = /^bm([0-9a-z]+)-([0-9a-f]{10})$/.exec(String(x || '')); const id = m && parseInt(m[1], 36); return id && mid(id) === x ? id : null; };
  const pubRow = r => {
    let o = {}, bp = {}; try { o = JSON.parse(r.json); } catch { /* none */ } try { bp = JSON.parse(r.bjson); } catch { /* none */ }
    return { id: mid(r.id), n: first(o.n), g: o.g, a: o.a, c: o.c, m: o.m, e: o.e, j: o.j, x: o.pa, w: o.w, verified: false, managed: true, bn: first(bp.n) || 'a broker', ph: false, sl: false, _broker: r.broker };
  };
  const LIVE = "c.pub='approved' AND b.status='approved' AND c.status IN ('new','active')";
  const managed = () => db.prepare(`SELECT c.*, b.profile_json bjson FROM broker_clients c JOIN brokers b ON b.email=c.broker WHERE ${LIVE} ORDER BY c.updated_at DESC`).all().map(pubRow);
  const managedOne = x => { const id = parseMid(x); const r = id && db.prepare(`SELECT c.*, b.profile_json bjson FROM broker_clients c JOIN brokers b ON b.email=c.broker WHERE c.id=? AND ${LIVE}`).get(id); return r ? pubRow(r) : null; };
  const managedCard = x => { const r = managedOne(x); if (!r) return null; const { _broker, ...pub } = r; return pub; };
  const managedBroker = x => { const r = managedOne(x); return r ? r._broker : null; };

  /* ---------- admin: approve what brokers want to show on the site ---------- */
  app.get('/api/admin/managed', auth, adminOnly, (req, res) => {
    res.json(db.prepare("SELECT c.*, b.profile_json bjson FROM broker_clients c JOIN brokers b ON b.email=c.broker WHERE c.pub='pending' ORDER BY c.updated_at").all().map(r => { const { _broker, ...p } = pubRow(r); return { ...p, id: r.id, broker: r.broker, brokerName: p.bn }; }));
  });
  for (const [act, st] of [['approve', 'approved'], ['reject', 'rejected']]) {
    app.post(`/api/admin/managed/:id/${act}`, auth, adminOnly, csrf, wrap(async (req, res) => {
      const r = db.prepare("SELECT * FROM broker_clients WHERE id=? AND pub='pending'").get(Number(req.params.id));
      if (!r) return res.status(404).json({ error: 'Not waiting for review' });
      const reason = s(req.body && req.body.reason, 200);
      if (st === 'rejected' && reason.length < 3) return res.status(400).json({ error: 'Enter a reason.' });
      db.prepare('UPDATE broker_clients SET pub=? WHERE id=?').run(st, r.id);
      audit(req.user.email, act + '-managed-profile', r.broker, reason);
      notify(r.broker, 'broker', st === 'approved' ? 'A client profile is now on the site' : 'A client profile was not approved', st === 'approved' ? 'It is shown as managed by you.' : reason);
      res.json({ ok: true });
    }));
  }

  /* ---------- admin: commissions ---------- */
  const target = (req, res) => { const email = String(req.params.email || '').toLowerCase(); if (!isApproved(email)) { res.status(404).json({ error: 'Approved broker not found' }); return null; } return email; };
  app.get('/api/admin/brokers/:email/commissions', auth, adminOnly, (req, res) => {
    const email = String(req.params.email || '').toLowerCase();
    const d = dashboard(email); res.json({ commission: d.commission, leads: d.leads.map(l => ({ id: l.id, n: l.n, status: l.status })) });
  });
  app.post('/api/admin/brokers/:email/commissions', auth, adminOnly, csrf, wrap(async (req, res) => {
    const email = target(req, res); if (!email) return;
    const b = req.body || {}, amount = Number(b.amount), cur = s(b.currency, 3).toUpperCase() || 'USD';
    if (!(amount > 0 && amount <= 10_000_000) || !/^[A-Z]{3}$/.test(cur)) return res.status(400).json({ error: 'Enter an amount above zero and a 3-letter currency like USD or PKR.' });
    let lead = null; if (b.lead_id) { lead = db.prepare('SELECT id FROM broker_leads WHERE id=? AND broker=?').get(Number(b.lead_id), email); if (!lead) return res.status(400).json({ error: 'That lead does not belong to this broker.' }); }
    const r = db.prepare('INSERT INTO broker_commissions(broker,lead_id,minor,currency,note,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(email, lead ? lead.id : null, Math.round(amount * 100), cur, s(b.note, 200), 'pending', req.user.email, now());
    audit(req.user.email, 'add-commission', email, `${amount} ${cur}`);
    notify(email, 'broker', 'A commission was added', `${amount} ${cur} is now shown as pending on your broker dashboard.`);
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  }));
  app.post('/api/admin/commissions/:id', auth, adminOnly, csrf, wrap(async (req, res) => {
    const st = req.body && req.body.status, c = db.prepare('SELECT * FROM broker_commissions WHERE id=?').get(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (!['paid', 'cancelled', 'pending'].includes(st)) return res.status(400).json({ error: 'Choose paid, cancelled or pending.' });
    db.prepare('UPDATE broker_commissions SET status=?, paid_at=? WHERE id=?').run(st, st === 'paid' ? now() : null, c.id);
    audit(req.user.email, 'commission-' + st, c.broker, `${money(c.minor)} ${c.currency}`);
    if (st === 'paid') notify(c.broker, 'broker', 'A commission was marked paid', `${money(c.minor)} ${c.currency} is now marked as paid.`);
    res.json({ ok: true });
  }));
  /** one-line summary for the admin broker table */
  const adminInfo = email => {
    const t = db.prepare("SELECT status,COUNT(*) n FROM broker_leads WHERE broker=? GROUP BY status").all(email), k = kyc(email);
    return { kyc: { phone: k.phone, hasId: k.hasId }, leads: t.reduce((a, x) => a + x.n, 0), clients: db.prepare('SELECT COUNT(*) n FROM broker_clients WHERE broker=?').get(email).n };
  };
  return { kyc, cleanPhone, saveContact, managed, managedCard, managedBroker, leadFromRef, leadFromChat, decided, adminInfo, purge };
};