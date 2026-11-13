#!/usr/bin/env node
'use strict';
/** Reads .env and tells you, in plain words, what is wrong before you start the site.  Usage: npm run check-env */
require('dotenv').config();
const E = process.env, bad = [], warn = [], ok = [];
const need = (k, test, msg) => { if (!E[k]) bad.push(`${k} is empty. ${msg}`); else if (test && !test(E[k])) bad.push(`${k} looks wrong. ${msg}`); else ok.push(k); };
need('BASE_URL', v => /^https:\/\/[^/\s]+$/.test(v) || /^http:\/\/localhost(:\d+)?$/.test(v), 'It must be your public address starting with https:// and with no slash at the end, e.g. https://rishta.example.com');
need('JWT_SECRET', v => v.length >= 32, 'Use 32 or more random characters: openssl rand -hex 32');
need('GOOGLE_CLIENT_ID', v => /\.apps\.googleusercontent\.com$/.test(v), 'It ends with .apps.googleusercontent.com (Google Cloud Console, Credentials).');
need('ADMIN_EMAILS', v => /@/.test(v), 'Put your own Google email so you can open the admin panel.');
for (const [k, v] of Object.entries(E)) if (/^\[REQUIRED/.test(String(v).trim())) bad.push(`${k} still says [REQUIRED ...]. Replace the whole bracket with your own value.`);
if (E.NODE_ENV !== 'production') warn.push('NODE_ENV is not "production". Set NODE_ENV=production on the real server so cookies are marked Secure.');
if (E.BACKUP_ENABLED === 'true') { if (!/^[0-9a-f]{64}$/i.test(E.BACKUP_KEY || '')) bad.push('BACKUP_ENABLED is true but BACKUP_KEY is not 64 hex characters (openssl rand -hex 32). It must be on ONE line.'); }
else warn.push('Backups are switched off (BACKUP_ENABLED=false). Turn them on before launch.');
if (E.BACKUP_AT && !/^([01]\d|2[0-3]):[0-5]\d$/.test(E.BACKUP_AT)) bad.push('BACKUP_AT must look like 00:30 (UTC).');
if (E.APPLE_CLIENT_ID && !/^https:/.test(E.APPLE_REDIRECT_URI || '')) bad.push('APPLE_CLIENT_ID is set, so APPLE_REDIRECT_URI must be an https:// address registered with Apple.');
const host = u => { try { return new URL(u).host; } catch { return ''; } };
if (E.APPLE_CLIENT_ID) {
  if (/^https?:|\s/.test(E.APPLE_CLIENT_ID)) bad.push('APPLE_CLIENT_ID must be the Services ID (like com.yourname.rishta.web), not a web address.');
  if (E.APPLE_REDIRECT_URI && host(E.APPLE_REDIRECT_URI) !== host(E.BASE_URL)) warn.push('APPLE_REDIRECT_URI is on a different address than BASE_URL. Apple requires the Return URL to be on the domain you registered.');
  if (E.APPLE_REDIRECT_URI && !/\/auth\/apple\/callback$/.test(E.APPLE_REDIRECT_URI)) warn.push('APPLE_REDIRECT_URI normally ends with /auth/apple/callback. It must match the Return URL registered with Apple exactly.');
} else warn.push('Apple sign-in is off (APPLE_CLIENT_ID empty). The Apple button will say "not configured". That is fine if you only want Google for now.');
if (E.GOOGLE_CLIENT_ID && E.BASE_URL && /^http:\/\/(?!localhost)/.test(E.BASE_URL)) bad.push('Google sign-in does not work on a plain http:// address. Use https:// (or localhost for testing).');
if (E.PERSIST_SUPABASE_URL || E.PERSIST_SUPABASE_KEY) {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(E.PERSIST_SUPABASE_URL || '')) bad.push('PERSIST_SUPABASE_URL must look like https://yourproject.supabase.co (no /rest/v1/ at the end).');
  if (!E.PERSIST_SUPABASE_KEY || /\[REQUIRED|\.\.\./.test(E.PERSIST_SUPABASE_KEY)) bad.push('PERSIST_SUPABASE_KEY is missing. Paste the whole Supabase secret key.');
  if (/^(sb_publishable_|eyJ.*anon)/.test(E.PERSIST_SUPABASE_KEY || '')) bad.push('PERSIST_SUPABASE_KEY is the public key. It must be the SECRET key (sb_secret_... or service_role).');
}
if (!E.SUPPORT_EMAIL) warn.push('SUPPORT_EMAIL is empty. The Contact page and Privacy Policy will have no address for members to write to.');
if (E.LEGAL_REVIEWED !== 'true') warn.push('LEGAL_REVIEWED is not "true". The Terms and Privacy pages show a "draft" notice until a lawyer has reviewed them.');
try { // typos in the file itself: the mistakes that actually happen (a hyphen or underscore instead of =, a key split over two lines)
  const KNOWN = /^(NODE_ENV|PORT|BASE_URL|JWT_SECRET|GOOGLE_CLIENT_ID|ADMIN_EMAILS|REQUIRE_APPROVAL|APPLE_CLIENT_ID|APPLE_REDIRECT_URI|BACKUP_ENABLED|BACKUP_KEY|BACKUP_AT|BACKUP_KEEP|BACKUP_DIR|BACKUP_COPY_DIR|BUSINESS_NAME|SUPPORT_EMAIL|LEGAL_REVIEWED|LEGAL_JURISDICTION|DB_FILE|PERSIST_SUPABASE_URL|PERSIST_SUPABASE_KEY|PERSIST_BUCKET|PERSIST_EVERY_SECONDS|API_RATE_LIMIT|DOMAIN)$/;
  require('fs').readFileSync('.env', 'utf8').split(/\r?\n/).forEach((l, n) => {
    if (!l.trim() || /^\s*#/.test(l)) return;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
    if (!m) bad.push(`Line ${n + 1} of .env is not written as NAME=value: "${l.slice(0, 40)}". Use an equals sign, no spaces, no hyphen.`);
    else { if (!KNOWN.test(m[1])) warn.push(`Line ${n + 1}: "${m[1]}" is not a setting this site uses. Check the spelling (capitals, underscores).`); if (/\s$/.test(m[2]) || /^\s/.test(m[2])) warn.push(`Line ${n + 1}: ${m[1]} has a space at the start or end of its value.`); }
  });
} catch { bad.push('There is no file named .env in this folder. Copy .env.example to .env and fill it in.'); }
console.log(ok.length + ' settings look fine.');
for (const w of warn) console.log('WARNING: ' + w);
for (const b of bad) console.log('PROBLEM: ' + b);
if (bad.length) { console.log('\nFix the problems above, then run this check again.'); process.exit(1); }
console.log('\nNo problems found. You can start the site.');
