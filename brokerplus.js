'use strict';
/**
 * Broker upgrade: contact number (admin-only), National ID upload (encrypted, admin-only, auto-deleted), live lead tracker,
 * admin-set commissions, and the broker's client list, where a client can be published as a "managed by a broker" profile. SQLite stays the source of truth.
 *
 * Money never passes through this site. A commission is a record that an admin writes ("this broker is owed X for this
 * match") and later marks as paid when it has been paid outside the site.
 */
const crypto = require('node:crypto');
const { cleanJpeg } = require('./extras');

module.exports = function brokerPlus({ app, express, db, E, auth, csrf, adminOnly, wrap, rateLimit, now, audit, notify, opaque, byUid, bstatus, s, scan, admins, mstatus }) {
  db.exec(`
CREATE TABLE IF NOT EXISTS broker_completions(id INTEGER PRIMARY KEY AUTOINCREMENT, broker TEXT NOT NULL, source TEXT NOT NULL, ref_id INTEGER NOT NULL, label TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, UNIQUE(source, ref_id));
CREATE INDEX IF NOT EXISTS idx_comp_broker ON broker_completions(broker, status);
CREATE TABLE IF NOT EXISTS broker_awards(id INTEGER PRIMARY KEY AUTOINCREMENT, broker TEXT NOT NULL, tier INTEGER NOT NULL, reached_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'eligible', note TEXT, granted_at TEXT, UNIQUE(broker, tier));
CREATE TABLE IF NOT EXISTS broker_progress_notes(broker TEXT NOT NULL, tier INTEGER NOT NULL, pct INTEGER NOT NULL, PRIMARY KEY(broker, tier, pct));
CREATE TABLE IF NOT EXISTS broker_payout(email TEXT PRIMARY KEY, provider TEXT NOT NULL, number TEXT NOT NULL, verified_at TEXT, verified_by TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS broker_challenge(broker TEXT PRIMARY KEY, started_at TEXT NOT NULL, ends_at TEXT NOT NULL, reached_at TEXT, reward_status TEXT NOT NULL DEFAULT 'none', reward_note TEXT, reward_at TEXT, reward_by TEXT);
CREATE TABLE IF NOT EXISTS broker_photos(email TEXT PRIMARY KEY, data BLOB NOT NULL, uploaded_at TEXT NOT NULL);
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
  if (!db.prepare('PRAGMA table_info(broker_clients)').all().some(c => c.name === 'pub_at')) { if (!db.prepare('PRAGMA table_info(broker_clients)').all().some(c => c.name === 'pub')) db.exec('ALTER TABLE broker_clients ADD COLUMN pub TEXT'); db.exec('ALTER TABLE broker_clients ADD COLUMN pub_at TEXT'); db.exec("UPDATE broker_clients SET pub_at=updated_at WHERE pub='approved'"); }
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
    return { phone: ph ? ph.phone : null, hasId: !!id, hasPhoto: !!db.prepare('SELECT 1 FROM broker_photos WHERE email=?').get(email), idUploadedAt: id ? id.uploaded_at : null };
  };
  app.get('/api/broker/kyc', auth, (req, res) => { const k = kyc(req.user.email); res.json({ hasId: k.hasId, hasPhoto: k.hasPhoto, retentionDays: RETAIN_DAYS }); }); // never returns the number

  /* ---------- profile picture: required to apply, checked by an administrator before it is shown ---------- */
  const photoLimit = rateLimit({ windowMs: 3600_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many uploads. Try again later.' } });
  const sendPhoto = (res, buf, cache = 'public, max-age=300') => { res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" }); res.end(buf); };
  app.post('/api/broker/photo', auth, csrf, photoLimit, express.raw({ type: 'image/jpeg', limit: '1200kb' }), wrap(async (req, res) => {
    if (bstatus(req.user.email) === 'approved' || bstatus(req.user.email) === 'suspended') return res.status(409).json({ error: 'Your broker account is already ' + bstatus(req.user.email) + '. Contact support to change the picture.' });
    const clean = cleanJpeg(req.body);
    if (!clean) return res.status(400).json({ error: 'Please choose a clear JPEG or PNG picture (at least 64 pixels wide).' });
    db.prepare('INSERT INTO broker_photos(email,data,uploaded_at) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET data=excluded.data, uploaded_at=excluded.uploaded_at').run(req.user.email, clean, now());
    res.json({ ok: true });
  }));
  app.get('/api/broker/photo', auth, (req, res) => { const r = db.prepare('SELECT data FROM broker_photos WHERE email=?').get(req.user.email); if (!r) return res.status(404).json({ error: 'No picture yet' }); sendPhoto(res, r.data, 'private, no-store'); });
  /** public: only the picture of an approved, active broker */
  app.get('/api/brokers/:id/photo', (req, res) => {
    const email = byUid(req.params.id), r = email && bstatus(email) === 'approved' && db.prepare('SELECT data FROM broker_photos WHERE email=?').get(email);
    if (!r) return res.status(404).json({ error: 'No picture' });
    sendPhoto(res, r.data);
  });
  app.get('/api/admin/brokers/:email/photo', auth, adminOnly, (req, res) => {
    const r = db.prepare('SELECT data FROM broker_photos WHERE email=?').get(String(req.params.email || '').toLowerCase());
    if (!r) return res.status(404).json({ error: 'No picture' });
    sendPhoto(res, r.data, 'private, no-store');
  });
  const hasPhoto = email => !!db.prepare('SELECT 1 FROM broker_photos WHERE email=?').get(email);

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
  const decided = (email, status) => { if (status === 'approved') ensureChallenge(email); if (['approved', 'rejected'].includes(status)) db.prepare('UPDATE broker_ids SET purge_at=? WHERE email=? AND purge_at IS NULL').run(plusDays(RETAIN_DAYS), email); };

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
      commission: { totals: Object.values(by), rows }, leads, clients, milestones: miles(email), challenge: refreshChallenge(email), leaderboard: leaderboard(email), payout: payoutOf(email) ? { provider: payoutOf(email).provider, number: payoutOf(email).number, verified: !!payoutOf(email).verified_at } : null,
    };
  }
  app.get('/api/broker/dashboard', auth, broker, (req, res) => { res.set('Cache-Control', 'no-store'); res.json(dashboard(req.user.email)); });

  app.post('/api/broker/leads/:id', auth, csrf, broker, wrap(async (req, res) => {
    const st = req.body && req.body.status;
    if (!LEAD_ST.includes(st)) return res.status(400).json({ error: 'Choose a valid status.' });
    const r = db.prepare('UPDATE broker_leads SET status=?, updated_at=? WHERE id=? AND broker=?').run(st, now(), Number(req.params.id), req.user.email);
    if (!r.changes) return res.status(404).json({ error: 'Lead not found' });
    syncDone(req.user.email, 'lead', Number(req.params.id), st);
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
    const r = db.prepare('INSERT INTO broker_clients(broker,json,status,created_at,updated_at,pub,pub_at) VALUES(?,?,?,?,?,?,?)').run(req.user.email, JSON.stringify(o), 'new', now(), now(), ...(() => { const st = publish ? pubState(o) : null; return [st, st === 'approved' ? now() : null]; })());
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  }));
  app.post('/api/broker/clients/:id', auth, csrf, broker, wrap(async (req, res) => {
    const b = req.body || {}, cur = db.prepare('SELECT * FROM broker_clients WHERE id=? AND broker=?').get(Number(req.params.id), req.user.email);
    if (!cur) return res.status(404).json({ error: 'Client not found' });
    let json = cur.json, st = cur.status, pub = cur.pub, pubAt = cur.pub_at;
    if (b.status !== undefined) { if (!CL_ST.includes(b.status)) return res.status(400).json({ error: 'Choose a valid status.' }); st = b.status; }
    if (b.n !== undefined) { const { o, error, publish } = clientBody(b); if (error) return res.status(400).json({ error }); json = JSON.stringify(o); pub = publish ? pubState(o) : null; pubAt = pub === 'approved' ? (cur.pub === 'approved' && cur.pub_at ? cur.pub_at : now()) : null; }
    db.prepare('UPDATE broker_clients SET json=?, status=?, updated_at=?, pub=?, pub_at=? WHERE id=?').run(json, st, now(), pub, pubAt, cur.id);
    syncDone(req.user.email, 'client', cur.id, st);
    res.json({ ok: true });
  }));
  app.post('/api/broker/clients/:id/delete', auth, csrf, broker, wrap(async (req, res) => {
    const r = db.prepare('DELETE FROM broker_clients WHERE id=? AND broker=?').run(Number(req.params.id), req.user.email);
    if (!r.changes) return res.status(404).json({ error: 'Client not found' });
    db.prepare("DELETE FROM broker_completions WHERE source='client' AND ref_id=? AND broker=? AND status='pending'").run(Number(req.params.id), req.user.email);
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
      db.prepare('UPDATE broker_clients SET pub=?, pub_at=? WHERE id=?').run(st, st === 'approved' ? now() : null, r.id);
      audit(req.user.email, act + '-managed-profile', r.broker, reason);
      notify(r.broker, 'broker', st === 'approved' ? 'A client profile is now on the site' : 'A client profile was not approved', st === 'approved' ? 'It is shown as managed by you.' : reason);
      res.json({ ok: true });
    }));
  }

  /* ---------- milestone rewards: 50, 100, 150 and 200 completed proposals ----------
   * A proposal is completed when a broker marks a lead or a client "matched" AND an administrator confirms it.
   * Only confirmed ones count, so the count cannot be inflated by the broker alone.
   * Reaching a tier makes the broker eligible for a company award; an administrator decides and records the award. */
  const TIERS = [
    { at: 50, name: 'Bronze', level: 1, perk: 'Bronze Broker badge on your public profile and eligibility for the company performance award, level 1.' },
    { at: 100, name: 'Silver', level: 2, perk: 'Silver Broker badge, more recognition across the site and eligibility for the company performance award, level 2.' },
    { at: 150, name: 'Gold', level: 3, perk: 'Gold Broker badge, featured recognition and eligibility for the company performance award, level 3.' },
    { at: 200, name: 'Platinum', level: 4, perk: 'Platinum Broker badge, top recognition and eligibility for the highest company performance award, level 4.' },
  ];
  const doneCount = email => db.prepare("SELECT COUNT(*) n FROM broker_completions WHERE broker=? AND status='confirmed'").get(email).n;
  const tierOf = email => { const n = doneCount(email); let t = null; for (const x of TIERS) if (n >= x.at) t = x; return t ? { name: t.name, level: t.level } : null; };
  function syncDone(broker, source, id, status) {
    if (status === 'matched') {
      let label = ''; if (source === 'client') { const c = db.prepare('SELECT json FROM broker_clients WHERE id=?').get(id); try { label = first(JSON.parse(c.json).n); } catch { /* none */ } }
      else { const l = db.prepare('SELECT u.profile_json pj FROM broker_leads l LEFT JOIN users u ON u.email=l.member WHERE l.id=?').get(id); try { label = first(JSON.parse(l.pj).n); } catch { /* none */ } }
      const r = db.prepare("INSERT OR IGNORE INTO broker_completions(broker,source,ref_id,label,status,created_at) VALUES(?,?,?,?,'pending',?)").run(broker, source, id, label, now());
      if (r.changes) for (const a of admins) notify(a, 'admin', 'A completed proposal needs confirming', 'Open the admin panel, Completed proposals.');
    } else db.prepare("DELETE FROM broker_completions WHERE source=? AND ref_id=? AND broker=? AND status='pending'").run(source, id, broker); // taken back before an administrator confirmed it
  }
  function miles(email) {
    const n = doneCount(email), pending = db.prepare("SELECT COUNT(*) n FROM broker_completions WHERE broker=? AND status='pending'").get(email).n;
    const aw = new Map(db.prepare('SELECT * FROM broker_awards WHERE broker=?').all(email).map(a => [a.tier, a]));
    const next = TIERS.find(t => n < t.at) || null, prev = [...TIERS].reverse().find(t => n >= t.at);
    const base = prev ? prev.at : 0;
    return {
      completed: n, pending,
      tiers: TIERS.map(t => { const a = aw.get(t.level); return { at: t.at, name: t.name, level: t.level, perk: t.perk, reached: n >= t.at, award: a ? { status: a.status, note: a.note || '', reached_at: a.reached_at, granted_at: a.granted_at } : null }; }),
      current: prev ? { name: prev.name, level: prev.level } : null,
      next: next ? { at: next.at, name: next.name, level: next.level, remaining: next.at - n, pct: Math.min(100, Math.round(((n - base) / (next.at - base)) * 100)) } : null,
    };
  }
  /** after a confirmation: tell the broker about tiers reached and about progress (halfway, 75%, 90%) */
  function afterConfirm(email) {
    const n = doneCount(email);
    for (const t of TIERS) if (n >= t.at && db.prepare('INSERT OR IGNORE INTO broker_awards(broker,tier,reached_at) VALUES(?,?,?)').run(email, t.level, now()).changes) {
      notify(email, 'broker', `You reached ${t.name}: ${t.at} completed proposals`, `Congratulations. You are now eligible for the company performance award, level ${t.level}, and your ${t.name} badge is shown on your public profile. Our team will contact you about the award.`);
      for (const a of admins) notify(a, 'admin', `A broker reached ${t.name}`, `${email} has ${n} completed proposals and is eligible for the level ${t.level} award. Open the admin panel, Brokers, Awards.`);
    }
    const m = miles(email); if (!m.next) return;
    const prevAt = TIERS.filter(t => t.at < m.next.at).pop(); const base = prevAt ? prevAt.at : 0;
    for (const pct of [90, 75, 50]) if (((n - base) / (m.next.at - base)) * 100 >= pct) {
      if (db.prepare('INSERT OR IGNORE INTO broker_progress_notes(broker,tier,pct) VALUES(?,?,?)').run(email, m.next.level, pct).changes)
        notify(email, 'broker', `${m.next.remaining} more to ${m.next.name}`, `You have ${n} completed proposals. ${m.next.remaining} more to reach ${m.next.name} (${m.next.at}).`);
      break;
    }
  }
  app.get('/api/admin/completions', auth, adminOnly, (req, res) => {
    res.json(db.prepare("SELECT c.id,c.broker,c.source,c.label,c.created_at,b.profile_json bj FROM broker_completions c LEFT JOIN brokers b ON b.email=c.broker WHERE c.status='pending' ORDER BY c.created_at").all().map(r => { let n = ''; try { n = JSON.parse(r.bj).n; } catch { /* none */ } return { id: r.id, broker: r.broker, brokerName: n, source: r.source, label: r.label, created_at: r.created_at, total: doneCount(r.broker) }; }));
  });
  for (const [act, st] of [['confirm', 'confirmed'], ['reject', 'rejected']]) {
    app.post(`/api/admin/completions/:id/${act}`, auth, adminOnly, csrf, wrap(async (req, res) => {
      const c = db.prepare("SELECT * FROM broker_completions WHERE id=? AND status='pending'").get(Number(req.params.id));
      if (!c) return res.status(404).json({ error: 'Not waiting for confirmation' });
      db.prepare('UPDATE broker_completions SET status=?, decided_at=?, decided_by=? WHERE id=?').run(st, now(), req.user.email, c.id);
      audit(req.user.email, act + '-completion', c.broker, c.label || '');
      if (st === 'confirmed') afterConfirm(c.broker); else notify(c.broker, 'broker', 'A completed proposal was not confirmed', 'Our team could not confirm one proposal you marked as matched. Contact support if you think this is a mistake.');
      res.json({ ok: true });
    }));
  }
  app.get('/api/admin/brokers/:email/awards', auth, adminOnly, (req, res) => res.json(miles(String(req.params.email || '').toLowerCase())));
  app.post('/api/admin/awards/:email/:level', auth, adminOnly, csrf, wrap(async (req, res) => {
    const email = String(req.params.email || '').toLowerCase(), a = db.prepare('SELECT * FROM broker_awards WHERE broker=? AND tier=?').get(email, Number(req.params.level));
    if (!a) return res.status(404).json({ error: 'This broker has not reached that tier.' });
    const st = req.body && req.body.status; if (!['eligible', 'granted'].includes(st)) return res.status(400).json({ error: 'Choose eligible or granted.' });
    db.prepare('UPDATE broker_awards SET status=?, note=?, granted_at=? WHERE id=?').run(st, s(req.body.note, 200), st === 'granted' ? now() : null, a.id);
    audit(req.user.email, 'award-' + st, email, 'level ' + a.tier);
    if (st === 'granted') notify(email, 'broker', 'Your company award was recorded', `Your level ${a.tier} performance award has been marked as granted.${req.body.note ? ' ' + s(req.body.note, 200) : ''}`);
    res.json({ ok: true });
  }));

  /* ---------- payout details (admin only) ---------- */
  const PROVIDERS = ['JazzCash', 'EasyPaisa'];
  const cleanPK = v => { let p = String(v || '').replace(/[\s\-()]/g, ''); if (p.startsWith('+92')) p = '0' + p.slice(3); else if (p.startsWith('0092')) p = '0' + p.slice(4); else if (/^92\d{10}$/.test(p)) p = '0' + p.slice(2); return /^03\d{9}$/.test(p) ? p : null; };
  const savePayout = (email, provider, number) => db.prepare('INSERT INTO broker_payout(email,provider,number,verified_at,verified_by,updated_at) VALUES(?,?,?,NULL,NULL,?) ON CONFLICT(email) DO UPDATE SET provider=excluded.provider, number=excluded.number, verified_at=CASE WHEN broker_payout.number=excluded.number AND broker_payout.provider=excluded.provider THEN broker_payout.verified_at ELSE NULL END, verified_by=CASE WHEN broker_payout.number=excluded.number AND broker_payout.provider=excluded.provider THEN broker_payout.verified_by ELSE NULL END, updated_at=excluded.updated_at').run(email, provider, number, now()); // changing the details cancels an earlier phone check
  const payoutOf = email => db.prepare('SELECT provider,number,verified_at FROM broker_payout WHERE email=?').get(email) || null;
  const checkPayout = b => { const provider = PROVIDERS.includes(b.pp) ? b.pp : null, number = cleanPK(b.pn); return provider && number ? { provider, number } : { error: 'Choose JazzCash or EasyPaisa and enter the mobile number, for example 03001234567.' }; };
  app.post('/api/broker/payout', auth, csrf, wrap(async (req, res) => {
    if (!bstatus(req.user.email)) return res.status(409).json({ error: 'Apply as a broker first.' });
    const c = checkPayout(req.body || {}); if (c.error) return res.status(400).json({ error: c.error });
    savePayout(req.user.email, c.provider, c.number); res.json({ ok: true });
  }));

  /* ---------- challenge: 15 verified profiles within 90 days = a 1000 PKR reward, paid by hand outside the site ---------- */
  const TARGET = parseInt(E.CHALLENGE_TARGET, 10) || 15, DAYS = parseInt(E.CHALLENGE_DAYS, 10) || 90, REWARD = parseInt(E.CHALLENGE_REWARD_PKR, 10) || 1000;
  const ensureChallenge = email => {
    let c = db.prepare('SELECT * FROM broker_challenge WHERE broker=?').get(email);
    if (!c && isApproved(email)) { db.prepare('INSERT OR IGNORE INTO broker_challenge(broker,started_at,ends_at) VALUES(?,?,?)').run(email, now(), plusDays(DAYS)); c = db.prepare('SELECT * FROM broker_challenge WHERE broker=?').get(email); }
    return c;
  };
  /** profiles that count: members who joined through the broker's link and an administrator has fully verified, plus client profiles the broker manages that an administrator approved, all dated inside the 90 days */
  function countVerified(email, c) {
    let n = 0;
    for (const l of db.prepare("SELECT member FROM broker_leads WHERE broker=? AND source='referral'").all(email)) {
      const v = db.prepare('SELECT identity,photo,background,revoked_at,updated_at FROM verification WHERE email=?').get(l.member);
      if (v && v.identity && v.photo && v.background && !v.revoked_at && v.updated_at >= c.started_at && v.updated_at <= c.ends_at && mstatus(l.member) === 'approved') n++;
    }
    return n + db.prepare("SELECT COUNT(*) n FROM broker_clients WHERE broker=? AND pub='approved' AND pub_at>=? AND pub_at<=?").get(email, c.started_at, c.ends_at).n;
  }
  function refreshChallenge(email) {
    let c = ensureChallenge(email); if (!c) return null;
    let n = c.reached_at ? Math.max(TARGET, countVerified(email, c)) : countVerified(email, c);
    if (!c.reached_at && n >= TARGET && now() <= c.ends_at) {
      db.prepare("UPDATE broker_challenge SET reached_at=?, reward_status='eligible' WHERE broker=?").run(now(), email);
      notify(email, 'broker', `Challenge complete: ${TARGET} verified profiles`, `You earned the ${REWARD} PKR reward. Our team will phone-verify your payout number and then pay you directly, outside the site.`);
      for (const a of admins) notify(a, 'admin', 'A broker completed the challenge', `${email} reached ${TARGET} verified profiles. Open the admin panel, Broker challenge and payouts.`);
      c = db.prepare('SELECT * FROM broker_challenge WHERE broker=?').get(email);
    }
    const status = c.reached_at ? 'completed' : now() > c.ends_at ? 'expired' : 'active';
    const po = payoutOf(email);
    return { target: TARGET, days: DAYS, rewardPkr: REWARD, count: n, remaining: Math.max(0, TARGET - n), pct: Math.min(100, Math.round((n / TARGET) * 100)), status, startedAt: c.started_at, endsAt: c.ends_at, daysLeft: Math.max(0, Math.ceil((Date.parse(c.ends_at) - Date.now()) / 86400_000)),
      reachedAt: c.reached_at, reward: { status: c.reward_status, note: c.reward_note || '', paid_at: c.reward_at }, hasPayout: !!po, payoutVerified: !!(po && po.verified_at) };
  }
  function leaderboard(email) {
    const all = db.prepare("SELECT email,profile_json FROM brokers WHERE status='approved' LIMIT 300").all().map(b => { const ch = refreshChallenge(b.email); let p = {}; try { p = JSON.parse(b.profile_json); } catch { /* none */ } return { email: b.email, name: first(p.n) || 'Broker', city: p.c || '', ch }; })
      .filter(r => r.ch && r.ch.status !== 'expired' || (r.ch && r.ch.count > 0));
    all.sort((a, b) => b.ch.count - a.ch.count || (a.ch.reachedAt || '9').localeCompare(b.ch.reachedAt || '9') || a.ch.startedAt.localeCompare(b.ch.startedAt));
    const rows = all.map((r, i) => ({ rank: i + 1, name: r.name, city: r.city, count: r.ch.count, status: r.ch.status, me: r.email === email }));
    return { top: rows.slice(0, 10), me: rows.find(r => r.me) || null, total: rows.length };
  }
  setInterval(() => { try { for (const b of db.prepare("SELECT email FROM brokers WHERE status='approved'").all()) refreshChallenge(b.email); } catch (e) { console.error('challenge refresh failed:', e.message); } }, 600_000).unref();

  const rowFor = email => { const b = db.prepare('SELECT profile_json FROM brokers WHERE email=?').get(email); let p = {}; try { p = JSON.parse(b.profile_json); } catch { /* none */ } return p; };
  app.get('/api/admin/challenge', auth, adminOnly, (req, res) => {
    const rows = db.prepare("SELECT email FROM brokers WHERE status='approved' ORDER BY updated_at DESC").all().map(b => {
      const ch = refreshChallenge(b.email), po = payoutOf(b.email), p = rowFor(b.email);
      return { email: b.email, name: p.n, ch, payout: po ? { provider: po.provider, number: po.number, verified: !!po.verified_at, verified_at: po.verified_at } : null };
    });
    const w = r => (r.ch.status === 'completed' && r.ch.reward.status === 'eligible' ? 0 : r.ch.status === 'completed' ? 2 : r.ch.status === 'active' ? 1 : 3);
    rows.sort((a, b) => w(a) - w(b) || b.ch.count - a.ch.count);
    res.json({ target: TARGET, days: DAYS, rewardPkr: REWARD, rows });
  });
  app.post('/api/admin/brokers/:email/payout-verify', auth, adminOnly, csrf, wrap(async (req, res) => {
    const email = String(req.params.email || '').toLowerCase(), po = payoutOf(email);
    if (!po) return res.status(404).json({ error: 'This broker has not given payout details.' });
    const v = req.body && req.body.verified === true;
    db.prepare('UPDATE broker_payout SET verified_at=?, verified_by=? WHERE email=?').run(v ? now() : null, v ? req.user.email : null, email);
    audit(req.user.email, v ? 'payout-verified' : 'payout-unverified', email, po.provider);
    res.json({ ok: true });
  }));
  app.post('/api/admin/brokers/:email/reward', auth, adminOnly, csrf, wrap(async (req, res) => {
    const email = String(req.params.email || '').toLowerCase(), c = db.prepare('SELECT * FROM broker_challenge WHERE broker=?').get(email), st = req.body && req.body.status;
    if (!c || !c.reached_at) return res.status(409).json({ error: 'This broker has not completed the challenge.' });
    if (!['paid', 'eligible'].includes(st)) return res.status(400).json({ error: 'Choose paid or eligible.' });
    if (st === 'paid') { const po = payoutOf(email); if (!po || !po.verified_at) return res.status(409).json({ error: 'Verify the payout number by phone first, then mark the reward paid.' }); }
    db.prepare('UPDATE broker_challenge SET reward_status=?, reward_note=?, reward_at=?, reward_by=? WHERE broker=?').run(st, s(req.body.note, 200), st === 'paid' ? now() : null, st === 'paid' ? req.user.email : null, email);
    audit(req.user.email, 'reward-' + st, email, `${REWARD} PKR`);
    if (st === 'paid') notify(email, 'broker', `Your ${REWARD} PKR reward was sent`, `We paid your challenge reward to your ${payoutOf(email).provider} number.${req.body.note ? ' ' + s(req.body.note, 200) : ''}`);
    res.json({ ok: true });
  }));

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
    return { payout: (() => { const po = payoutOf(email); return po ? { provider: po.provider, number: po.number, verified: !!po.verified_at } : null; })(), challenge: (() => { const ch = isApproved(email) ? refreshChallenge(email) : null; return ch ? { count: ch.count, target: ch.target, status: ch.status, daysLeft: ch.daysLeft, reward: ch.reward.status } : null; })(), kyc: { phone: k.phone, hasId: k.hasId, hasPhoto: k.hasPhoto }, leads: t.reduce((a, x) => a + x.n, 0), clients: db.prepare('SELECT COUNT(*) n FROM broker_clients WHERE broker=?').get(email).n };
  };
  return { hasPhoto, checkPayout, savePayout, tierOf, kyc, cleanPhone, saveContact, managed, managedCard, managedBroker, leadFromRef, leadFromChat, decided, adminInfo, purge };
};