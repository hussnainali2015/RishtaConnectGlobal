'use strict';
/**
 * Ratings and reviews for verified brokers.
 *  - One review per member per broker (rating 1 to 5, optional text). Editing replaces it.
 *  - Only a signed-in member who has actually messaged that broker may review (stops fake and drive-by reviews).
 *  - Reviewers appear as "First name + initial". Emails are never shown.
 *  - Admins can hide or restore a review (audited); any member can flag one for them.
 */
module.exports = function (x) {
  const { app, db, jwt, E, auth, csrf, adminOnly, wrap, rateLimit, now, audit, notify, opaque, byUid, mstatus, bstatus, isBlocked, s } = x;
  const PAGE = 10, MAXTXT = 600;
  const limit = (n, msg) => rateLimit({ windowMs: 3600_000, limit: n, standardHeaders: true, legacyHeaders: false, message: { error: msg } });
  const writeLimit = limit(20, 'Too many review changes. Try again later.'), flagLimit = limit(20, 'Too many reports. Try again later.');

  const brokerOf = uid => { // the opaque id used by the public broker list -> an approved, not suspended broker
    const email = byUid(uid); if (!email) return null;
    const b = db.prepare("SELECT profile_json FROM brokers WHERE email=? AND status='approved'").get(email);
    if (!b || mstatus(email) === 'suspended') return null;
    return { email, n: JSON.parse(b.profile_json).n };
  };
  const viewer = req => { try { const { email } = jwt.verify(req.cookies.rcg_session || '', E.JWT_SECRET); return db.prepare('SELECT email FROM users WHERE email=?').get(email) ? email : null; } catch { return null; } };
  const shortName = email => {
    const u = db.prepare('SELECT name,profile_json FROM users WHERE email=?').get(email);
    let full = ''; try { full = (u && u.profile_json && JSON.parse(u.profile_json).n) || ''; } catch { /* keep going */ }
    const parts = (full || (u && u.name) || 'Member').trim().split(/\s+/).filter(Boolean);
    return (parts[0] || 'Member') + (parts.length > 1 ? ' ' + [...parts[parts.length - 1]][0].toUpperCase() + '.' : '');
  };
  const summary = broker => {
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of db.prepare("SELECT rating,COUNT(*) n FROM broker_reviews WHERE broker=? AND status='published' GROUP BY rating").all(broker)) dist[r.rating] = r.n;
    const count = Object.values(dist).reduce((a, b) => a + b, 0), sum = Object.entries(dist).reduce((a, [k, v]) => a + k * v, 0);
    return { count, avg: count ? Math.round(sum / count * 10) / 10 : null, dist };
  };
  /** null when the member may review this broker, otherwise a plain sentence saying why not. */
  function why(email, broker) {
    if (!email) return 'Sign in to write a review.';
    if (email === broker) return "You can't review yourself.";
    if (mstatus(email) === 'suspended') return 'Your account is suspended.';
    if (bstatus(email) === 'approved') return 'Broker accounts cannot review other brokers.';
    const u = db.prepare('SELECT profile_json FROM users WHERE email=?').get(email);
    if (!u || !u.profile_json) return 'Create your profile first, then you can review brokers you have been in touch with.';
    if (isBlocked(email, broker)) return 'You cannot review this broker.';
    const [a, b] = email < broker ? [email, broker] : [broker, email];
    const c = db.prepare('SELECT id FROM conversations WHERE u1=? AND u2=?').get(a, b);
    if (!c || !db.prepare('SELECT 1 FROM messages WHERE conv_id=? AND sender=?').get(c.id, email)) return 'Message this broker first. Only members who have been in touch can rate their experience.';
    return null;
  }
  const clean = t => String(t || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f​-‏‪-‮]/g, '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAXTXT);
  const CONTACT = /(https?:\/\/|www\.|\b[\w.+-]+@[\w-]+\.[\w.]+|(?:\+?\d[\s().-]*){8,})/i; // links, emails and phone numbers do not belong in a public review

  app.get('/api/brokers/:id/reviews', (req, res) => {
    const b = brokerOf(req.params.id); if (!b) return res.status(404).json({ error: 'Broker not found' });
    const me = viewer(req), page = Math.max(1, parseInt(req.query.page, 10) || 1), sm = summary(b.email);
    const rows = db.prepare("SELECT id,reviewer,rating,body,created_at,updated_at FROM broker_reviews WHERE broker=? AND status='published' ORDER BY created_at DESC LIMIT ? OFFSET ?").all(b.email, PAGE, (page - 1) * PAGE);
    const own = me && db.prepare('SELECT id,rating,body,status,created_at,updated_at FROM broker_reviews WHERE broker=? AND reviewer=?').get(b.email, me);
    res.set('Cache-Control', 'no-store').json({
      summary: sm, page, pages: Math.max(1, Math.ceil(sm.count / PAGE)),
      rows: rows.map(r => ({ id: r.id, n: shortName(r.reviewer), rating: r.rating, body: r.body, at: r.created_at, edited: r.updated_at !== r.created_at, mine: r.reviewer === me })),
      mine: own ? { id: own.id, rating: own.rating, body: own.body, hidden: own.status === 'hidden' } : null,
      canReview: me ? !why(me, b.email) : false, whyNot: me ? why(me, b.email) : 'Sign in to write a review.', signedIn: !!me, max: MAXTXT,
    });
  });

  app.post('/api/brokers/:id/reviews', auth, csrf, writeLimit, wrap(async (req, res) => {
    const b = brokerOf(req.params.id); if (!b) return res.status(404).json({ error: 'Broker not found' });
    const bad = why(req.user.email, b.email); if (bad) return res.status(403).json({ error: bad });
    const rating = Number(req.body && req.body.rating), body = clean(req.body && req.body.body);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Choose a rating from 1 to 5 stars.' });
    if (rating <= 2 && body.length < 10) return res.status(400).json({ error: 'Please explain in a few words what went wrong (at least 10 characters).' });
    if (CONTACT.test(body)) return res.status(400).json({ error: 'Please do not include links, email addresses or phone numbers in a review.' });
    const old = db.prepare('SELECT id FROM broker_reviews WHERE broker=? AND reviewer=?').get(b.email, req.user.email);
    if (old) db.prepare('UPDATE broker_reviews SET rating=?, body=?, updated_at=? WHERE id=?').run(rating, body, now(), old.id);
    else {
      db.prepare('INSERT INTO broker_reviews(broker,reviewer,rating,body,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(b.email, req.user.email, rating, body, now(), now());
      notify(b.email, 'broker', 'You have a new review', `A member rated you ${rating} out of 5. Open your broker page to read it.`);
    }
    res.json({ ok: true, updated: !!old });
  }));

  app.post('/api/brokers/:id/reviews/delete', auth, csrf, writeLimit, wrap(async (req, res) => { // you can always remove your own review
    const b = brokerOf(req.params.id); if (!b) return res.status(404).json({ error: 'Broker not found' });
    const r = db.prepare('SELECT id FROM broker_reviews WHERE broker=? AND reviewer=?').get(b.email, req.user.email);
    if (!r) return res.status(404).json({ error: 'You have not reviewed this broker.' });
    db.prepare('DELETE FROM review_flags WHERE review_id=?').run(r.id); db.prepare('DELETE FROM broker_reviews WHERE id=?').run(r.id);
    res.json({ ok: true });
  }));

  app.post('/api/reviews/:rid/flag', auth, csrf, flagLimit, wrap(async (req, res) => {
    const r = db.prepare("SELECT id,reviewer,broker FROM broker_reviews WHERE id=? AND status='published'").get(Number(req.params.rid));
    if (!r) return res.status(404).json({ error: 'Review not found' });
    if (r.reviewer === req.user.email) return res.status(400).json({ error: 'This is your own review.' });
    const reason = s(req.body && req.body.reason, 200); if (reason.length < 3) return res.status(400).json({ error: 'Say briefly what is wrong with this review.' });
    db.prepare('INSERT OR IGNORE INTO review_flags(review_id,reporter,reason,created_at) VALUES(?,?,?,?)').run(r.id, req.user.email, reason, now());
    res.json({ ok: true });
  }));

  /* ---- admin ---- */
  app.get('/api/admin/reviews', auth, adminOnly, (req, res) => {
    const rows = db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM review_flags f WHERE f.review_id=r.id) AS flags FROM broker_reviews r ORDER BY (flags>0 AND r.status='published') DESC, r.created_at DESC LIMIT 200`).all();
    res.json(rows.map(r => {
      const bk = db.prepare('SELECT profile_json FROM brokers WHERE email=?').get(r.broker);
      return {
        id: r.id, broker: { email: r.broker, n: bk ? JSON.parse(bk.profile_json).n : r.broker }, reviewer: { email: r.reviewer, n: shortName(r.reviewer) },
        rating: r.rating, body: r.body, status: r.status, hidden_reason: r.hidden_reason, created_at: r.created_at, flags: r.flags,
        flag_reasons: db.prepare('SELECT reason FROM review_flags WHERE review_id=? ORDER BY created_at DESC LIMIT 5').all(r.id).map(f => f.reason),
      };
    }));
  });
  const target = (req, res) => { const r = db.prepare('SELECT id,status,reviewer,broker FROM broker_reviews WHERE id=?').get(Number(req.params.rid)); if (!r) res.status(404).json({ error: 'Review not found' }); return r; };
  app.post('/api/admin/reviews/:rid/hide', auth, adminOnly, csrf, wrap(async (req, res) => {
    const r = target(req, res); if (!r) return;
    const reason = s(req.body && req.body.reason, 200); if (reason.length < 3) return res.status(400).json({ error: 'Enter a reason' });
    db.prepare("UPDATE broker_reviews SET status='hidden', hidden_reason=?, hidden_by=?, hidden_at=? WHERE id=?").run(reason, req.user.email, now(), r.id);
    audit(req.user.email, 'hide-review', 'review:' + r.id, reason);
    notify(r.reviewer, 'review', 'Your review was hidden', 'A moderator hid your broker review because it did not follow our review rules. You can edit it and it will stay hidden until a moderator restores it.');
    res.json({ status: 'hidden' });
  }));
  app.post('/api/admin/reviews/:rid/show', auth, adminOnly, csrf, wrap(async (req, res) => {
    const r = target(req, res); if (!r) return;
    db.prepare("UPDATE broker_reviews SET status='published', hidden_reason=NULL, hidden_by=NULL, hidden_at=NULL WHERE id=?").run(r.id);
    db.prepare('DELETE FROM review_flags WHERE review_id=?').run(r.id); // cleared once a moderator has decided it is fine
    audit(req.user.email, 'restore-review', 'review:' + r.id);
    res.json({ status: 'published' });
  }));

  return { summary };
};
