'use strict';
/** Backup helpers: gzip + AES-256-GCM file encryption, restore, and retention. Built-in modules only. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const MAGIC = Buffer.from('RCGB1'), IV_LEN = 12, TAG_LEN = 16; // file layout: magic | iv | ciphertext | auth tag

const stampOf = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261028-013800 (UTC)

async function encryptFile(src, dst, key) {
  const iv = crypto.randomBytes(IV_LEN), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = fs.createWriteStream(dst, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, iv]));
  try {
    await pipeline(fs.createReadStream(src), zlib.createGzip(), cipher,
      async function* (source) { for await (const c of source) yield c; yield cipher.getAuthTag(); }, out);
  } catch (e) { fs.rmSync(dst, { force: true }); throw e; }
}

async function decryptFile(src, dst, key) {
  const size = fs.statSync(src).size, head = MAGIC.length + IV_LEN;
  if (size < head + TAG_LEN + 1) throw new Error('File is too small to be a backup');
  const fd = fs.openSync(src, 'r'), h = Buffer.alloc(head), tag = Buffer.alloc(TAG_LEN);
  try { fs.readSync(fd, h, 0, head, 0); fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN); } finally { fs.closeSync(fd); }
  if (!h.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Rishta backup file');
  const d = crypto.createDecipheriv('aes-256-gcm', key, h.subarray(MAGIC.length));
  d.setAuthTag(tag);
  try {
    await pipeline(fs.createReadStream(src, { start: head, end: size - TAG_LEN - 1 }), d, zlib.createGunzip(), fs.createWriteStream(dst, { mode: 0o600 }));
  } catch (e) {
    fs.rmSync(dst, { force: true }); // never leave half-decrypted data behind
    throw new Error('Could not decrypt: wrong BACKUP_KEY, or the file was altered or damaged');
  }
}

/** Keep the newest `keep` backup sets (a set = the database file and the audit CSV that share a timestamp). */
function pruneBackups(dir, keep) {
  const re = /^(?:rishta|audit)-(\d{8}-\d{6})\.(?:db|csv)\.gz\.enc$/, files = fs.readdirSync(dir);
  const stamps = [...new Set(files.map(f => (re.exec(f) || [])[1]).filter(Boolean))].sort().reverse();
  const old = new Set(stamps.slice(keep));
  for (const f of files) { const m = re.exec(f); if (m && old.has(m[1])) fs.rmSync(path.join(dir, f)); }
  return old.size;
}

module.exports = { encryptFile, decryptFile, pruneBackups, stampOf };
