'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { startServer, dirtyJpeg, HOOK } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(async () => { if (S) await S.stop(); });

const PROFILE = { n: 'Test Person', g: 'Female', a: 28, c: 'Riyadh', m: 'Never married', e: 'Bachelor', j: 'Teacher', x: 'About me text', w: 'Looking for text', agree: true };
const exp = (days = 30) => new Date(Date.now() + days * 864e5).toISOString();
/** A member with a saved profile and, optionally, an active membership (set directly; payment is tested separately). */
async function member(email, over = {}, paid = true) {
  const c = S.as(email, over.n || email.split('@')[0]);
  const r = await c.post('/api/profile', { ...PROFILE, ...over });
  assert.equal(r.status, 200, 'profile: ' + r.text);
  if (paid) S.db.prepare('INSERT OR REPLACE INTO memberships(email,plan,expires_at) VALUES(?,?,?)').run(email, 'prem', exp());
  return c;
}
const uidOf = async (viewer, name) => (await viewer.get('/api/members?c=')).json.rows.find(m => m.n === name).id;

/* ---------- basics ---------- */
test('health, plans, legal pages, robots, unknown API route', async () => {
  const a = S.anon();
  assert.deepEqual((await a.get('/healthz')).json, { ok: true });
  const plans = (await a.get('/api/plans')).json;
  assert.deepEqual(plans.map(p => [p.id, p.price, p.months]), [['basic', 29, 1], ['prem', 69, 3], ['plus', 119, 6], ['founder', 79, 6]]);
  assert.equal(plans[3].left, 100); assert.equal(plans[3].was, 119);
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
  assert.equal(cfg.paymentMode, 'test'); assert.ok(!JSON.stringify(cfg).includes('sk_test'));
});

/* ---------- profile ---------- */
test('profile: consent required once, validation, edit keeps working', async () => {
  const c = S.as('prof@test.com');
  assert.equal((await c.post('/api/profile', { ...PROFILE, agree: false })).status, 400);
  assert.equal((await c.post('/api/profile', { ...PROFILE, a: 15 })).status, 400);
  assert.equal((await c.post('/api/profile', { ...PROFILE, n: '' })).status, 400);
  assert.equal((await c.post('/api/profile', PROFILE)).status, 200);
  const me = (await c.get('/api/me')).json;
  assert.equal(me.consent, true); assert.equal(me.profile.n, 'Test Person'); assert.equal(me.membership.active, false);
  const edit = await c.post('/api/profile', { ...PROFILE, n: 'Renamed Person', agree: false });
  assert.equal(edit.status, 200, 'editing later does not need the box again');
  assert.equal((await c.get('/api/me')).json.profile.n, 'Renamed Person');
  assert.equal((await c.post('/api/profile', { ...PROFILE, m: '<script>' })).status, 200);
  assert.equal((await c.get('/api/me')).json.profile.m, 'Never married', 'unknown marital value is normalised');
});

/* ---------- payments ---------- */
async function checkout(c, plan = 'prem') { const r = await c.post('/api/checkout', { plan }); assert.equal(r.status, 200, r.text); return r.json; }

test('payment: checkout, return page verifies with Moyasar, membership starts, replay is harmless', async () => {
  const c = await member('pay1@test.com', {}, false);
  assert.equal((await c.get('/api/members')).status, 403, 'search is locked before payment');
  const co = await checkout(c);
  assert.equal(co.amount, 6900); assert.equal(co.currency, 'SAR'); assert.match(co.description, /\[RC-/); assert.ok(co.publishable_key.startsWith('pk_test_'));
  assert.ok(!JSON.stringify(co).includes('sk_test'));
  const mp = S.mz.add({ amount: 6900, metadata: { cart: co.payment_id }, description: co.description });
  const ret = await c.raw('GET', `/payment/return/${co.payment_id}?id=${mp.id}`);
  assert.equal(ret.status, 303); assert.match(ret.headers.get('location'), /payment=RC-/);
  assert.equal((await c.get('/api/payments/' + co.payment_id)).json.status, 'paid');
  const m1 = (await c.get('/api/me')).json.membership; assert.equal(m1.active, true); assert.equal(m1.plan, 'prem');
  await c.raw('GET', `/payment/return/${co.payment_id}?id=${mp.id}`); // replay
  assert.equal((await c.get('/api/me')).json.membership.expires_at, m1.expires_at, 'a replay never extends the membership');
  assert.equal((await c.get('/api/members')).status, 200);
});

test('payment: tampered amount, wrong cart, wrong currency, unpaid status and forged ids never activate', async () => {
  const c = await member('pay2@test.com', {}, false);
  const co = await checkout(c, 'plus'); // 119 SAR
  const cheap = S.mz.add({ amount: 100, metadata: { cart: co.payment_id } });
  await c.raw('GET', `/payment/return/${co.payment_id}?id=${cheap.id}`);
  const usd = S.mz.add({ amount: 11900, currency: 'USD', metadata: { cart: co.payment_id } });
  await c.raw('GET', `/payment/return/${co.payment_id}?id=${usd.id}`);
  const init = S.mz.add({ amount: 11900, status: 'initiated', metadata: { cart: co.payment_id } });
  await c.raw('GET', `/payment/return/${co.payment_id}?id=${init.id}`);
  const other = S.mz.add({ amount: 11900, metadata: { cart: 'RC-' + crypto.randomUUID() } });
  await c.raw('GET', `/payment/return/${co.payment_id}?id=${other.id}`);
  await c.raw('GET', `/payment/return/${co.payment_id}?id=../../etc/passwd`);
  await c.raw('GET', `/payment/return/${co.payment_id}?id=${crypto.randomUUID()}`);
  assert.equal((await c.get('/api/me')).json.membership.active, false);
  assert.equal((await c.get('/api/payments/' + co.payment_id)).json.status, 'pending');
  // someone else's paid payment cannot be claimed for another cart
  const d = await member('pay2b@test.com', {}, false), co2 = await checkout(d, 'basic');
  const real = S.mz.add({ amount: 2900, metadata: { cart: co2.payment_id } });
  await c.raw('GET', `/payment/return/${co.payment_id}?id=${real.id}`);
  assert.equal((await c.get('/api/me')).json.membership.active, false, 'a payment for another cart is rejected');
  const good = S.mz.add({ amount: 11900, metadata: { cart: co.payment_id } });
  await c.raw('GET', `/payment/return/${co.payment_id}?id=${good.id}`);
  assert.equal((await c.get('/api/me')).json.membership.active, true);
});

test('webhook: wrong secret, bad JSON, oversize, duplicate event, other-mode event, failed then paid', async () => {
  const a = S.anon();
  const hook = (body, h) => a.raw('POST', '/api/moyasar/webhook', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), { 'content-type': 'application/json', ...h });
  assert.equal((await hook({ secret_token: 'nope', type: 'payment_paid', data: { id: crypto.randomUUID() } })).status, 401);
  assert.equal((await hook('not json')).status, 400);
  assert.equal((await a.raw('POST', '/api/moyasar/webhook', Buffer.alloc(300 * 1024, 65), { 'content-type': 'application/json' })).status, 413);
  const c = await member('hook1@test.com', {}, false), co = await checkout(c, 'basic');
  const failed = S.mz.add({ amount: 2900, status: 'failed', metadata: { cart: co.payment_id } });
  assert.equal((await hook({ id: 'ev1', secret_token: HOOK, type: 'payment_failed', live: false, data: { id: failed.id } })).status, 200);
  assert.equal((await c.get('/api/payments/' + co.payment_id)).json.status, 'failed');
  const paid = S.mz.add({ amount: 2900, metadata: { cart: co.payment_id } });
  assert.equal((await hook({ id: 'ev2', secret_token: HOOK, type: 'payment_paid', live: true, data: { id: paid.id } })).status, 200);
  assert.equal((await c.get('/api/me')).json.membership.active, false, 'a live-mode event is ignored by a test-mode server');
  assert.equal((await hook({ id: 'ev3', secret_token: HOOK, type: 'payment_paid', live: false, data: { id: paid.id } })).status, 200);
  assert.equal((await c.get('/api/me')).json.membership.active, true, 'a payment that failed once and then succeeded activates');
  const exp1 = (await c.get('/api/me')).json.membership.expires_at;
  await hook({ id: 'ev3', secret_token: HOOK, type: 'payment_paid', live: false, data: { id: paid.id } });
  await hook({ id: 'ev4', secret_token: HOOK, type: 'payment_paid', live: false, data: { id: paid.id } });
  assert.equal((await c.get('/api/me')).json.membership.expires_at, exp1, 'duplicate events never extend it');
});

test('payment: a second plan extends the first; automatic approval when approval is required', async () => {
  const c = await member('pay3@test.com', {}, false);
  const one = await checkout(c, 'basic'), p1 = S.mz.add({ amount: 2900, metadata: { cart: one.payment_id } });
  await c.raw('GET', `/payment/return/${one.payment_id}?id=${p1.id}`);
  const e1 = new Date((await c.get('/api/me')).json.membership.expires_at);
  const two = await checkout(c, 'basic'), p2 = S.mz.add({ amount: 2900, metadata: { cart: two.payment_id } });
  await c.raw('GET', `/payment/return/${two.payment_id}?id=${p2.id}`);
  const e2 = new Date((await c.get('/api/me')).json.membership.expires_at);
  assert.ok(e2 - e1 > 27 * 864e5, 'renewal adds a month on top of the remaining time');
  assert.equal((await c.post('/api/checkout', { plan: 'free' })).status, 400);
  assert.equal((await S.as('noprofile@test.com').post('/api/checkout', { plan: 'basic' })).status, 409);
});

test('refund: admin only, refunds once even under a double click, ends the membership, failure releases the claim', async () => {
  const c = await member('ref1@test.com', {}, false), co = await checkout(c, 'basic');
  const mp = S.mz.add({ amount: 2900, metadata: { cart: co.payment_id } });
  await c.raw('GET', `/payment/return/${co.payment_id}?id=${mp.id}`);
  const admin = S.as('admin@test.com');
  assert.equal((await c.post(`/api/admin/payments/${co.payment_id}/refund`, { reason: 'because' })).status, 403);
  assert.equal((await admin.post(`/api/admin/payments/${co.payment_id}/refund`, { reason: '' })).status, 400);
  S.mz.failRefunds(true);
  assert.equal((await admin.post(`/api/admin/payments/${co.payment_id}/refund`, { reason: 'gateway down test' })).status, 502);
  assert.equal(S.db.prepare('SELECT status FROM payments WHERE id=?').get(co.payment_id).status, 'paid', 'a failed refund releases the claim');
  S.mz.failRefunds(false);
  const [r1, r2] = await Promise.all([1, 2].map(() => admin.post(`/api/admin/payments/${co.payment_id}/refund`, { reason: 'double click' })));
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409], 'exactly one refund goes through');
  assert.equal(S.mz.calls().filter(x => x.includes(mp.id) && x.startsWith('POST')).length, 2, 'one failed attempt plus one real refund');
  assert.equal((await c.get('/api/me')).json.membership.active, false);
  assert.equal((await c.get('/api/payments/' + co.payment_id)).json.status, 'refunded');
  assert.ok((await admin.get('/api/admin/audit')).json.rows.some(r => r.action === 'refund' && r.target === co.payment_id));
});

/* ---------- search, detail, shortlist ---------- */
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
test('chat rules: both sides need active membership; blocking stops it; brokers reply only', async () => {
  const a = await member('c-a@test.com', { n: 'Chat A' }), b = await member('c-b@test.com', { n: 'Chat B' }), u = await member('c-u@test.com', { n: 'Chat U' }, false);
  const bId = await uidOf(a, 'Chat B');
  const first = await a.post('/api/chats', { to: bId, body: 'Assalamu Alaikum' });
  assert.equal(first.status, 200, first.text);
  const convs = (await b.get('/api/chats')).json; assert.equal(convs[0].last.body, 'Assalamu Alaikum'); assert.equal(convs[0].unread, 1);
  assert.equal((await b.post(`/api/chats/${first.json.id}/messages`, { body: 'Wa alaikum' })).status, 200);
  assert.equal((await S.as('c-u@test.com').post('/api/chats', { to: bId, body: 'hi' })).status >= 400, true, 'an unpaid member cannot start a chat');
  // an outsider cannot read it
  assert.equal((await S.as('c-u@test.com').get('/api/chats/' + first.json.id)).status >= 400, true);
  await b.post('/api/blocks', { user: await (async () => (await b.get('/api/chats')).json[0].with.id)() });
  assert.ok((await a.post(`/api/chats/${first.json.id}/messages`, { body: 'still there?' })).status >= 400, 'a blocked member cannot message');
  // broker
  const bk = S.as('broker@test.com', 'Bro Ker');
  assert.equal((await bk.post('/api/broker/apply', { n: 'Bro Ker', c: 'Riyadh', e: '5 years', l: 'Urdu', s: 'Families', x: 'Hello' })).status, 200);
  assert.equal((await bk.get('/api/brokers')).json.length, 0, 'pending brokers are not listed');
  const admin = S.as('admin@test.com');
  assert.equal((await admin.post('/api/admin/brokers/broker%40test.com/approve', {})).status, 200);
  const list = (await S.anon().get('/api/brokers')).json; assert.equal(list.length, 1); assert.ok(!JSON.stringify(list).includes('@'));
  const ch = await u.post('/api/chats', { to: list[0].id, body: 'Please help me' });
  assert.equal(ch.status, 200, 'even an unpaid member with a profile can contact a broker: ' + ch.text);
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
test('photos: cleaned, hidden by default, shown only to active members, admin review', async () => {
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
  assert.equal((await unpaid.get('/api/photo/' + ownerId)).status, 404, 'not for people without a membership');
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
  const co = await checkout(a, 'basic'), mp = S.mz.add({ amount: 2900, metadata: { cart: co.payment_id } });
  await a.raw('GET', `/payment/return/${co.payment_id}?id=${mp.id}`);
  const ex = await a.get('/api/account/export');
  assert.equal(ex.status, 200); assert.match(ex.headers.get('content-disposition'), /attachment/);
  assert.equal(ex.json.profile.n, 'Leaver'); assert.equal(ex.json.conversations[0].messages[0].body, 'hello from the leaver');
  assert.ok(ex.json.photo.jpeg_base64.length > 20); assert.equal(ex.json.payments.length, 1);
  assert.ok(!ex.text.includes('x-b@test.com'), "someone else's email is never in my export");
  assert.equal((await S.anon().get('/api/account/export')).status, 401);

  assert.equal((await a.post('/api/account/delete', { confirm: 'delete' })).status, 400);
  assert.equal((await a.post('/api/account/delete', {})).status, 400);
  const pend = await checkout(a, 'basic');
  assert.equal((await a.post('/api/account/delete', { confirm: 'DELETE' })).status, 409, 'a payment in progress blocks deletion');
  S.db.prepare("UPDATE payments SET status='failed' WHERE id=?").run(pend.payment_id);
  const del = await a.post('/api/account/delete', { confirm: 'DELETE' });
  assert.equal(del.status, 200, del.text);
  assert.match(del.headers.get('set-cookie') || '', /rcg_session=;/);
  for (const [t, col] of [['users', 'email'], ['photos', 'email'], ['memberships', 'email'], ['verification', 'email'], ['shortlist', 'owner'], ['uid_map', 'email']]) assert.equal(S.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${col}='x-a@test.com'`).get().n, 0, t);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM messages WHERE conv_id=?').get(ch.json.id).n, 0);
  const pays = S.db.prepare('SELECT email FROM payments WHERE id=?').get(co.payment_id); assert.match(pays.email, /^deleted-[0-9a-f]{12}$/, 'payment record kept without the email');
  assert.equal((await b.get('/api/chats')).json.length, 0);
  assert.equal((await b.get('/api/members?c=')).json.rows.some(m => m.n === 'Leaver'), false);
  assert.ok((await S.as('admin@test.com').get('/api/admin/audit')).json.rows.some(r => r.action === 'account-deleted'));
  assert.ok(!JSON.stringify((await S.as('admin@test.com').get('/api/admin/audit')).json).includes('x-a@test.com'), 'the audit entry does not hold the email');
  // the old session no longer works; signing in again starts fresh and needs consent again
  assert.equal((await a.get('/api/me')).status, 401);
  S.db.prepare("INSERT INTO users(email,name,provider,created_at) VALUES('x-a@test.com','Leaver','google',?)").run(new Date().toISOString());
  const again = (await a.get('/api/me')).json; assert.equal(again.profile, null); assert.equal(again.consent, false); assert.equal(again.membership.active, false);
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
  T.db.close(); T.mz.close();
});

test('startup refuses unsafe configuration', async () => {
  for (const [label, extra, msg] of [
    ['mixed keys', { MOYASAR_SECRET_KEY: 'sk_live_abcdefghijklmnop' }, /SAME mode/],
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
  const admin = S.as('admin@test.com'), bk = S.as('rv-broker@test.com', 'Review Broker');
  assert.equal((await bk.post('/api/broker/apply', { n: 'Review Broker', c: 'Jeddah', e: '8 years', l: 'Urdu', s: 'Families', x: 'Hello' })).status, 200);
  const pendingId = (await S.anon().get('/api/brokers')).json.find(b => b.n === 'Review Broker');
  assert.equal(pendingId, undefined, 'a pending broker is not listed');
  assert.equal((await admin.post('/api/admin/brokers/rv-broker%40test.com/approve', {})).status, 200);
  const id = (await S.anon().get('/api/brokers')).json.find(b => b.n === 'Review Broker').id;
  const R = `/api/brokers/${id}/reviews`;
  const m1 = await member('rv-1@test.com', { n: 'Aisha Khan' }, false), m2 = await member('rv-2@test.com', { n: 'Bilal' }, false);
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

test('founder membership: first 100 (here 2) to sign in get the special price, once; others and visitors do not see it', async () => {
  const T = await startServer({ FOUNDER_LIMIT: '2', FOUNDER_PRICE: '59' });
  try {
    const ids = async c => (await c.get('/api/plans')).json.map(p => p.id).join();
    const admin = T.as('admin@test.com'); await admin.get('/api/me');                 // admins never take a spot
    const a = T.as('fa@test.com'), b = T.as('fb@test.com'), c = T.as('fc@test.com');
    assert.match(await ids(T.anon()), /founder/, 'visitors see the offer while spots remain');
    await a.get('/api/me'); await b.get('/api/me'); await c.get('/api/me');
    const pa = (await a.get('/api/plans')).json.find(p => p.id === 'founder');
    assert.equal(pa.n, 1); assert.equal(pa.price, 59); assert.equal(pa.left, 0);
    assert.equal((await b.get('/api/plans')).json.find(p => p.id === 'founder').n, 2);
    assert.doesNotMatch(await ids(c), /founder/, 'the third member never sees it');
    assert.doesNotMatch(await ids(T.anon()), /founder/, 'visitors stop seeing it when full');
    for (const m of [a, c]) await m.post('/api/profile', PROFILE);
    const bad = await c.post('/api/checkout', { plan: 'founder' }); assert.equal(bad.status, 403);
    const ok = await a.post('/api/checkout', { plan: 'founder' }); assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.amount, 5900);
    const row = T.db.prepare('SELECT plan,amount FROM payments WHERE id=?').get(ok.json.payment_id); assert.deepEqual({ ...row }, { plan: 'founder', amount: 59 });
  } finally { T.child.kill(); T.mz.close(); T.db.close(); }
});
