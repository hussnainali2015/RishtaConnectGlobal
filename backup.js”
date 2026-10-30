'use strict';
/**
 * Backup job. Takes a consistent snapshot of the database, verifies it, exports the audit log to CSV,
 * encrypts both files, proves the encrypted copy can be restored, copies it to a second location if configured,
 * and deletes old backups. Used by the server's scheduler, the admin "Back up now" button, and the command line:
 *   node backup.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { encryptFile, decryptFile, pruneBackups, stampOf } = require('./backup-lib');

const csvCell = v => { // same rules as the admin export: quote when needed, neutralise spreadsheet formulas
  let t = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};
const sha = f => new Promise((ok, no) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', d => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', no); });

async function runBackup(db, { dir, key, keep = 14, copyDir = '' }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of fs.readdirSync(dir)) { // leftovers from a crashed run
    if (f.startsWith('.tmp-')) { const p = path.join(dir, f); if (Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.rmSync(p, { recursive: true, force: true }); }
  }
  const stamp = stampOf(), tmp = fs.mkdtempSync(path.join(dir, '.tmp-'));
  try {
    const snap = path.join(tmp, 'snapshot.db'), csv = path.join(tmp, 'audit.csv');
    await db.backup(snap); // SQLite online backup: consistent even while the site is serving requests
    let auditRows = 0;
    const chk = new Database(snap, { readonly: true, fileMustExist: true });
    try {
      const ic = chk.pragma('integrity_check', { simple: true });
      if (ic !== 'ok') throw new Error('Snapshot failed the database integrity check: ' + ic);
      const fd = fs.openSync(csv, 'w', 0o600);
      try {
        fs.writeSync(fd, '﻿id,time,admin,action,target,reason\r\n');
        let buf = [];
        for (const r of chk.prepare('SELECT id,at,admin,action,payment_id AS target,reason FROM audit ORDER BY id').iterate()) {
          buf.push([r.id, r.at, r.admin, r.action, r.target, r.reason].map(csvCell).join(','));
          auditRows++;
          if (buf.length >= 1000) { fs.writeSync(fd, buf.join('\r\n') + '\r\n'); buf = []; }
        }
        if (buf.length) fs.writeSync(fd, buf.join('\r\n') + '\r\n');
      } finally { fs.closeSync(fd); }
    } finally { chk.close(); }

    const dbEnc = path.join(dir, `rishta-${stamp}.db.gz.enc`), csvEnc = path.join(dir, `audit-${stamp}.csv.gz.enc`);
    await encryptFile(snap, dbEnc, key);
    await encryptFile(csv, csvEnc, key);

    // Prove the encrypted database really restores: decrypt it and compare with the snapshot byte for byte.
    const back = path.join(tmp, 'restored.db');
    await decryptFile(dbEnc, back, key);
    if (await sha(back) !== await sha(snap)) throw new Error('Restore check failed: decrypted backup differs from the snapshot');

    const files = [path.basename(dbEnc), path.basename(csvEnc)];
    let copied = false, copyError = null;
    if (copyDir) {
      try {
        fs.mkdirSync(copyDir, { recursive: true, mode: 0o700 });
        for (const f of files) fs.copyFileSync(path.join(dir, f), path.join(copyDir, f));
        pruneBackups(copyDir, keep); copied = true;
      } catch (e) { copyError = 'Second copy failed: ' + e.message; }
    }
    pruneBackups(dir, keep);
    const bytes = files.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
    return { stamp, files, bytes, auditRows, copied, copyError };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

module.exports = { runBackup };

if (require.main === module) { // command line: reads the same .env as the server
  require('dotenv').config();
  const E = process.env;
  if (!/^[0-9a-f]{64}$/i.test(E.BACKUP_KEY || '')) { console.error('Set BACKUP_KEY to 64 hex characters (openssl rand -hex 32).'); process.exit(2); }
  const file = E.DB_FILE || path.join(__dirname, 'rishta.db');
  const db = new Database(file, { fileMustExist: true });
  runBackup(db, { dir: path.resolve(E.BACKUP_DIR || path.join(__dirname, 'backups')), key: Buffer.from(E.BACKUP_KEY, 'hex'), keep: parseInt(E.BACKUP_KEEP, 10) || 14, copyDir: E.BACKUP_COPY_DIR || '' })
    .then(r => { console.log(`Backup ${r.stamp} OK: ${r.files.join(', ')} (${r.bytes} bytes, ${r.auditRows} audit rows${r.copied ? ', second copy made' : ''})`); if (r.copyError) { console.error(r.copyError); process.exitCode = 1; } })
    .catch(e => { console.error('Backup failed: ' + e.message); process.exitCode = 1; })
    .finally(() => db.close());
}
