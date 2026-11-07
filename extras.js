'use strict';
/**
 * Added routes: legal pages, plans, health check, member detail, shortlist, profile photos,
 * account data download and account deletion. Registered from server.js with the shared helpers.
 */
const legal = require('./legal');

/** Drop everything from a JPEG that could carry personal data or hidden content (EXIF/GPS, XMP, comments, trailing bytes). Returns null if it is not a sane JPEG. */
function cleanJpeg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 134 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  const out = [buf.subarray(0, 2)];
  let i = 2, w = 0, h = 0, sof = false, sos = false;
  while (i < buf.length && !sos) {
    if (buf[i] !== 0xFF) return null;
    while (buf[i] === 0xFF) i++;
    const m = buf[i++];
    if (m === 0xD9) break;
    if (m === 0x00) return null;
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { out.push(Buffer.from([0xFF, m])); continue; }
    if (i + 2 > buf.length) return null;
    const len = buf.readUInt16BE(i);
    if (len < 2 || i + len > buf.length) return null;
    if (m === 0xDA) { out.push(buf.subarray(i - 2)); sos = true; break; } // start of scan: the picture data follows
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) { if (len < 8) return null; h = buf.readUInt16BE(i + 3); w = buf.readUInt16BE(i + 5); sof = true; }
    const drop = (m >= 0xE1 && m <= 0xED) || m === 0xEF || m === 0xFE; // APP1-APP13, APP15 and comments; APP0 (JFIF) and APP14 (colour flag) stay
    if (!drop) out.push(buf.subarray(i - 2, i + len));
    i += len;
  }
  if (!sof || !sos || w < 64 || h < 64 || w > 6000 || h > 6000) return null;
  let res = Buffer.concat(out);
  const end = res.lastIndexOf(Buffer.from([0xFF, 0xD9]));
  if (end < 0) return null;
  res = res.subarray(0, end + 2); // nothing after the end-of-image marker
  return res;
}

module.exports = function (x) {
  const { app, express, db, auth, csrf, adminOnly, wrap, rateLimit, crypto, E, now, audit, notify, opaque, byUid, membership, mstatus, vstate, isBlocked, PLANS, CUR, admins, founderState, viewerEmail } = x;
  const cfg = {
    name: E.BUSINESS_NAME || 'Rishta Connect Global', email: E.SUPPORT_EMAIL || '', reviewed: E.LEGAL_REVIEWED === 'true',
    juris: E.LEGAL_JURISDICTION || 'the laws of the country where the operator of this website is established', backupDays: String(parseInt(E.BACKUP_KEEP, 10) || 14),
  };

  db.exec(`
CREATE TABLE IF NOT EXISTS photos(email TEXT PRIMARY KEY, data BLOB NOT NULL, visible INTEGER NOT NULL DEFAULT 0, updated_at TEXT);
CREATE TABLE IF NOT EXISTS shortlist(owner TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT, PRIMARY KEY(owner,target));
`);
  for (const c of ['consent_at']) if (!db.prepare('PRAGMA table_info(users)').all().some(r => r.name === c)) db.exec('ALTER TABLE users ADD COLUMN ' + c + ' TEXT');

  /* ---- health, robots, legal ---- */
  app.get('/healthz', (req, res) => { try { db.prepare('SELECT 1').get(); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); } });
  app.get('/robots.txt', (req, res) => { res.type('text/plain'); res.send('User-agent: *\nDisallow: /api/\nDisallow: /payment/\n'); });
  for (const p of ['terms', 'privacy', 'safety', 'contact']) app.get('/' + p, (req, res) => res.type('html').send(legal[p](cfg)));

  /* ---- plans (prices come only from the server) ---- */
  app.get('/api/plans', (req, res) => { // the Founder plan is shown to visitors while spots remain, and to the founders themselves; other members do not see it
    const fs = founderState(viewerEmail(req)), me = viewerEmail(req);
    res.json(Object.entries(PLANS).filter(([id, p]) => !p.founder || fs.mine || (!me && fs.left > 0)).map(([id, p]) => {
      const o = { id, name: p.name, price: p.price, months: p.months, currency: CUR, features: p.features || [] };
      if (p.founder) Object.assign(o, { founder: true, was: PLANS.plus.price, limit: fs.limit, left: fs.left, n: fs.mine });
      return o;
    }));
  });

  /* ---- member detail and shortlist ---- */
  const needActive = (req, res) => {
    if (!membership(req.user.email).active) { res.status(403).json({ error: 'Activate your profile with a membership to view members.' }); return false; }
    if (mstatus(req.user.email) !== 'approved') { res.status(403).json({ error: 'Your profile is awaiting approval.' }); return false; }
    return true;
  };
  const visible = (viewer, email) => { // the one rule for "may this viewer see this member"
    const u = db.prepare('SELECT profile_json FROM users WHERE email=?').get(email);
    return !!(u && u.profile_json && email !== viewer && membership(email).active && mstatus(email) === 'approved' && !isBlocked(viewer, email));
  };
  const hasPhoto = email => !!db.prepare('SELECT 1 FROM photos WHERE email=? AND visible=1').get(email);
  const card = (viewer, email) => {
    const p = JSON.parse(db.prepare('SELECT profile_json FROM users WHERE email=?').get(email).profile_json);
    return { id: opaque(email), n: p.n, g: p.g, a: p.a, c: p.c, m: p.m, e: p.e, j: p.j, x: p.x, w: p.w, verified: vstate(email).verified, ph: hasPhoto(email), sl: !!db.prepare('SELECT 1 FROM shortlist WHERE owner=? AND target=?').get(viewer, email) };
  };
  app.get('/api/members/:id', auth, wrap(async (req, res) => {
    if (!needActive(req, res)) return;
    const email = byUid(req.params.id);
    if (!email || !visible(req.user.email, email)) return res.status(404).json({ error: 'This member is unavailable.' });
    res.json(card(req.user.email, email));
  }));
  app.get('/api/shortlist', auth, wrap(async (req, res) => {
    if (!needActive(req, res)) return;
    const rows = db.prepare('SELECT target FROM shortlist WHERE owner=? ORDER BY created_at DESC').all(req.user.email);
    res.json(rows.filter(r => visible(req.user.email, r.target)).map(r => card(req.user.email, r.target)));
  }));
  app.post('/api/shortlist', auth, csrf, wrap(async (req, res) => {
    if (!needActive(req, res)) return;
    const email = byUid(req.body && req.body.user);
    if (!email || !visible(req.user.email, email)) return res.status(404).json({ error: 'This member is unavailable.' });
    if (db.prepare('SELECT COUNT(*) n FROM shortlist WHERE owner=?').get(req.user.email).n >= 200) return res.status(400).json({ error: 'Your shortlist is full (200).' });
    db.prepare('INSERT OR IGNORE INTO shortlist(owner,target,created_at) VALUES(?,?,?)').run(req.user.email, email, now());
    res.json({ ok: true });
  }));
  app.post('/api/shortlist/remove', auth, csrf, wrap(async (req, res) => {
    const email = byUid(req.body && req.body.user);
    if (email) db.prepare('DELETE FROM shortlist WHERE owner=? AND target=?').run(req.user.email, email);
    res.json({ ok: true });
  }));

  /* ---- profile photos: JPEG only, cleaned, hidden until the owner shows it, shown only to active members ---- */
  const photoLimit = rateLimit({ windowMs: 3600_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many photo uploads. Try again later.' } });
  const sendJpeg = (res, data) => {
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.end(data);
  };
  app.post('/api/photo', auth, csrf, photoLimit, express.raw({ type: 'image/jpeg', limit: '1200kb' }), wrap(async (req, res) => {
    if (!req.user.profile_json) return res.status(409).json({ error: 'Create your profile first.' });
    const clean = cleanJpeg(req.body);
    if (!clean) return res.status(400).json({ error: 'Please choose a JPEG photo (at least 64 pixels wide).' });
    db.prepare('INSERT INTO photos(email,data,visible,updated_at) VALUES(?,?,0,?) ON CONFLICT(email) DO UPDATE SET data=excluded.data, visible=0, updated_at=excluded.updated_at').run(req.user.email, clean, now());
    db.prepare("UPDATE verification SET photo=0, updated_at=? WHERE email=?").run(now(), req.user.email); // a new picture must be checked again
    res.json({ ok: true, visible: false });
  }));
  app.post('/api/photo/visibility', auth, csrf, wrap(async (req, res) => {
    const v = req.body && req.body.visible === true ? 1 : 0;
    const r = db.prepare('UPDATE photos SET visible=? WHERE email=?').run(v, req.user.email);
    if (!r.changes) return res.status(404).json({ error: 'Upload a photo first.' });
    res.json({ ok: true, visible: !!v });
  }));
  app.post('/api/photo/remove', auth, csrf, wrap(async (req, res) => {
    db.prepare('DELETE FROM photos WHERE email=?').run(req.user.email);
    db.prepare("UPDATE verification SET photo=0, updated_at=? WHERE email=?").run(now(), req.user.email);
    res.json({ ok: true });
  }));
  app.get('/api/photo/me', auth, (req, res) => {
    const r = db.prepare('SELECT data FROM photos WHERE email=?').get(req.user.email);
    r ? sendJpeg(res, r.data) : res.status(404).json({ error: 'No photo' });
  });
  app.get('/api/photo/:id', auth, (req, res) => {
    const email = byUid(req.params.id);
    if (!email || !membership(req.user.email).active || mstatus(req.user.email) !== 'approved' || !visible(req.user.email, email)) return res.status(404).json({ error: 'No photo' });
    const r = db.prepare('SELECT data FROM photos WHERE email=? AND visible=1').get(email);
    r ? sendJpeg(res, r.data) : res.status(404).json({ error: 'No photo' });
  });
  app.get('/api/admin/photo/:email', auth, adminOnly, (req, res) => {
    const r = db.prepare('SELECT data FROM photos WHERE email=?').get(String(req.params.email || '').toLowerCase());
    r ? sendJpeg(res, r.data) : res.status(404).json({ error: 'No photo' });
  });
  app.post('/api/admin/photo/:email/remove', auth, adminOnly, csrf, wrap(async (req, res) => {
    const email = String(req.params.email || '').toLowerCase(), reason = String((req.body && req.body.reason) || '').trim().slice(0, 300);
    if (!reason) return res.status(400).json({ error: 'Enter a reason.' });
    const del = db.transaction(() => {
      const r = db.prepare('DELETE FROM photos WHERE email=?').run(email);
      if (!r.changes) return false;
      db.prepare('UPDATE verification SET photo=0, updated_at=? WHERE email=?').run(now(), email);
      audit(req.user.email, 'photo-removed', email, reason);
      notify(email, 'photo', 'Your photo was removed', 'Our team removed your profile photo because it did not follow the rules (' + reason + '). You can upload a different one in Settings.');
      return true;
    });
    del() ? res.json({ ok: true }) : res.status(404).json({ error: 'No photo' });
  }));
  app.get('/api/admin/photos', auth, adminOnly, (req, res) => res.json(db.prepare('SELECT email FROM photos').all().map(r => r.email)));

  /* ---- account: download my data, delete my account ---- */
  const ghost = email => 'deleted-' + crypto.createHmac('sha256', E.JWT_SECRET).update(email).digest('hex').slice(0, 12);
  app.get('/api/account/export', auth, wrap(async (req, res) => {
    const em = req.user.email, one = (sql, ...a) => db.prepare(sql).all(...a);
    const photo = db.prepare('SELECT data,visible FROM photos WHERE email=?').get(em);
    const convs = one('SELECT * FROM conversations WHERE u1=? OR u2=?', em, em);
    const data = {
      exported_at: now(),
      account: { email: em, name: req.user.name, sign_in: req.user.provider, created_at: req.user.created_at, terms_accepted_at: req.user.consent_at || null, status: mstatus(em) },
      profile: req.user.profile_json ? JSON.parse(req.user.profile_json) : null,
      membership: membership(em), verification: vstate(em),
      photo: photo ? { shown_to_members: !!photo.visible, jpeg_base64: photo.data.toString('base64') } : null,
      payments: one('SELECT id,plan,amount,currency,status,created_at,paid_at,refunded_at FROM payments WHERE email=? ORDER BY created_at', em),
      conversations: convs.map(c => ({ with: x.whoIs(c.u1 === em ? c.u2 : c.u1).n, messages: one('SELECT sender,body,created_at FROM messages WHERE conv_id=? ORDER BY id LIMIT 5000', c.id).map(m => ({ from: m.sender === em ? 'you' : 'them', body: m.body, at: m.created_at })) })),
      broker_reviews_written: one('SELECT b.rating,b.body,b.status,b.created_at,b.updated_at FROM broker_reviews b WHERE b.reviewer=? ORDER BY b.id', em),
      shortlist_count: db.prepare('SELECT COUNT(*) n FROM shortlist WHERE owner=?').get(em).n,
      blocked_count: db.prepare('SELECT COUNT(*) n FROM blocks WHERE blocker=?').get(em).n,
      notifications: one('SELECT title,body,created_at FROM notifications WHERE email=? ORDER BY id', em),
      warnings: one('SELECT message,status,created_at FROM warnings WHERE email=? ORDER BY id', em),
      appeals: one('SELECT kind,message,status,admin_note,created_at,resolved_at FROM appeals WHERE email=? ORDER BY id', em),
      broker_application: (() => { const b = db.prepare('SELECT profile_json,status,created_at FROM brokers WHERE email=?').get(em); return b ? { ...JSON.parse(b.profile_json), status: b.status, created_at: b.created_at } : null; })(),
    };
    res.set({ 'Content-Disposition': 'attachment; filename="my-rishta-data.json"', 'Cache-Control': 'no-store' });
    res.json(data);
  }));

  const delLimit = rateLimit({ windowMs: 3600_000, limit: 10, standardHeaders: true, legacyHeaders: false });
  app.post('/api/account/delete', auth, csrf, delLimit, wrap(async (req, res) => {
    const em = req.user.email;
    if (!req.body || req.body.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm.' });
    if (mstatus(em) === 'suspended') return res.status(403).json({ error: 'Your account is suspended. Contact support.' });
    const recent = new Date(Date.now() - 2 * 3600_000).toISOString();
    if (db.prepare("SELECT 1 FROM payments WHERE email=? AND status='pending' AND created_at>?").get(em, recent)) return res.status(409).json({ error: 'A payment is still being confirmed. Try again in a few minutes.' });
    const g = ghost(em);
    db.transaction(() => {
      const cids = db.prepare('SELECT id FROM conversations WHERE u1=? OR u2=?').all(em, em).map(r => r.id);
      for (const id of cids) { db.prepare('DELETE FROM messages WHERE conv_id=?').run(id); db.prepare('DELETE FROM conv_reads WHERE conv_id=?').run(id); db.prepare('DELETE FROM conversations WHERE id=?').run(id); }
      for (const [t, col] of [['photos', 'email'], ['memberships', 'email'], ['verification', 'email'], ['member_status', 'email'], ['brokers', 'email'], ['uid_map', 'email'], ['notifications', 'email'], ['warnings', 'email'], ['appeals', 'email'], ['conv_reads', 'email'], ['broker_reviews', 'reviewer'], ['broker_reviews', 'broker'], ['review_flags', 'reporter'], ['shortlist', 'owner'], ['shortlist', 'target'], ['blocks', 'blocker'], ['blocks', 'blocked']]) db.prepare('DELETE FROM ' + t + ' WHERE ' + col + '=?').run(em);
      db.prepare('DELETE FROM review_flags WHERE review_id NOT IN (SELECT id FROM broker_reviews)').run();
      db.prepare('UPDATE payments SET email=? WHERE email=?').run(g, em); // accounting records stay, without the email
      db.prepare('UPDATE reports SET reporter=? WHERE reporter=?').run(g, em);
      db.prepare('DELETE FROM users WHERE email=?').run(em);
      audit('self', 'account-deleted', g, 'member deleted own account');
    })();
    res.clearCookie('rcg_session');
    res.json({ ok: true });
  }));

  return { cleanJpeg };
};
module.exports.cleanJpeg = cleanJpeg;
