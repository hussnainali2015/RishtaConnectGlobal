'use strict';
// Test harness: starts the real server as a child process against a temporary database.
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const JWT = 'j'.repeat(48);


async function startServer(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcg-'));
  const port = 20000 + Math.floor(Math.random() * 20000), base = 'http://127.0.0.1:' + port;
  const env = {
    ...process.env, NODE_ENV: 'test', PORT: String(port), BASE_URL: base, JWT_SECRET: JWT, GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com',
    ADMIN_EMAILS: 'admin@test.com,admin2@test.com', DB_FILE: path.join(dir, 'test.db'), API_RATE_LIMIT: '100000',
    BACKUP_ENABLED: 'true', BACKUP_KEY: 'ab'.repeat(32), BACKUP_DIR: path.join(dir, 'backups'), SUPPORT_EMAIL: 'help@example.test', ...extra,
  };
  delete env.__entry;
  const child = spawn(process.execPath, [extra.__entry || 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  try {
    await new Promise((ok, no) => {
      const t = setTimeout(() => no(new Error('server did not start:\n' + log)), 15000);
      const iv = setInterval(() => { if (/listening/.test(log)) { clearTimeout(t); clearInterval(iv); ok(); } if (child.exitCode !== null) { clearTimeout(t); clearInterval(iv); no(new Error('server exited:\n' + log)); } }, 50);
    });
  } catch (e) { child.kill(); throw e; }
  const db = new Database(env.DB_FILE);
  db.pragma('busy_timeout = 5000');
  const cookieFor = email => 'rcg_session=' + encodeURIComponent(jwt.sign({ email }, JWT, { expiresIn: '1h' }));
  const known = new Set();
  /** A browser-like client signed in as `email` (the user row is created if needed). */
  const as = (email, name) => {
    if (!known.has(email)) { db.prepare("INSERT OR IGNORE INTO users(email,name,provider,created_at) VALUES(?,?,?,?)").run(email, name || email.split('@')[0], 'google', new Date().toISOString()); known.add(email); }
    return client(base, email ? cookieFor(email) : '');
  };
  return {
    base, db, child, dir, env, cookieFor, log: () => log, as, anon: () => client(base, ''),
    async stop() { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); db.close(); },
  };
}

function client(base, cookie) {
  const call = async (method, url, body, extraHeaders = {}) => {
    const h = { 'x-requested-with': 'fetch', ...(cookie ? { cookie } : {}), ...extraHeaders };
    let b;
    if (body !== undefined) { if (Buffer.isBuffer(body)) b = body; else { b = JSON.stringify(body); h['content-type'] = 'application/json'; } }
    const r = await fetch(base + url, { method, headers: h, body: b, redirect: 'manual' });
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
    return { status: r.status, headers: r.headers, body: buf, text: buf.toString('utf8'), json };
  };
  return { get: (u, h) => call('GET', u, undefined, h), post: (u, b, h) => call('POST', u, b === undefined ? {} : b, h), raw: call };
}

/** A structurally valid JPEG carrying EXIF with GPS, an XMP block, a comment and trailing junk, to prove they are removed. */
function dirtyJpeg() {
  const seg = (m, data) => Buffer.concat([Buffer.from([0xFF, m, (data.length + 2) >> 8, (data.length + 2) & 255]), data]);
  const sof = Buffer.from([8, 0, 200, 0, 200, 1, 1, 0x11, 0]);
  return Buffer.concat([
    Buffer.from([0xFF, 0xD8]), seg(0xE0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    seg(0xE1, Buffer.from('Exif\0\0GPS-SECRET-LOCATION')), seg(0xE1, Buffer.from('http://ns.adobe.com/xap/1.0/\0XMP-SECRET')), seg(0xFE, Buffer.from('COMMENT-SECRET')),
    seg(0xDB, Buffer.alloc(65, 3)), seg(0xC0, sof), seg(0xC4, Buffer.alloc(20, 1)), seg(0xDA, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.alloc(40, 0x55), Buffer.from([0xFF, 0xD9]), Buffer.from('TRAILING-SECRET'),
  ]);
}

module.exports = { startServer, dirtyJpeg, JWT };
