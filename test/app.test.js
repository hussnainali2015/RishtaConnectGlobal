'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { startServer, dirtyJpeg } = require('./helpers');

/** phone and ID checks are covered by their own test; other broker tests just record that they passed */
function kycDone(srv, email) {
    srv.db.prepare('INSERT OR REPLACE INTO broker_photos(email,data,uploaded_at) VALUES(?,?,?)').run(email, Buffer.from('x'), new Date().toISOString());
  srv.db.prepare('INSERT OR REPLACE INTO broker_ids(email,data,uploaded_at) VALUES(?,?,?)').run(email, Buffer.from('x'), new Date().toISOString());
}

let S;
before(async () => { S = await startServer(); });
after(async () => { if (S) await S.stop(); });

const PROFILE = { n: 'Test Person', g: 'Female', a: 28, c: 'Riyadh', m: 'Never married', e: 'Bachelor', j: 'Teacher', x: 'About me text', w: 'Looking for text', agree: true };
/** A member with a saved profile (the site is free, so that is all it takes). With withProfile=false: signed in but no profile yet. */
async function member(email, over = {}, withProfile = true) {
  const c = S.as(email, over.n || email.split('@')[0]);
  if (!withProfile) return c;
  const r = await c.post('/api/profile', { ...PROFILE, ...over });
  assert.equal(r.status, 200, 'profile: ' + r.text);
  return c;
}
const uidOf = async (viewer, name) => (await viewer.get('/api/members?c=')).json.rows.find(m => m.n === name).id;

/* ---------- basics ---------- */
test('health, no payment routes, legal pages, robots, unknown API route', async () => {
  const a = S.anon();
  assert.deepEqual((await a.get('/healthz')).json, { ok: true });
  for (const p of ['/api/plans', '/api/checkout', '/api/admin/payments', '/api/moyasar/webhook', '/payment/return/x']) assert.equal((await a.get(p)).status, 404, p + ' must not exist: the site takes no payments');
  for (const p of ['terms', 'privacy', 'safety', 'contact']) {
    const r = await a.get('/' + p); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /html/);
  }
  assert.match((await a.get('/contact')).text, /help@example\.test/);
  assert.match((await a.get('/terms')).text, /Draft text/, 'unreviewed legal text is flagged');
  assert.match((await a.get('/robots.txt')).text, /Disallow: \/api\//);
  const nf = await a.get('/api/nothing-here'); assert.equal(nf.status, 404); assert.ok(nf.json.error);
  assert.match((await a.get('/')).text, /Rishta/);
});

test('sign-in is required and the CSRF header is enforced', async () => {
  const a = S.anon();
  assert.equal((await a.get('/api/me')).status, 401);
  assert.equal((await a.get('/api/members')).status, 401);
  const c = S.as('csrf@test.com');
  const r = await c.raw('POST', '/api/profile', PROFILE, { 'x-requested-with': '' });
  assert.equal(r.status, 403);
  const cfg = (await a.get('/api/config')).json;
  assert.equal(cfg.paymentMode, undefined); assert.ok(!/moyasar|payment/i.test(JSON.stringify(cfg)));
});

/* ---------- profile ---------- */
test('profile: consent required once, validation, edit keeps working', async () => {
  const c = S.as('prof@test.com');
  assert.equal((await c.post('/api/profile', { ...PROFILE, agree: false })).status, 400);
  assert.equal((await c.post('/api/profile', { ...PROFILE, a: 15 })).status, 400);
  assert.equal((await c.post('/api/profile', { ...PROFILE, n: '' })).status, 400);
  assert.equal((await c.post('/api/profile', PROFILE)).status, 200);
  const me = (await c.get('/api/me')).json;
  assert.equal(me.consent, true); assert.equal(me.profile.n, 'Test Person'); assert.equal(me.membership, undefined);
  const edit = await c.post('/api/profile', { ...PROFILE, n: 'Renamed Person', agree: false });
  assert.equal(edit.status, 200, 'editing later does not need the box again');
  assert.equal((await c.get('/api/me')).json.profile.n, 'Renamed Person');
  assert.equal((await c.post('/api/profile', { ...PROFILE, m: '<script>' })).status, 200);
  assert.equal((await c.get('/api/me')).json.profile.m, 'Never married', 'unknown marital value is normalised');
});

test('search: filters, pagination, verified first, blocked/unpaid hidden, no emails leak', async () => {
  const me = await member('s-me@test.com', { n: 'Searcher', g: 'Male', a: 30 });
  for (let i = 1; i <= 14; i++) await member(`s-f${i}@test.com`, { n: `Fem ${i}`, g: 'Female', a: 20 + i, c: i % 2 ? 'Zz-Search Jeddah' : 'Zz-Search Dubai', j: i == 3 ? 'Surgeon' : 'Clerk', m: i == 4 ? 'Divorced' : 'Never married' });
  await member('s-unpaid@test.com', { n: 'Unpaid Girl', g: 'Female' }, false);
  const r = await me.get('/api/members?g=Female&c=zz-search');
  assert.equal(r.json.total, 14); assert.equal(r.json.rows.length, 12); assert.equal(r.json.pages, 2);
  assert.equal((await me.get('/api/members?g=Female&c=zz-search&page=2')).json.rows.length, 2);
  assert.ok(!r.text.includes('@'), 'no email address in search results');
  assert.ok(!r.text.includes('Unpaid Girl'));
  assert.equal((await me.get('/api/members?g=Female&c=zz-search dubai')).json.total, 7);
  assert.equal((await me.get('/api/members?j=surg&c=zz-search')).json.rows[0].n, 'Fem 3');
  assert.equal((await me.get('/api/members?m=Divorced&c=zz-search')).json.rows[0].n, 'Fem 4');
  assert.equal((await me.get('/api/members?lo=30&hi=32&g=Female&c=zz-search')).json.total, 3);
  S.db.prepare("UPDATE verification SET identity=1,photo=1,background=1 WHERE email='s-f9@test.com'").run();
  assert.equal((await me.get('/api/members?g=Female&c=zz-search')).json.rows[0].n, 'Fem 9', 'verified members come first');
  const id = await uidOf(me, 'Fem 5');
  await me.post('/api/blocks', { user: id });
  assert.equal((await me.get('/api/members?g=Female&c=zz-search')).json.total, 13, 'blocked members disappear');
  assert.equal((await S.as('s-f5@test.com').get('/api/members')).json.rows.some(m => m.n === 'Searcher'), false, 'and the block works both ways');
});

test('member page and shortlist', async () => {
  const me = await member('d-me@test.com', { n: 'Viewer', g: 'Male' });
  await member('d-her@test.com', { n: 'Her Name', g: 'Female' });
  await member('d-unpaid@test.com', { n: 'Unpaid Viewer' }, false);
  const id = await uidOf(me, 'Her Name');
  const det = await me.get('/api/members/' + id);
  assert.equal(det.status, 200); assert.equal(det.json.w, 'Looking for text'); assert.ok(!det.text.includes('@'));
  assert.equal((await me.get('/api/members/deadbeefdeadbeef')).status, 404);
  assert.equal((await S.as('d-unpaid@test.com').get('/api/members/' + id)).status, 403);
  assert.equal((await me.get('/api/shortlist')).json.length, 0);
  assert.equal((await me.post('/api/shortlist', { user: id })).status, 200);
  assert.equal((await me.get('/api/shortlist')).json[0].n, 'Her Name');
  assert.equal((await me.get('/api/members/' + id)).json.sl, true);
  assert.equal((await me.post('/api/shortlist', { user: 'nonsense' })).status, 404);
  await me.post('/api/blocks', { user: id });
  assert.equal((await me.get('/api/shortlist')).json.length, 0, 'a blocked member leaves the shortlist view');
  await me.post('/api/blocks/remove', { user: id });
  assert.equal((await me.get('/api/shortlist')).json.length, 1);
  await me.post('/api/shortlist/remove', { user: id });
  assert.equal((await me.get('/api/shortlist')).json.length, 0);
});

/* ---------- chat, brokers, block, report, warn, suspend, appeal ---------- */
test('chat rules: both sides need a profile (free) and approval; blocking stops it; brokers reply only', async () => {
  const a = await member('c-a@test.com', { n: 'Chat A' }), b = await member('c-b@test.com', { n: 'Chat B' }), u = await member('c-u@test.com', { n: 'Chat U' }, false);
  const bId = await uidOf(a, 'Chat B');
  const first = await a.post('/api/chats', { to: bId, body: 'Assalamu Alaikum' });
  assert.equal(first.status, 200, first.text);
  const convs = (await b.get('/api/chats')).json; assert.equal(convs[0].last.body, 'Assalamu Alaikum'); assert.equal(convs[0].unread, 1);
  assert.equal((await b.post(`/api/chats/${first.json.id}/messages`, { body: 'Wa alaikum' })).status, 200);
  assert.equal((await S.as('c-u@test.com').post('/api/chats', { to: bId, body: 'hi' })).status >= 400, true, 'a member without a profile cannot start a chat');
  // an outsider cannot read it
  assert.equal((await S.as('c-u@test.com').get('/api/chats/' + first.json.id)).status >= 400, true);
  await b.post('/api/blocks', { user: await (async () => (await b.get('/api/chats')).json[0].with.id)() });
  assert.ok((await a.post(`/api/chats/${first.json.id}/messages`, { body: 'still there?' })).status >= 400, 'a blocked member cannot message');
  // broker
  const bk = S.as('broker@test.com', 'Bro Ker'); kycDone(S, 'broker@test.com');
  assert.equal((await bk.post('/api/broker/apply', { n: 'Bro Ker', c: 'Riyadh', e: '5 years', l: 'Urdu', s: 'Families', x: 'Hello', ph: '+966500000001', pp: 'JazzCash', pn: '0300 1234567' })).status, 200);
  assert.equal((await bk.get('/api/brokers')).json.length, 0, 'pending brokers are not listed');
  const admin = S.as('admin@test.com');
  assert.equal((await admin.post('/api/admin/brokers/broker%40test.com/approve', {})).status, 200);
  const list = (await S.anon().get('/api/brokers')).json; assert.equal(list.length, 1); assert.ok(!JSON.stringify(list).includes('@'));
  assert.ok((await u.post('/api/chats', { to: list[0].id, body: 'Please help me' })).status >= 400, 'a signed-in person without a profile cannot contact a broker');
  const u2 = await member('c-u2@test.com', { n: 'Chat U2' });
  const ch = await u2.post('/api/chats', { to: list[0].id, body: 'Please help me' });
  assert.equal(ch.status, 200, 'any member with a profile can contact a broker: ' + ch.text);
  assert.equal((await bk.post(`/api/chats/${ch.json.id}/messages`, { body: 'Happy to help' })).status, 200);
});

test('report → warn → suspend → appeal, with notifications and the different-admin rule', async () => {
  const rep = await member('r-rep@test.com', { n: 'Reporter' }), bad = await member('r-bad@test.com', { n: 'Bad Actor' });
  const badId = await uidOf(rep, 'Bad Actor');
  assert.equal((await rep.post('/api/reports', { user: badId, category: 'scam', details: 'asked for money', source: 'search' })).status, 200);
  assert.equal((await rep.post('/api/reports', { user: badId, category: 'scam' })).status, 409, 'one open report at a time');
  const a1 = S.as('admin@test.com'), a2 = S.as('admin2@test.com');
  assert.equal((await rep.get('/api/admin/reports')).status, 403);
  let q = (await a1.get('/api/admin/reports')).json; const r1 = q.open.find(x => x.reported.email === 'r-bad@test.com');
  assert.ok(r1);
  assert.equal((await a1.post(`/api/admin/reports/${r1.id}/resolve`, { outcome: 'warn', note: 'first warning' })).status, 200);
  const w = (await bad.get('/api/warnings')).json; assert.equal(w.length, 1);
  assert.ok((await rep.get('/api/notifications')).json.rows.length >= 1, 'the reporter is told the outcome');
  assert.equal((await bad.post('/api/appeals', { kind: 'warning', ref: w[0].id, message: 'I did nothing wrong, please look again at this.' })).status, 200);
  const ap = (await a2.get('/api/admin/appeals')).json.open[0];
  assert.equal((await a1.post(`/api/admin/appeals/${ap.id}/decide`, { decision: 'uphold', note: 'same admin' })).status >= 400, true, 'the admin who warned cannot judge the appeal');
  assert.equal((await a2.post(`/api/admin/appeals/${ap.id}/decide`, { decision: 'uphold', note: 'checked again' })).status, 200);
  // suspend
  await rep.post('/api/blocks/remove', { user: badId });
  await rep.post('/api/reports', { user: badId, category: 'harassment', source: 'search' });
  q = (await a1.get('/api/admin/reports')).json; const r2 = q.open.find(x => x.reported.email === 'r-bad@test.com');
  assert.equal((await a1.post(`/api/admin/reports/${r2.id}/resolve`, { outcome: 'suspend', note: 'serious' })).status, 200);
  assert.equal((await bad.get('/api/members')).status, 403, 'a suspended member cannot search');
  assert.equal((await bad.get('/api/me')).json.status, 'suspended');
  assert.equal((await rep.get('/api/members?g=Female')).json.rows.some(m => m.n === 'Bad Actor'), false);
  assert.equal((await bad.post('/api/appeals', { kind: 'suspension', message: 'Please review my suspension, it was a mistake.' })).status, 200);
  assert.equal((await bad.post('/api/account/delete', { confirm: 'DELETE' })).status, 403, 'a suspended member cannot erase the record by deleting');
  const ap2 = (await a2.get('/api/admin/appeals')).json.open[0];
  assert.equal((await a2.post(`/api/admin/appeals/${ap2.id}/decide`, { decision: 'overturn', note: 'reinstated' })).status, 200);
  assert.equal((await bad.get('/api/me')).json.status, 'approved');
});

/* ---------- photos ---------- */
test('photos: cleaned, hidden by default, shown only to members with a profile, admin review', async () => {
  const owner = await member('p-own@test.com', { n: 'Photo Owner' }), viewer = await member('p-view@test.com', { n: 'Photo Viewer', g: 'Male' });
  const unpaid = await member('p-unpaid@test.com', { n: 'Photo Unpaid' }, false), blocked = await member('p-blk@test.com', { n: 'Photo Blocked' });
  const ownerId = await uidOf(viewer, 'Photo Owner');
  const jpg = (c, body) => c.raw('POST', '/api/photo', body, { 'content-type': 'image/jpeg' });
  assert.equal((await jpg(owner, Buffer.from('GIF89a not a jpeg'.padEnd(200)))).status, 400);
  assert.equal((await jpg(owner, dirtyJpeg().subarray(0, 100))).status, 400, 'truncated file');
  assert.equal((await owner.raw('POST', '/api/photo', dirtyJpeg(), { 'content-type': 'image/png' })).status, 400, 'wrong content type');
  assert.equal((await S.as('nopro@test.com').raw('POST', '/api/photo', dirtyJpeg(), { 'content-type': 'image/jpeg' })).status, 409, 'profile first');
  assert.equal((await jpg(owner, Buffer.concat([dirtyJpeg(), Buffer.alloc(1300 * 1024)]))).status, 413);
  assert.equal((await jpg(owner, dirtyJpeg())).status, 200);
  const stored = S.db.prepare('SELECT data,visible FROM photos WHERE email=?').get('p-own@test.com');
  const txt = Buffer.from(stored.data).toString('latin1');
  for (const secret of ['GPS-SECRET', 'XMP-SECRET', 'COMMENT-SECRET', 'TRAILING-SECRET']) assert.ok(!txt.includes(secret), secret + ' must be stripped');
  assert.ok(txt.includes('JFIF')); assert.equal(stored.visible, 0);
  assert.equal(Buffer.from(stored.data).subarray(-2).toString('hex'), 'ffd9');
  const mine = await owner.get('/api/photo/me'); assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('content-type'), 'image/jpeg'); assert.equal(mine.headers.get('x-content-type-options'), 'nosniff'); assert.match(mine.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await viewer.get('/api/photo/' + ownerId)).status, 404, 'hidden by default');
  assert.equal((await viewer.get('/api/members?c=')).json.rows.find(m => m.n === 'Photo Owner').ph, false);
  assert.equal((await owner.post('/api/photo/visibility', { visible: true })).status, 200);
  assert.equal((await viewer.get('/api/photo/' + ownerId)).status, 200);
  assert.equal((await viewer.get('/api/members?c=')).json.rows.find(m => m.n === 'Photo Owner').ph, true);
  assert.equal((await unpaid.get('/api/photo/' + ownerId)).status, 404, 'not for people without a profile');
  assert.equal((await S.anon().get('/api/photo/' + ownerId)).status, 401);
  const bid = await uidOf(viewer, 'Photo Blocked'); await owner.post('/api/blocks', { user: bid });
  assert.equal((await blocked.get('/api/photo/' + ownerId)).status, 404, 'blocked members cannot see it');
  // a new upload hides it again and resets the Photo verification
  S.db.prepare("UPDATE verification SET photo=1 WHERE email='p-own@test.com'").run();
  await jpg(owner, dirtyJpeg());
  assert.equal(S.db.prepare('SELECT visible FROM photos WHERE email=?').get('p-own@test.com').visible, 0);
  assert.equal(S.db.prepare('SELECT photo FROM verification WHERE email=?').get('p-own@test.com').photo, 0);
  // admin
  const admin = S.as('admin@test.com');
  assert.equal((await admin.get('/api/admin/photo/p-own%40test.com')).status, 200);
  assert.equal((await viewer.get('/api/admin/photo/p-own%40test.com')).status, 403);
  assert.equal((await admin.post('/api/admin/photo/p-own%40test.com/remove', { reason: '' })).status, 400);
  assert.equal((await admin.post('/api/admin/photo/p-own%40test.com/remove', { reason: 'shows another person' })).status, 200);
  assert.equal((await owner.get('/api/photo/me')).status, 404);
  assert.ok((await owner.get('/api/notifications')).json.rows.some(n => /photo was removed/i.test(n.title)));
  assert.equal((await owner.post('/api/photo/visibility', { visible: true })).status, 404);
});

/* ---------- account: export and delete ---------- */
test('account: data download and deletion', async () => {
  const a = await member('x-a@test.com', { n: 'Leaver' }), b = await member('x-b@test.com', { n: 'Stayer' });
  const bId = await uidOf(a, 'Stayer');
  const ch = await a.post('/api/chats', { to: bId, body: 'hello from the leaver' });
  await a.raw('POST', '/api/photo', dirtyJpeg(), { 'content-type': 'image/jpeg' });
  await a.post('/api/shortlist', { user: bId });
  const ex = await a.get('/api/account/export');
  assert.equal(ex.status, 200); assert.match(ex.headers.get('content-disposition'), /attachment/);
  assert.equal(ex.json.profile.n, 'Leaver'); assert.equal(ex.json.conversations[0].messages[0].body, 'hello from the leaver');
  assert.ok(ex.json.photo.jpeg_base64.length > 20); assert.equal(ex.json.payments, undefined);
  assert.ok(!ex.text.includes('x-b@test.com'), "someone else's email is never in my export");
  assert.equal((await S.anon().get('/api/account/export')).status, 401);

  assert.equal((await a.post('/api/account/delete', { confirm: 'delete' })).status, 400);
  assert.equal((await a.post('/api/account/delete', {})).status, 400);
  const del = await a.post('/api/account/delete', { confirm: 'DELETE' });
  assert.equal(del.status, 200, del.text);
  assert.match(del.headers.get('set-cookie') || '', /rcg_session=;/);
  for (const [t, col] of [['users', 'email'], ['photos', 'email'], ['verification', 'email'], ['shortlist', 'owner'], ['uid_map', 'email']]) assert.equal(S.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${col}='x-a@test.com'`).get().n, 0, t);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM messages WHERE conv_id=?').get(ch.json.id).n, 0);
  assert.equal((await b.get('/api/chats')).json.length, 0);
  assert.equal((await b.get('/api/members?c=')).json.rows.some(m => m.n === 'Leaver'), false);
  assert.ok((await S.as('admin@test.com').get('/api/admin/audit')).json.rows.some(r => r.action === 'account-deleted'));
  assert.ok(!JSON.stringify((await S.as('admin@test.com').get('/api/admin/audit')).json).includes('x-a@test.com'), 'the audit entry does not hold the email');
  // the old session no longer works; signing in again starts fresh and needs consent again
  assert.equal((await a.get('/api/me')).status, 401);
  S.db.prepare("INSERT INTO users(email,name,provider,created_at) VALUES('x-a@test.com','Leaver','google',?)").run(new Date().toISOString());
  const again = (await a.get('/api/me')).json; assert.equal(again.profile, null); assert.equal(again.consent, false);
});

/* ---------- admin: verification, audit CSV, backups ---------- */
test('admin: verification and revoke, members, audit log CSV is safe', async () => {
  const m = await member('v-m@test.com', { n: 'Verify Me' }); const admin = S.as('admin@test.com');
  assert.equal((await m.get('/api/admin/verification')).status, 403);
  const row = (await admin.get('/api/admin/verification')).json.find(r => r.email === 'v-m@test.com'); assert.equal(row.verified, false); assert.equal(row.has_photo, false);
  assert.equal((await admin.post('/api/admin/verification/v-m%40test.com/approve', {})).status, 200);
  assert.equal((await m.get('/api/me')).json.verification.verified, true);
  assert.equal((await admin.post('/api/admin/verification/v-m%40test.com/revoke', { reason: '=HYPERLINK("http://evil","click")' })).status, 200);
  assert.equal((await m.get('/api/me')).json.verification.verified, false);
  const csv = await admin.get('/api/admin/audit/export');
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.text.includes('id,time,admin,action,target,reason'));
  const line = csv.text.split('\r\n').find(l => l.includes('revoke'));
  assert.ok(line && !/,"?=HYPERLINK/.test(line), 'formula cells are neutralised: ' + line);
  assert.throws(() => S.db.prepare('DELETE FROM audit').run(), /append-only/);
  assert.throws(() => S.db.prepare("UPDATE audit SET reason='x'").run(), /append-only/);
});

test('backup: runs, is encrypted, restores to a readable database; deleted-account log survives', async () => {
  const admin = S.as('admin@test.com');
  const r = await admin.post('/api/admin/backups/run', {}); assert.equal(r.status, 200, r.text);
  const files = fs.readdirSync(S.env.BACKUP_DIR).filter(f => /^rishta-.*\.db\.gz\.enc$/.test(f)); assert.ok(files.length >= 1);
  assert.ok(fs.readdirSync(S.env.BACKUP_DIR).some(f => /^audit-.*\.csv\.gz\.enc$/.test(f)), 'the audit log is backed up too');
  const head = fs.readFileSync(path.join(S.env.BACKUP_DIR, files[0])).subarray(0, 5).toString();
  assert.equal(head, 'RCGB1');
  const out = path.join(S.dir, 'restored.db'), { decryptFile } = require('../backup-lib');
  await decryptFile(path.join(S.env.BACKUP_DIR, files[0]), out, Buffer.from(S.env.BACKUP_KEY, 'hex'));
  const Database = require('better-sqlite3'), d = new Database(out);
  assert.ok(d.prepare('SELECT COUNT(*) n FROM users').get().n > 3); d.close();
  const st = (await admin.get('/api/admin/backups')).json; assert.equal(st.enabled, true); assert.equal(st.runs[0].status, 'ok');
  assert.equal((await S.as('v-m@test.com').get('/api/admin/backups')).status, 403);
});

test('graceful shutdown: SIGTERM exits cleanly', async () => {
  const T = await startServer();
  const t0 = Date.now(); T.child.kill('SIGTERM');
  const code = await new Promise(r => T.child.once('exit', c => r(c)));
  assert.equal(code, 0); assert.ok(Date.now() - t0 < 5000); assert.match(T.log(), /shutting down/);
  T.db.close();
});

test('startup refuses unsafe configuration', async () => {
  for (const [label, extra, msg] of [
    ['short jwt', { JWT_SECRET: 'short' }, /at least 32/],
    ['no backup key', { BACKUP_KEY: '' }, /BACKUP_KEY/],
  ]) await assert.rejects(startServer(extra), e => msg.test(e.message), label);
});

/** A fake Supabase Storage: a private bucket held in memory. */
function fakeStorage(secret) {
  const files = new Map(); let failGets = false;
  const srv = require('node:http').createServer((req, res) => {
    const send = (c, o) => { res.statusCode = c; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.headers.apikey !== secret) return send(401, { message: 'bad key' });
    const chunks = []; req.on('data', d => chunks.push(d)); req.on('end', () => {
      if (req.method === 'POST' && req.url === '/storage/v1/bucket') return send(files.has('__bucket') ? 409 : 200, { name: 'rcg-data' }, files.set('__bucket', 1));
      const m = /^\/storage\/v1\/object\/rcg-data\/([\w.-]+)$/.exec(req.url);
      if (!m) return send(404, { message: 'no route' });
      if (req.method === 'POST') { files.set(m[1], Buffer.concat(chunks)); return send(200, { Key: m[1] }); }
      if (req.method === 'GET') { if (failGets) return send(500, { message: 'down' }); return files.has(m[1]) ? (res.end(files.get(m[1]))) : send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' }); }
      send(405, {});
    });
  });
  return { files, failGets: v => { failGets = v; }, listen: () => new Promise(r => srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + srv.address().port))), close: () => srv.close() };
}

test('free hosting: data survives a wiped disk through private storage; unreadable storage blocks startup', async () => {
  const SECRET = 'sb_secret_testtesttesttest', fs2 = fakeStorage(SECRET), url = await fs2.listen();
  const cfg = { __entry: 'start.js', PERSIST_SUPABASE_URL: url + '/rest/v1/', PERSIST_SUPABASE_KEY: SECRET, PERSIST_EVERY_SECONDS: '5' };
  const A = await startServer(cfg);
  A.db.prepare("INSERT INTO users(email,name,provider,created_at) VALUES('survivor@test.com','Survivor','google','2026-01-01')").run();
  await A.stop(); // the shutdown uploads a final copy
  const stored = fs2.files.get('latest.db.enc'); assert.ok(stored && stored.subarray(0, 5).toString() === 'RCGB1', 'stored copy is encrypted');
  assert.ok(![...fs2.files.keys()].some(k => /\.db$/.test(k)), 'no plain database is stored');
  const B = await startServer({ ...cfg, DB_FILE: path.join(os.tmpdir(), 'rcg-wiped-' + Date.now(), 'new.db') }); // new empty disk
  assert.match(B.log(), /restored from storage/);
  assert.equal(B.db.prepare("SELECT COUNT(*) n FROM users WHERE email='survivor@test.com'").get().n, 1);
  await B.stop();
  fs2.failGets(true);
  await assert.rejects(startServer({ ...cfg, DB_FILE: path.join(os.tmpdir(), 'rcg-wiped2-' + Date.now(), 'x.db') }), e => /STOPPED/.test(e.message));
  fs2.close();
});

test('pictures are found whatever the capital letters of the file name', async () => {
  const a = S.anon();
  for (const n of ['couple-hero.JPG', 'couple-hero.jpg', 'COUPLE-HERO.Jpeg', 'couple-bg.JPG', 'couple-bg.jpg']) {
    const r = await a.get('/img/' + n); assert.equal(r.status, 200, n); assert.match(r.headers.get('content-type'), /image\/jpeg/, n);
  }
  assert.equal((await a.get('/img/nothing.jpg')).status, 404);
  assert.equal((await a.get('/img/..%2Fserver.js')).status === 200, false);
  assert.equal((await a.get('/img/%2e%2e/server.js')).status === 200, false);
  const l = (await a.get('/img-list')).json; assert.ok(l.files.length >= 2); assert.equal(l.expected[0].exactMatch, true);
});

/* ---------- broker ratings and reviews ---------- */
test('broker reviews: only members who messaged the broker, one each, edits, flags, moderation, deletion', async () => {
  const admin = S.as('admin@test.com'), bk = S.as('rv-broker@test.com', 'Review Broker'); kycDone(S, 'rv-broker@test.com');
  assert.equal((await bk.post('/api/broker/apply', { n: 'Review Broker', c: 'Jeddah', e: '8 years', l: 'Urdu', s: 'Families', x: 'Hello', ph: '+966500000002', pp: 'EasyPaisa', pn: '03451234567' })).status, 200);
  const pendingId = (await S.anon().get('/api/brokers')).json.find(b => b.n === 'Review Broker');
  assert.equal(pendingId, undefined, 'a pending broker is not listed');
  assert.equal((await admin.post('/api/admin/brokers/rv-broker%40test.com/approve', {})).status, 200);
  const id = (await S.anon().get('/api/brokers')).json.find(b => b.n === 'Review Broker').id;
  const R = `/api/brokers/${id}/reviews`;
  const m1 = await member('rv-1@test.com', { n: 'Aisha Khan' }), m2 = await member('rv-2@test.com', { n: 'Bilal' });
  const noProfile = S.as('rv-3@test.com', 'No Profile');

  let g = (await S.anon().get(R)).json;
  assert.equal(g.summary.count, 0); assert.equal(g.summary.avg, null); assert.equal(g.canReview, false); assert.equal(g.signedIn, false);
  assert.equal((await S.anon().post(R, { rating: 5 })).status, 401, 'sign-in required');
  assert.equal((await S.anon().get('/api/brokers/doesnotexist/reviews')).status, 404);

  // not in touch yet
  const early = await m1.post(R, { rating: 5, body: 'Great' }); assert.equal(early.status, 403); assert.match(early.json.error, /Message this broker first/);
  assert.equal((await m1.get(R)).json.canReview, false);
  assert.equal((await noProfile.post(R, { rating: 5 })).status, 403);
  assert.equal((await S.as('broker@test.com').post(R, { rating: 1, body: 'rival attacking you' })).status, 403, 'brokers cannot review brokers');
  assert.equal((await bk.post(R, { rating: 5 })).status, 403, 'nobody reviews themselves');

  assert.equal((await m1.post('/api/chats', { to: id, body: 'Please help me' })).status, 200);
  assert.equal((await m2.post('/api/chats', { to: id, body: 'Salam, I need help' })).status, 200);
  assert.equal((await m1.get(R)).json.canReview, true);

  // validation
  for (const bad of [{ rating: 0 }, { rating: 6 }, { rating: 'x' }, { rating: 4.5 }, {}]) assert.equal((await m1.post(R, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await m1.post(R, { rating: 2 })).status, 400, 'a low rating needs a reason');
  assert.equal((await m1.post(R, { rating: 5, body: 'visit www.spam.example now' })).status, 400, 'no links');
  assert.equal((await m1.post(R, { rating: 5, body: 'call me 0501234567' })).status, 400, 'no phone numbers');
  assert.equal((await m1.post(R, { rating: 5, body: 'mail me a@b.co' })).status, 400, 'no email addresses');

  // write, read, edit
  const ok = await m1.post(R, { rating: 5, body: '  Very helpful and respectful.  ' }); assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.updated, false);
  g = (await S.anon().get(R)).json; assert.equal(g.summary.count, 1); assert.equal(g.summary.avg, 5); assert.equal(g.rows[0].n, 'Aisha K.'); assert.equal(g.rows[0].body, 'Very helpful and respectful.');
  assert.ok(!JSON.stringify(g).includes('@'), 'no email in the public reviews');
  assert.equal((await m1.get(R)).json.rows[0].mine, true); assert.equal((await m2.get(R)).json.rows[0].mine, false);
  assert.equal((await m1.post(R, { rating: 4, body: 'Helpful.' })).json.updated, true);
  g = (await S.anon().get(R)).json; assert.equal(g.summary.count, 1, 'still one review per member'); assert.equal(g.summary.avg, 4); assert.equal(g.rows[0].edited, true);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM broker_reviews WHERE reviewer=?').get('rv-1@test.com').n, 1);
  assert.equal((await bk.get('/api/notifications')).json.rows.filter(n => n.title === 'You have a new review').length, 1, 'broker told once, not on edits');

  // second review, averages, public list carries the rating
  assert.equal((await m2.post(R, { rating: 2, body: 'Slow replies and unclear fees.' })).status, 200);
  g = (await S.anon().get(R)).json; assert.equal(g.summary.count, 2); assert.equal(g.summary.avg, 3); assert.deepEqual(g.summary.dist, { 1: 0, 2: 1, 3: 0, 4: 1, 5: 0 });
  assert.deepEqual((await S.anon().get('/api/brokers')).json.find(b => b.id === id).rating, { count: 2, avg: 3 });

  // flag and moderation
  const bad = g.rows.find(r => r.n === 'Bilal').id;
  assert.equal((await m2.post(`/api/reviews/${bad}/flag`, { reason: 'mine' })).status, 400, 'cannot flag your own');
  assert.equal((await m1.post(`/api/reviews/${bad}/flag`, { reason: '' })).status, 400);
  assert.equal((await m1.post(`/api/reviews/${bad}/flag`, { reason: 'Unfair, I know this person' })).status, 200);
  assert.equal((await m1.post(`/api/reviews/${bad}/flag`, { reason: 'again' })).status, 200, 'a repeat flag is harmless');
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM review_flags WHERE review_id=?').get(bad).n, 1);
  assert.equal((await m1.get('/api/admin/reviews')).status, 403);
  const q = (await admin.get('/api/admin/reviews')).json; assert.equal(q[0].id, bad, 'flagged review first'); assert.equal(q[0].flags, 1); assert.equal(q[0].reviewer.email, 'rv-2@test.com');
  assert.equal((await m1.post(`/api/admin/reviews/${bad}/hide`, { reason: 'x' })).status, 403);
  assert.equal((await admin.post(`/api/admin/reviews/${bad}/hide`, { reason: '' })).status, 400);
  assert.equal((await admin.post(`/api/admin/reviews/${bad}/hide`, { reason: 'Abusive wording' })).status, 200);
  g = (await S.anon().get(R)).json; assert.equal(g.summary.count, 1); assert.equal(g.summary.avg, 4); assert.equal(g.rows.length, 1);
  assert.ok((await m2.get('/api/notifications')).json.rows.some(n => n.title === 'Your review was hidden'));
  assert.equal((await m2.get(R)).json.mine.hidden, true);
  assert.equal((await m2.post(R, { rating: 3, body: 'Edited after the hide' })).status, 200);
  assert.equal((await S.anon().get(R)).json.summary.count, 1, 'an edit does not bring a hidden review back');
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='hide-review' AND payment_id=?").get('review:' + bad).n, 1, 'audited');
  assert.equal((await admin.post(`/api/admin/reviews/${bad}/show`, {})).status, 200);
  g = (await S.anon().get(R)).json; assert.equal(g.summary.count, 2); assert.equal(g.summary.avg, 3.5);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM review_flags WHERE review_id=?').get(bad).n, 0, 'flags cleared on restore');
  assert.equal((await admin.post('/api/admin/reviews/999999/hide', { reason: 'abc' })).status, 404);

  // delete your own; account deletion removes your reviews
  assert.equal((await m2.post(R + '/delete', {})).status, 200); assert.equal((await m2.post(R + '/delete', {})).status, 404);
  assert.equal((await S.anon().get(R)).json.summary.count, 1);
  assert.equal((await m1.post('/api/account/delete', { confirm: 'DELETE' })).status, 200);
  assert.equal((await S.anon().get(R)).json.summary.count, 0, 'a deleted member takes their reviews with them');
  assert.equal((await S.anon().get('/api/brokers')).json.find(b => b.id === id).rating.count, 0);
});

test('free registration: a new profile is usable straight away; with REQUIRE_APPROVAL it waits for an admin; nothing asks for money', async () => {
  const a = await member('fr-a@test.com', { n: 'Free A', g: 'Male' }), b = await member('fr-b@test.com', { n: 'Free B', g: 'Female' });
  assert.equal((await a.get('/api/members?c=')).json.rows.some(m => m.n === 'Free B'), true, 'visible and searchable right after the profile is saved');
  const id = await uidOf(a, 'Free B');
  assert.equal((await a.post('/api/chats', { to: id, body: 'Salaam' })).status, 200, 'chat opens with no request or payment step');
  const me = (await a.get('/api/me')).json; assert.equal(me.membership, undefined); assert.equal(me.status, 'approved');
  const T = await startServer({ REQUIRE_APPROVAL: 'true' });
  try {
    const mk = async (e, n, g) => { const c = T.as(e, n); assert.equal((await c.post('/api/profile', { ...PROFILE, n, g })).status, 200); return c; };
    const p1 = await mk('fp-1@test.com', 'Pending One', 'Male'), p2 = await mk('fp-2@test.com', 'Pending Two', 'Female');
    assert.equal((await p1.get('/api/me')).json.status, 'pending');
    assert.equal((await p1.get('/api/members?c=')).status, 403, 'a pending profile cannot browse yet');
    const admin = T.as('admin@test.com');
    for (const e of ['fp-1%40test.com', 'fp-2%40test.com']) assert.equal((await admin.post(`/api/admin/members/${e}/approve`, {})).status, 200);
    assert.equal((await p1.get('/api/members?c=')).json.rows.some(m => m.n === 'Pending Two'), true, 'approved members appear for each other');
  } finally { T.child.kill(); T.db.close(); }
});

test('signup data is copied into the Supabase profiles table', async () => {
  const http = require('node:http');
  const calls = []; const store = new Map();
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
      calls.push({ m: req.method, u: req.url, k: req.headers.apikey });
      if (req.method === 'POST') for (const r of JSON.parse(b)) store.set(r.email, r);
      if (req.method === 'DELETE') store.delete(decodeURIComponent(req.url.split('email=eq.')[1]));
      res.writeHead(201); res.end();
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const S = await startServer({ REQUIRE_APPROVAL: 'true', SUPABASE_URL: 'http://127.0.0.1:' + fake.address().port, SUPABASE_SECRET_KEY: 'sb_secret_test' });
  try {
    const wait = async f => { for (let i = 0; i < 40 && !f(); i++) await new Promise(r => setTimeout(r, 100)); };
    const m = S.as('sync1@test.com', 'Sync One');
    const r = await m.post('/api/profile', { n: 'Sync One', g: 'Male', a: 28, c: 'Riyadh', m: 'Never married', e: 'Bachelor', j: 'Engineer', x: 'About me', w: 'Looking for', agree: true });
    assert.equal(r.status, 200);
    await wait(() => store.get('sync1@test.com') && store.get('sync1@test.com').profile);
    assert.equal(store.get('sync1@test.com').profile.c, 'Riyadh');
    assert.equal(store.get('sync1@test.com').status, 'pending');
    assert.equal(calls[0].k, 'sb_secret_test');
    await S.as('admin@test.com').post('/api/admin/members/sync1%40test.com/approve', {});
    await wait(() => store.get('sync1@test.com').status === 'approved');
    assert.equal(store.get('sync1@test.com').status, 'approved');
    await m.post('/api/account/delete', { confirm: 'DELETE' });
    await wait(() => !store.has('sync1@test.com'));
    assert.equal(store.has('sync1@test.com'), false);
  } finally { await S.stop(); fake.close(); }
});

test('featured profiles: opt-in, verified only, first name only, samples labelled', async () => {
  const S = await startServer({ REQUIRE_APPROVAL: 'true', SHOW_SAMPLE_PROFILES: 'true' });
  try {
    let list = await (await fetch(S.base + '/api/featured')).json();
    assert.equal(list.length, 6); assert.ok(list.every(x => x.sample === true && !x.verified));
    const prof = f => ({ n: 'Zainab Khan', g: 'Female', a: 26, c: 'Doha', m: 'Never married', e: 'MSc', j: 'Nurse', x: 'About', w: 'Looking', agree: true, f });
    const m = S.as('feat1@test.com', 'Zainab Khan');
    await m.post('/api/profile', prof(true));
    await S.as('admin@test.com').post('/api/admin/members/feat1%40test.com/approve', {});
    list = await (await fetch(S.base + '/api/featured')).json();
    assert.ok(!list.some(x => !x.sample), 'not verified yet, so not shown');
    S.db.prepare('UPDATE verification SET identity=1,photo=1,background=1 WHERE email=?').run('feat1@test.com');
    list = await (await fetch(S.base + '/api/featured')).json();
    assert.equal(list.length, 6); assert.equal(list[0].n, 'Zainab'); assert.equal(list[0].verified, true);
    assert.equal(list.filter(x => x.sample).length, 5);
    assert.ok(!JSON.stringify(list).includes('feat1@test.com') && !JSON.stringify(list).includes('Khan'));
    await m.post('/api/profile', prof(false));
    list = await (await fetch(S.base + '/api/featured')).json();
    assert.ok(list.every(x => x.sample));
  } finally { await S.stop(); }
  const S2 = await startServer({}); // samples are off by default: only real, verified, opted-in members
  try { assert.deepEqual(await (await fetch(S2.base + '/api/featured')).json(), []); } finally { await S2.stop(); }
});

test('admin review: details, reject with reason, resubmit, admin-only', async () => {
  const S = await startServer({ REQUIRE_APPROVAL: 'true' });
  try {
    const prof = x => ({ n: 'Rev Two', g: 'Female', a: 27, c: 'Doha', m: 'Never married', e: 'MSc', j: 'Nurse', x, w: 'Looking', agree: true });
    const m = S.as('rev2@test.com', 'Rev Two'), admin = S.as('admin@test.com');
    await m.post('/api/profile', prof('first'));
    assert.equal((await m.get('/api/admin/members/rev2%40test.com/review')).status, 403);
    const r = await admin.get('/api/admin/members/rev2%40test.com/review');
    assert.equal(r.status, 200); assert.equal(r.json.profile.x, 'first'); assert.equal(r.json.status, 'pending'); assert.equal(r.json.photo.has, false);
    assert.equal((await admin.post('/api/admin/members/rev2%40test.com/reject', { reason: 'x' })).status, 400);
    assert.equal((await admin.post('/api/admin/members/rev2%40test.com/reject', { reason: 'Add a clear photo' })).status, 200);
    const me = await m.get('/api/me'); assert.equal(me.json.status, 'rejected'); assert.equal(me.json.statusReason, 'Add a clear photo');
    assert.equal((await m.get('/api/members')).status, 403);
    await m.post('/api/profile', prof('second'));
    assert.equal((await m.get('/api/me')).json.status, 'pending');
    await admin.post('/api/admin/members/rev2%40test.com/approve', {});
    assert.equal((await admin.post('/api/admin/members/rev2%40test.com/reject', { reason: 'late' })).status, 400); // live members are suspended, not rejected
  } finally { await S.stop(); }
});

test('automatic moderation: flags text, holds serious cases, optional AI photo check and assistant', async () => {
  const http = require('node:http');
  const seen = [];
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
      const j = JSON.parse(b); seen.push(j);
      const isPhoto = Array.isArray(j.messages[0].content);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'text', text: isPhoto ? '{"concerns":["explicit_or_revealing","made_up"],"note":"test"}' : 'Use Settings to delete your account.' }] }));
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const S = await startServer({ REQUIRE_APPROVAL: 'true', ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + fake.address().port });
  try {
    const prof = (x, w = 'Looking') => ({ n: 'Mod One', g: 'Male', a: 30, c: 'Doha', m: 'Never married', e: 'BSc', j: 'Engineer', x, w, agree: true });
    const m = S.as('mod1@test.com', 'Mod One'), admin = S.as('admin@test.com');
    await m.post('/api/profile', prof('Nice person, whatsapp me on +966 50 123 4567'));
    let rv = (await admin.get('/api/admin/members/mod1%40test.com/review')).json;
    assert.equal(rv.auto.level, 'medium'); assert.equal(rv.status, 'pending'); // pending only because approval is required
    await admin.post('/api/admin/members/mod1%40test.com/approve', {});
    await m.post('/api/profile', prof('Please send money first'));
    rv = (await admin.get('/api/admin/members/mod1%40test.com/review')).json;
    assert.equal(rv.auto.level, 'high'); assert.equal(rv.status, 'pending'); assert.equal(rv.reason, 'Held for a safety check');
    assert.equal((await admin.get('/api/admin/members')).json.find(x => x.email === 'mod1@test.com').flag, 'high');
    await admin.post('/api/admin/members/mod1%40test.com/mod/clear', {});
    await m.post('/api/profile', prof('Please send money first')); // same text after a person cleared it: not held again
    assert.equal((await admin.get('/api/admin/members/mod1%40test.com/review')).json.auto.cleared_by, 'admin@test.com');
    // photo: the AI answer is read safely (unknown labels dropped), a serious one hides the photo
    const up = await m.raw('POST', '/api/photo', dirtyJpeg(), { 'content-type': 'image/jpeg' }); assert.equal(up.status, 200);
    await new Promise(r => setTimeout(r, 800));
    rv = (await admin.get('/api/admin/members/mod1%40test.com/review')).json;
    assert.equal(rv.auto.photo_level, 'high'); assert.deepEqual(rv.auto.photo.concerns, ['explicit_or_revealing']);
    assert.equal((await m.post('/api/photo/visibility', { visible: true })).status, 409);
    // assistant
    const a = await S.anon().post('/api/assistant', { message: 'something odd', history: [] });
    assert.equal(a.status, 200); assert.equal(a.json.ai, true); assert.match(a.json.reply, /Settings/);
    assert.ok(seen.some(x => /Rishta Connect Global/.test(x.system || '')));
    assert.equal((await S.anon().post('/api/assistant', { message: '', history: [] })).status, 400);
  } finally { await S.stop(); fake.close(); }
  const S2 = await startServer({});
  try { assert.equal((await S2.anon().post('/api/assistant', { message: 'hi' })).json.ai, false); } finally { await S2.stop(); }
});

test('help knowledge base: FAQ page, JSON, and the AI assistant is told to answer only from it', async () => {
  const http = require('node:http'); let sys = '';
  const fake = http.createServer((req, res) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { sys = JSON.parse(b).system; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] })); }); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const S = await startServer({ SUPPORT_EMAIL: 'help@example.test', ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + fake.address().port });
  try {
    const page = await S.anon().get('/faq'); assert.equal(page.status, 200); assert.match(page.text, /How do I register\?/); assert.match(page.text, /help@example\.test/); assert.match(page.text, /lang="ur"/);
    const j = (await S.anon().get('/api/faq')).json;
    assert.ok(j.length >= 25); assert.ok(j.every(x => x.id && x.q.en && x.q.ur && x.a.en && x.a.ur && x.k.length));
    assert.ok(new Set(j.map(x => x.id)).size === j.length, 'ids are unique');
    assert.ok(j.some(x => x.id === 'status') && j.some(x => x.id === 'delete'));
    await S.anon().post('/api/assistant', { message: 'how do I register?' });
    assert.match(sys, /KNOWLEDGE:/); assert.match(sys, /Continue with Google/); assert.match(sys, /help@example\.test/); assert.match(sys, /Answer ONLY from the KNOWLEDGE/);
    // facts in the answers match the code
    const all = j.map(x => x.a.en).join(' ');
    assert.match(all, /18 to 70/); assert.match(all, /200 members/); assert.match(all, /20 messages a minute/);
  } finally { await S.stop(); fake.close(); }
});

test('home page shows the real photo of verified, featured members whose photo is visible', async () => {
  const S = await startServer({ REQUIRE_APPROVAL: 'true' });
  try {
    const prof = (f) => ({ n: 'Noor Ali', g: 'Female', a: 26, c: 'Doha', m: 'Never married', e: 'MSc', j: 'Nurse', x: 'About', w: 'Looking', agree: true, f });
    const m = S.as('hp1@test.com', 'Noor Ali'), admin = S.as('admin@test.com');
    const find = async () => (await (await fetch(S.base + '/api/featured')).json()).find(x => x.n === 'Noor');
    await m.post('/api/profile', prof(false));
    await m.raw('POST', '/api/photo', dirtyJpeg(), { 'content-type': 'image/jpeg' });
    await m.post('/api/photo/visibility', { visible: true });
    await admin.post('/api/admin/members/hp1%40test.com/approve', {});
    S.db.prepare('UPDATE verification SET identity=1,photo=1,background=1 WHERE email=?').run('hp1@test.com');
    assert.equal(await find(), undefined); // not opted in to Featured
    await m.post('/api/profile', prof(true));
    let f = await find();
    assert.equal(f.ph, true); // featured + visible photo => real photo
    const r = await fetch(S.base + '/api/featured/photo/' + f.id); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.equal((await fetch(S.base + '/api/featured/photo/nonsense')).status, 404);
    await m.post('/api/photo/visibility', { visible: false }); // hiding the photo takes it off the home page at once
    assert.equal((await fetch(S.base + '/api/featured/photo/' + f.id)).status, 404);
    assert.equal((await find()).ph, false);
    await m.post('/api/photo/visibility', { visible: true });
    S.db.prepare('UPDATE verification SET photo=0 WHERE email=?').run('hp1@test.com'); // no longer verified
    assert.equal(await find(), undefined);
  } finally { await S.stop(); }
});

test('broker upgrade: contact number (admin only), encrypted National ID, live leads, commissions, clients', async () => {
  const T = await startServer();
  try {
    const idJpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('NATIONAL-ID-SECRET-'.repeat(400)), Buffer.from([0xff, 0xd9])]);
    const br = T.as('bk1@test.com', 'Broker One'), br2 = T.as('bk2@test.com', 'Broker Two'), admin = T.as('admin@test.com'), nobody = T.as('plain@test.com');
    const form = { n: 'Broker One', c: 'Doha, Qatar', e: '5 years', l: 'Urdu, English', s: 'Gulf families', x: 'Experienced matchmaker', ph: '+974 5555 1234', pp: 'JazzCash', pn: '0300-1234567' };
    // 1. no OTP any more: the old routes are gone; a contact number and the ID are all that is needed
    assert.equal((await br.post('/api/broker/phone/send', { phone: '+97455551234' })).status, 404);
    assert.equal((await br.post('/api/broker/apply', form)).status, 400); // ID missing
    assert.equal((await br.raw('POST', '/api/broker/id', Buffer.from('not an image'), { 'content-type': 'image/jpeg' })).status, 400);
    assert.equal((await br.raw('POST', '/api/broker/id', idJpg, { 'content-type': 'image/jpeg' })).status, 200);
    // the profile picture is required too, and must really be an image
    assert.equal((await br.post('/api/broker/apply', form)).status, 400);
    assert.equal((await br.raw('POST', '/api/broker/photo', Buffer.from('<html>not a picture</html>'.repeat(20)), { 'content-type': 'image/jpeg' })).status, 400);
    assert.ok((await br.raw('POST', '/api/broker/photo', Buffer.from('plain text'), { 'content-type': 'text/plain' })).status >= 400); // wrong file type is refused
    assert.equal((await br.get('/api/broker/kyc')).json.hasPhoto, false);
    assert.equal((await br.raw('POST', '/api/broker/photo', dirtyJpeg(), { 'content-type': 'image/jpeg' })).status, 200);
    assert.equal((await br.get('/api/broker/kyc')).json.hasPhoto, true);
    assert.equal((await br.post('/api/broker/apply', { ...form, ph: 'abc' })).status, 400); // contact number is required
    assert.equal((await br.post('/api/broker/apply', form)).status, 200);
    assert.equal((await T.as('anyone@test.com', 'Any').get('/api/brokers')).json.length, 0); // not public until approved
    const stored = T.db.prepare('SELECT data FROM broker_ids WHERE email=?').get('bk1@test.com').data;
    assert.ok(!stored.includes('NATIONAL-ID-SECRET'), 'the ID is encrypted at rest');
    // 2. the number is visible to administrators only
    const list = (await admin.get('/api/admin/brokers')).json.find(x => x.email === 'bk1@test.com');
    assert.equal(list.kyc.phone, '+97455551234'); assert.equal(list.kyc.hasId, true);
    assert.equal((await nobody.get('/api/admin/brokers')).status, 403);
    assert.equal((await nobody.get('/api/admin/brokers/bk1%40test.com/id')).status, 403);
    const img = await admin.get('/api/admin/brokers/bk1%40test.com/id'); assert.equal(img.status, 200); assert.ok(img.body.equals(idJpg));
    assert.equal((await br.get('/api/broker/dashboard')).status, 403); // not approved yet
    assert.equal((await admin.post('/api/admin/brokers/bk1%40test.com/approve', {})).status, 200);
    const purge = T.db.prepare('SELECT purge_at FROM broker_ids WHERE email=?').get('bk1@test.com').purge_at;
    assert.ok(Date.parse(purge) - Date.now() > 85 * 86400_000, 'the ID is scheduled for deletion about 90 days after the decision');
    const pubB = (await nobody.get('/api/brokers')).json[0]; assert.equal(pubB.photo, true);
    const pp = await nobody.get(`/api/brokers/${pubB.id}/photo`); assert.equal(pp.status, 200); assert.equal(pp.headers.get('content-type'), 'image/jpeg');
    assert.equal((await nobody.get('/api/brokers/nonsense/photo')).status, 404);
    assert.equal((await br.raw('POST', '/api/broker/photo', dirtyJpeg(), { 'content-type': 'image/jpeg' })).status, 409); // an approved broker's picture changes only through support
    // the number must not leak anywhere a client can look
    const viewer = T.as('viewer@test.com', 'Viewer'); await viewer.post('/api/profile', { n: 'Viewer One', g: 'Male', a: 30, c: 'Doha', m: 'Never married', e: 'BSc', j: 'Eng', x: 'About', w: 'Looking', agree: true });
    const everything = [(await viewer.get('/api/brokers')).text, (await viewer.get('/api/me')).text, (await br.get('/api/me')).text, (await br.get('/api/broker/kyc')).text, (await br.get('/api/broker/dashboard')).text, (await viewer.get('/api/members')).text];
    for (const t of everything) assert.ok(!/5555 ?1234|55551234/.test(t), 'contact number must stay admin-only');
    // 3. leads: a referral signup and a chat both show up
    const d0 = (await br.get('/api/broker/dashboard')).json; assert.equal(d0.stats.leads, 0);
    const prof = { n: 'Ayesha Khan', g: 'Female', a: 27, c: 'Lahore', m: 'Never married', e: 'MSc', j: 'Teacher', x: 'About', w: 'Looking', agree: true };
    const ref = T.as('m1@test.com', 'Ayesha Khan'), chat = T.as('m2@test.com', 'Sara Ali');
    assert.equal((await ref.post('/api/profile', { ...prof, ref: d0.refId })).status, 200);
    assert.equal((await chat.post('/api/profile', { ...prof, n: 'Sara Ali' })).status, 200);
    assert.equal((await chat.post('/api/chats', { to: d0.refId, body: 'Salam, I need help finding a match.' })).status, 200);
    const d1 = (await br.get('/api/broker/dashboard')).json;
    assert.equal(d1.stats.leads, 2); assert.equal(d1.stats.referrals, 1); assert.equal(d1.stats.new, 2);
    assert.ok(!JSON.stringify(d1).includes('@test.com'), 'leads never expose member emails');
    const lead = d1.leads.find(l => l.n === 'Ayesha');
    assert.equal((await br2.post('/api/broker/leads/' + lead.id, { status: 'contacted' })).status, 403);
    assert.equal((await br.post('/api/broker/leads/' + lead.id, { status: 'bogus' })).status, 400);
    assert.equal((await br.post('/api/broker/leads/' + lead.id, { status: 'matched' })).status, 200);
    assert.equal((await br.get('/api/broker/dashboard')).json.stats.matched, 1);
    // 4. commissions are written by an admin only
    assert.equal((await br.post('/api/admin/brokers/bk1%40test.com/commissions', { amount: 100, currency: 'USD' })).status, 403);
    assert.equal((await admin.post('/api/admin/brokers/bk1%40test.com/commissions', { amount: -5, currency: 'USD' })).status, 400);
    assert.equal((await admin.post('/api/admin/brokers/bk1%40test.com/commissions', { amount: 150.5, currency: 'usd', note: 'Ayesha match', lead_id: lead.id })).status, 200);
    let d2 = (await br.get('/api/broker/dashboard')).json;
    assert.deepEqual(d2.commission.totals, [{ currency: 'USD', pending: 150.5, paid: 0 }]);
    assert.equal((await admin.post('/api/admin/commissions/' + d2.commission.rows[0].id, { status: 'paid' })).status, 200);
    d2 = (await br.get('/api/broker/dashboard')).json; assert.deepEqual(d2.commission.totals, [{ currency: 'USD', pending: 0, paid: 150.5 }]);
    // 5. private clients
    const cl = { n: 'Hamza Raza', g: 'Male', a: 30, c: 'Karachi', ph: '+92 300 1234567', r: 'Educated, family oriented', x: 'Prefers Urdu' };
    assert.equal((await br.post('/api/broker/clients', cl)).status, 400); // needs the client's consent
    const made = await br.post('/api/broker/clients', { ...cl, consent: true }); assert.equal(made.status, 200);
    assert.equal((await br.post('/api/broker/clients/' + made.json.id, { status: 'active' })).status, 200);
    assert.equal((await viewer.get('/api/members')).json.rows.some(r => r.managed), false); // not published, so not in search
    assert.equal((await admin.get('/api/broker/dashboard')).status, 403);
    // 6. a client shown on the site as a managed profile
    const pub = { ...cl, m: 'Never married', e: 'BSc', j: 'Engineer', pa: 'Calm and family oriented.', w: 'A kind partner', consent: true, publish: true, pconsent: true };
    assert.equal((await br.post('/api/broker/clients/' + made.json.id, { ...pub, pconsent: false })).status, 400);
    assert.equal((await br.post('/api/broker/clients/' + made.json.id, { ...pub, e: '' })).status, 400);
    assert.equal((await br.post('/api/broker/clients/' + made.json.id, pub)).status, 200);
    let rows = (await viewer.get('/api/members')).json.rows; const mg = rows.find(r => r.managed);
    assert.ok(mg, 'published client appears in search'); assert.equal(mg.n, 'Hamza'); assert.equal(mg.bn, 'Broker'); assert.equal(mg.verified, false);
    const raw = JSON.stringify(rows); assert.ok(!/1234567|Prefers Urdu|Educated, family|bk1@/.test(raw), 'private client details and the broker email never reach clients');
    assert.equal((await viewer.get('/api/members/' + mg.id)).json.managed, true);
    assert.equal((await viewer.get('/api/members/bm1-0000000000')).status, 404);
    // writing to the managed profile reaches the broker, and says which profile
    assert.equal((await viewer.post('/api/chats', { to: mg.id, body: 'Interested in this profile' })).status, 200);
    const chats = (await viewer.get('/api/chats')).json; assert.equal(chats[0].with.kind, 'broker');
    const msgs = (await viewer.get('/api/chats/' + chats[0].id)).json.messages; assert.match(msgs[0].body, /^Regarding the profile of Hamza \(30, Karachi\): Interested/);
    // closing the client takes the profile down
    assert.equal((await br.post('/api/broker/clients/' + made.json.id, { status: 'matched' })).status, 200);
    assert.equal((await viewer.get('/api/members')).json.rows.some(r => r.managed), false);
    assert.equal((await br.post('/api/broker/clients/' + made.json.id, { status: 'active' })).status, 200);
    assert.equal((await br.post('/api/broker/clients/' + made.json.id + '/delete', {})).status, 200);
    assert.equal((await viewer.get('/api/members')).json.rows.some(r => r.managed), false);
    // 7. deleting the account removes everything
    assert.equal((await br.post('/api/account/delete', { confirm: 'DELETE' })).status, 200);
    for (const t of ['broker_contact', 'broker_ids']) assert.equal(T.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE email='bk1@test.com'`).get().n, 0);
    assert.equal(T.db.prepare("SELECT COUNT(*) n FROM broker_leads WHERE broker='bk1@test.com'").get().n, 0);
  } finally { await T.stop(); }
});

test('managed profiles wait for an admin when approval is on, and a broker cannot publish for another', async () => {
  const T = await startServer({ REQUIRE_APPROVAL: 'true' });
  try {
    const admin = T.as('admin@test.com'), br = T.as('mb@test.com', 'Mina Broker'), viewer = T.as('v2@test.com', 'Vee');
    kycDone(T, 'mb@test.com');
    await br.post('/api/broker/apply', { n: 'Mina Broker', c: 'Doha', e: '3 years', l: 'Urdu', s: 'Families', x: 'Hi', ph: '+97455500000', pp: 'JazzCash', pn: '03001234567' });
    await admin.post('/api/admin/brokers/mb%40test.com/approve', {});
    const c = await br.post('/api/broker/clients', { n: 'Zara Noor', g: 'Female', a: 26, c: 'Doha', m: 'Never married', e: 'MA', j: 'Doctor', pa: 'Warm and caring.', w: 'A good man', consent: true, publish: true, pconsent: true });
    await viewer.post('/api/profile', { n: 'Vee Khan', g: 'Male', a: 30, c: 'Doha', m: 'Never married', e: 'BSc', j: 'Eng', x: 'About', w: 'Looking', agree: true });
    await admin.post('/api/admin/members/v2%40test.com/approve', {});
    assert.equal((await viewer.get('/api/members')).json.rows.some(r => r.managed), false); // pending
    const q = (await admin.get('/api/admin/managed')).json; assert.equal(q.length, 1); assert.equal(q[0].n, 'Zara');
    assert.equal((await br.get('/api/admin/managed')).status, 403);
    assert.equal((await admin.post(`/api/admin/managed/${c.json.id}/reject`, {})).status, 400); // a reason is needed
    assert.equal((await admin.post(`/api/admin/managed/${c.json.id}/approve`, {})).status, 200);
    assert.equal((await viewer.get('/api/members')).json.rows.filter(r => r.managed).length, 1);
    assert.equal((await br.post(`/api/broker/clients/${c.json.id}`, { n: 'Zara Noor', status: 'active' })).status, 200);
  } finally { await T.stop(); }
});

test('broker ID retention: expired National ID files are deleted', () => {
  const Database = require('better-sqlite3'); const db = new Database(':memory:');
  const noop = () => {}, app = { get: noop, post: noop };
  const mod = require('../brokerplus')({ app, express: { raw: () => noop }, db, E: { JWT_SECRET: 'j'.repeat(48) }, scan: noop, admins: new Set(), auth: noop, csrf: noop, adminOnly: noop, wrap: noop, rateLimit: () => noop, now: () => new Date().toISOString(), audit: noop, notify: noop, opaque: noop, byUid: noop, bstatus: noop, s: noop });
  const ins = db.prepare('INSERT INTO broker_ids(email,data,uploaded_at,purge_at) VALUES(?,?,?,?)');
  ins.run('old@x.com', Buffer.from('a'), 'x', '2000-01-01T00:00:00.000Z'); ins.run('new@x.com', Buffer.from('b'), 'x', '2999-01-01T00:00:00.000Z'); ins.run('open@x.com', Buffer.from('c'), 'x', null);
  assert.equal(mod.purge(), 1);
  assert.deepEqual(db.prepare('SELECT email FROM broker_ids ORDER BY email').all().map(r => r.email), ['new@x.com', 'open@x.com']);
});

test('broker milestones: confirmed completed proposals, tiers at 50/100/150/200, notices and awards', async () => {
  const T = await startServer();
  try {
    const admin = T.as('admin@test.com'), br = T.as('ms@test.com', 'Mila Broker'), other = T.as('other@test.com', 'Other');
    kycDone(T, 'ms@test.com');
    await br.post('/api/broker/apply', { n: 'Mila Broker', c: 'Doha', e: '4 years', l: 'Urdu', s: 'Families', x: 'Hi', ph: '+97455500001', pp: 'EasyPaisa', pn: '03001234567' });
    await admin.post('/api/admin/brokers/ms%40test.com/approve', {});
    const seed = n => { const ins = T.db.prepare("INSERT INTO broker_completions(broker,source,ref_id,label,status,created_at) VALUES('ms@test.com','seed',?,'x','confirmed',?)"); const base = T.db.prepare('SELECT COUNT(*) n FROM broker_completions').get().n; for (let i = 0; i < n; i++) ins.run(100000 + base + i, new Date().toISOString()); };
    const complete = async (label) => { // the broker adds a client and marks it matched, then an admin confirms
      const c = await br.post('/api/broker/clients', { n: label, g: 'Male', a: 30, c: 'Doha', consent: true });
      assert.equal((await br.post('/api/broker/clients/' + c.json.id, { status: 'matched' })).status, 200);
      const q = (await admin.get('/api/admin/completions')).json.find(x => x.label === label); assert.ok(q, 'waits for confirmation');
      return q;
    };
    let m = (await br.get('/api/broker/dashboard')).json.milestones;
    assert.equal(m.completed, 0); assert.equal(m.next.at, 50); assert.equal(m.next.remaining, 50); assert.equal(m.tiers.length, 4); assert.deepEqual(m.tiers.map(t => t.at), [50, 100, 150, 200]);
    // a broker cannot confirm their own; an unconfirmed match does not count
    const q1 = await complete('Hamza');
    assert.equal((await br.post(`/api/admin/completions/${q1.id}/confirm`, {})).status, 403);
    m = (await br.get('/api/broker/dashboard')).json.milestones; assert.equal(m.completed, 0); assert.equal(m.pending, 1);
    // taking the match back removes it from the queue
    const cid = T.db.prepare("SELECT ref_id FROM broker_completions WHERE id=?").get(q1.id).ref_id;
    assert.equal((await br.post('/api/broker/clients/' + cid, { status: 'active' })).status, 200);
    assert.equal((await admin.get('/api/admin/completions')).json.length, 0);
    // 24 confirmed, then a 25th: halfway notice
    seed(24); const q2 = await complete('Ali');
    assert.equal((await admin.post(`/api/admin/completions/${q2.id}/confirm`, {})).status, 200);
    m = (await br.get('/api/broker/dashboard')).json.milestones; assert.equal(m.completed, 25); assert.equal(m.next.remaining, 25); assert.equal(m.next.pct, 50); assert.equal(m.current, null);
    const notes = async () => (await br.get('/api/notifications')).json;
    assert.match(JSON.stringify(await notes()), /25 more to Bronze/);
    // reaching 50 makes the broker eligible, notifies, and shows a public badge
    seed(24); const q3 = await complete('Omar');
    assert.equal((await admin.post(`/api/admin/completions/${q3.id}/confirm`, {})).status, 200);
    m = (await br.get('/api/broker/dashboard')).json.milestones; assert.equal(m.completed, 50); assert.equal(m.current.name, 'Bronze'); assert.equal(m.next.at, 100);
    assert.equal(m.tiers[0].reached, true); assert.equal(m.tiers[0].award.status, 'eligible'); assert.equal(m.tiers[1].reached, false);
    assert.match(JSON.stringify(await notes()), /You reached Bronze/);
    const pubList = (await other.get('/api/brokers')).json; assert.equal(pubList[0].tier.name, 'Bronze');
    assert.ok(!/\bcompleted\b/.test(JSON.stringify(pubList)), 'the exact count is not public');
    // the same tier is never announced twice
    const before = JSON.stringify(await notes()).split('You reached Bronze').length;
    seed(1); const q4 = await complete('Zain'); await admin.post(`/api/admin/completions/${q4.id}/confirm`, {});
    assert.equal(JSON.stringify(await notes()).split('You reached Bronze').length, before);
    // the admin records the award
    assert.equal((await br.post('/api/admin/awards/ms%40test.com/1', { status: 'granted' })).status, 403);
    assert.equal((await admin.post('/api/admin/awards/ms%40test.com/2', { status: 'granted' })).status, 404); // Silver not reached
    assert.equal((await admin.post('/api/admin/awards/ms%40test.com/1', { status: 'granted', note: 'Certificate sent' })).status, 200);
    m = (await br.get('/api/broker/dashboard')).json.milestones; assert.equal(m.tiers[0].award.status, 'granted'); assert.equal(m.tiers[0].award.note, 'Certificate sent');
    // jump to the top tiers
    seed(150); const q5 = await complete('Yusuf'); await admin.post(`/api/admin/completions/${q5.id}/confirm`, {});
    m = (await br.get('/api/broker/dashboard')).json.milestones; assert.equal(m.current.name, 'Platinum'); assert.equal(m.next, null); assert.equal(m.tiers.filter(t => t.award).length, 4);
  } finally { await T.stop(); }
});

test('broker challenge: payout details (admin only), 15 verified profiles in 90 days, leaderboard, manual 1000 PKR reward', async () => {
  const T = await startServer();
  try {
    const admin = T.as('admin@test.com'), br = T.as('ch@test.com', 'Chaudhry Broker'), rival = T.as('rv9@test.com', 'Rival Broker'), nobody = T.as('nb@test.com', 'Nobody');
    kycDone(T, 'ch@test.com'); kycDone(T, 'rv9@test.com');
    const form = { n: 'Chaudhry Broker', c: 'Lahore', e: '3 years', l: 'Urdu', s: 'Families', x: 'Hi', ph: '+923001110000' };
    // payout details are mandatory and validated
    assert.equal((await br.post('/api/broker/apply', form)).status, 400);
    assert.equal((await br.post('/api/broker/apply', { ...form, pp: 'PayPal', pn: '03001234567' })).status, 400);
    assert.equal((await br.post('/api/broker/apply', { ...form, pp: 'JazzCash', pn: '12345' })).status, 400);
    assert.equal((await br.post('/api/broker/apply', { ...form, pp: 'JazzCash', pn: '+92 300 1234567' })).status, 200);
    assert.equal((await rival.post('/api/broker/apply', { ...form, n: 'Rival Broker', pp: 'EasyPaisa', pn: '03451112222' })).status, 200);
    assert.equal((await admin.post('/api/admin/brokers/ch%40test.com/approve', {})).status, 200);
    assert.equal((await admin.post('/api/admin/brokers/rv9%40test.com/approve', {})).status, 200);
    // the admin sees each broker's payout details; nobody else does
    const list = (await admin.get('/api/admin/brokers')).json.find(x => x.email === 'ch@test.com');
    assert.deepEqual(list.payout, { provider: 'JazzCash', number: '03001234567', verified: false });
    assert.equal(list.challenge.target, 15);
    for (const t of [(await nobody.get('/api/brokers')).text, (await nobody.get('/api/members')).text, (await nobody.get('/api/me')).text, (await rival.get('/api/broker/dashboard')).text]) assert.ok(!/03001234567/.test(t), 'payout number stays private');
    assert.equal((await nobody.get('/api/admin/challenge')).status, 403);
    // a fresh challenge: 0 of 15, 90 days
    const d0 = (await br.get('/api/broker/dashboard')).json; assert.equal(d0.challenge.count, 0); assert.equal(d0.challenge.target, 15); assert.equal(d0.challenge.status, 'active'); assert.equal(d0.challenge.rewardPkr, 1000); assert.ok(d0.challenge.daysLeft >= 89);
    assert.equal(d0.payout.provider, 'JazzCash');
    // members who join through the broker's link count once an administrator has fully verified them
    const prof = n => ({ n, g: 'Female', a: 27, c: 'Lahore', m: 'Never married', e: 'MSc', j: 'Teacher', x: 'About', w: 'Looking', agree: true });
    const ver = (email, all = true, at = new Date().toISOString()) => T.db.prepare('INSERT OR REPLACE INTO verification(email,identity,photo,background,updated_at) VALUES(?,?,?,?,?)').run(email, 1, 1, all ? 1 : 0, at);
    for (let i = 1; i <= 14; i++) { const m = T.as(`mem${i}@test.com`, `Member ${i}`); assert.equal((await m.post('/api/profile', { ...prof('Member ' + i), ref: d0.refId })).status, 200); ver(`mem${i}@test.com`); }
    const half = T.as('half@test.com', 'Half'); await half.post('/api/profile', { ...prof('Half'), ref: d0.refId }); ver('half@test.com', false); // only two of three checks
    const chat = T.as('chatter@test.com', 'Chatter'); await chat.post('/api/profile', prof('Chatter')); await chat.post('/api/chats', { to: d0.refId, body: 'Hello broker' }); ver('chatter@test.com'); // came by chat, not by link
    let d1 = (await br.get('/api/broker/dashboard')).json; assert.equal(d1.challenge.count, 14); assert.equal(d1.challenge.remaining, 1); assert.equal(d1.challenge.status, 'active');
    assert.equal(d1.leaderboard.me.rank, 1); assert.equal(d1.leaderboard.top[0].name, 'Chaudhry'); assert.ok(!JSON.stringify(d1.leaderboard).includes('@'));
    // the 15th verified profile completes the challenge
    const m15 = T.as('mem15@test.com', 'Member 15'); await m15.post('/api/profile', { ...prof('Member 15'), ref: d0.refId }); ver('mem15@test.com');
    const d2 = (await br.get('/api/broker/dashboard')).json; assert.equal(d2.challenge.count, 15); assert.equal(d2.challenge.status, 'completed'); assert.equal(d2.challenge.reward.status, 'eligible');
    assert.match(JSON.stringify((await br.get('/api/notifications')).json), /Challenge complete/);
    assert.match(JSON.stringify((await admin.get('/api/notifications')).json), /completed the challenge/);
    // the reward is paid by hand, only after the payout number was phone-verified
    assert.equal((await br.post('/api/admin/brokers/ch%40test.com/reward', { status: 'paid' })).status, 403);
    assert.equal((await admin.post('/api/admin/brokers/ch%40test.com/reward', { status: 'paid' })).status, 409);
    assert.equal((await admin.post('/api/admin/brokers/rv9%40test.com/reward', { status: 'paid' })).status, 409); // rival has not completed it
    assert.equal((await admin.post('/api/admin/brokers/ch%40test.com/payout-verify', { verified: true })).status, 200);
    assert.equal((await br.post('/api/broker/payout', { pp: 'EasyPaisa', pn: '03451234567' })).status, 200); // changing the details cancels the phone check
    assert.equal((await admin.post('/api/admin/brokers/ch%40test.com/reward', { status: 'paid' })).status, 409);
    assert.equal((await admin.post('/api/admin/brokers/ch%40test.com/payout-verify', { verified: true })).status, 200);
    assert.equal((await admin.post('/api/admin/brokers/ch%40test.com/reward', { status: 'paid', note: 'Sent by EasyPaisa' })).status, 200);
    const ac = (await admin.get('/api/admin/challenge')).json; const row = ac.rows.find(r => r.email === 'ch@test.com');
    assert.equal(ac.rewardPkr, 1000); assert.equal(row.ch.reward.status, 'paid'); assert.deepEqual([row.payout.provider, row.payout.number, row.payout.verified], ['EasyPaisa', '03451234567', true]);
    // it ends after 90 days: profiles verified before the window or after it do not count, and the challenge expires
    T.db.prepare("UPDATE broker_challenge SET ends_at=? WHERE broker='rv9@test.com'").run(new Date(Date.now() - 1000).toISOString());
    assert.equal((await rival.get('/api/broker/dashboard')).json.challenge.status, 'expired');
    assert.equal((await rival.get('/api/broker/dashboard')).json.challenge.remaining, 15);
  } finally { await T.stop(); }
});