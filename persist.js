'use strict';
/**
 * Free hosting without a disk: keeps the SQLite database safe in a private Supabase Storage bucket.
 *  - On start, if the local database file is missing (a free host wipes its disk), the newest copy is downloaded.
 *  - While running, an encrypted snapshot is uploaded every few seconds after any change, and once a day regardless.
 *  - On shutdown a final snapshot is uploaded.
 * Turn it on by setting PERSIST_SUPABASE_URL and PERSIST_SUPABASE_KEY (the secret key). Copies are encrypted with BACKUP_KEY.
 * If the stored copy cannot be read, the server REFUSES to start rather than begin empty and overwrite good data.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encryptFile, decryptFile } = require('./backup-lib');

const E = process.env;
const on = () => !!(E.PERSIST_SUPABASE_URL && E.PERSIST_SUPABASE_KEY);
const BUCKET = E.PERSIST_BUCKET || 'rcg-data';
const dbFile = () => E.DB_FILE || path.join(__dirname, 'rishta.db');
const key = () => Buffer.from(E.BACKUP_KEY || '', 'hex');
const base = () => E.PERSIST_SUPABASE_URL.replace(/\/+$/, '').replace(/\/(rest|storage)\/v1.*$/, '');
const hdr = extra => {
  const k = E.PERSIST_SUPABASE_KEY, h = { apikey: k, ...extra };
  if (k.startsWith('eyJ')) h.authorization = 'Bearer ' + k; // old-style JWT keys also need this header
  return h;
};
const tmpFile = n => path.join(os.tmpdir(), `rcg-persist-${process.pid}-${n}`);

async function ensureBucket() {
  const r = await fetch(`${base()}/storage/v1/bucket`, { method: 'POST', headers: hdr({ 'content-type': 'application/json' }), body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }) });
  if (r.ok) return;
  const t = await r.text();
  if (r.status === 409 || /already exists|Duplicate/i.test(t)) return;
  throw new Error(`cannot prepare storage bucket (${r.status}): ${t.slice(0, 160)}`);
}
async function put(name, file) {
  const r = await fetch(`${base()}/storage/v1/object/${BUCKET}/${name}`, { method: 'POST', headers: hdr({ 'x-upsert': 'true', 'content-type': 'application/octet-stream' }), body: fs.readFileSync(file) });
  if (!r.ok) throw new Error(`upload ${name} failed (${r.status}): ${(await r.text()).slice(0, 160)}`);
}
async function get(name) { // Buffer, or null when the file does not exist
  const r = await fetch(`${base()}/storage/v1/object/${BUCKET}/${name}`, { headers: hdr() });
  if (r.ok) return Buffer.from(await r.arrayBuffer());
  const t = await r.text();
  if (r.status === 404 || (r.status === 400 && /not.?found/i.test(t))) return null;
  throw new Error(`download ${name} failed (${r.status}): ${t.slice(0, 160)}`);
}

/** Call before the server opens the database. */
async function restore() {
  if (!on()) return 'off';
  if (!/^[0-9a-f]{64}$/i.test(E.BACKUP_KEY || '')) throw new Error('PERSIST needs BACKUP_KEY (64 hex characters) to encrypt the stored copy.');
  if (fs.existsSync(dbFile())) return 'local database present';
  await ensureBucket();
  const buf = await get('latest.db.enc');
  if (!buf) return 'no stored copy yet (first run)';
  const enc = tmpFile('in.enc'), out = tmpFile('in.db');
  fs.writeFileSync(enc, buf);
  try {
    await decryptFile(enc, out, key());
    fs.mkdirSync(path.dirname(dbFile()), { recursive: true });
    fs.copyFileSync(out, dbFile());
  } finally { fs.rmSync(enc, { force: true }); fs.rmSync(out, { force: true }); }
  return 'restored from storage';
}

let db, timer, busy = false, lastChanges = -1, lastUp = 0;
async function snapshot(force) {
  if (!db || busy) return false;
  const ch = db.prepare('SELECT total_changes() AS n').get().n;
  if (!force && ch === lastChanges && Date.now() - lastUp < 24 * 3600e3) return false;
  busy = true;
  const snap = tmpFile('out.db'), enc = tmpFile('out.enc');
  try {
    await db.backup(snap);
    await encryptFile(snap, enc, key());
    await put('latest.db.enc', enc);
    if (Date.now() - lastUp > 6 * 3600e3 || lastUp === 0) await put(`daily-${new Date().getUTCDay()}.db.enc`, enc); // 7 rotating older copies
    lastChanges = ch; lastUp = Date.now();
    return true;
  } catch (e) { console.error('Storage sync failed (will retry):', e.message); return false; }
  finally { busy = false; fs.rmSync(snap, { force: true }); fs.rmSync(enc, { force: true }); }
}
function attach(database) {
  if (!on()) return;
  db = database;
  const every = Math.max(5, parseInt(E.PERSIST_EVERY_SECONDS, 10) || 15) * 1000;
  timer = setInterval(() => { snapshot(false); }, every); timer.unref();
  snapshot(true).then(() => console.log('Storage sync is on (private bucket "' + BUCKET + '").'));
}
async function flush() { // last upload before the process exits
  if (!on() || !db) return;
  clearInterval(timer);
  for (let i = 0; i < 20 && busy; i++) await new Promise(r => setTimeout(r, 250));
  await snapshot(true); // always upload on the way out
}
module.exports = { on, restore, attach, flush };
