'use strict';
/* Copies every member's signup/profile data into a Supabase table called "profiles" (readable in the Supabase Table Editor).
 *
 * How it fits: the site keeps working from its own database (fast, and it keeps working if Supabase is down). Every time something
 * changes (sign-up, profile saved, approved/suspended, account deleted) the change is also written to Supabase straight away.
 * If Supabase cannot be reached, the change is kept in a list and retried every 30 seconds. On every start the whole table is
 * brought up to date, so nothing is missed. It is switched on by SUPABASE_URL + SUPABASE_SECRET_KEY
 * (or, if those are missing, the PERSIST_SUPABASE_URL + PERSIST_SUPABASE_KEY already used for backups).
 */
module.exports = function (db, E, mstatus) {
  const rawUrl = E.SUPABASE_URL || E.PERSIST_SUPABASE_URL || '';
  const key = (E.SUPABASE_SECRET_KEY || E.PERSIST_SUPABASE_KEY || '').trim();
  const table = E.PROFILES_TABLE || 'profiles';
  const base = rawUrl.trim().replace(/\/+$/, '').replace(/\/(rest|storage)\/v1.*$/, '');
  const enabled = !!(base && key) && E.PROFILES_SYNC !== 'false';
  const dirty = new Set(), gone = new Set();
  let warned = false, running = false;
  const api = { enabled, pending: () => dirty.size + gone.size };
  if (!enabled) { api.sync = api.remove = () => {}; api.backfill = async () => {}; api.flush = async () => {}; return api; }

  const headers = extra => { const h = { apikey: key, ...extra }; if (key.startsWith('eyJ')) h.authorization = 'Bearer ' + key; return h; };
  const url = q => `${base}/rest/v1/${encodeURIComponent(table)}${q || ''}`;
  function explain(status, body) {
    if (status === 404 || /PGRST205|does not exist|schema cache/i.test(body)) return `the table "${table}" does not exist in Supabase. Run the SQL in SUPABASE-PROFILES.md once.`;
    if (status === 401 || status === 403 || /JWT|apikey|permission denied/i.test(body)) return 'Supabase refused the key. Use the SECRET key (sb_secret_... or service_role), not the public one.';
    return `HTTP ${status} ${body.slice(0, 200)}`;
  }
  function row(email) {
    const u = db.prepare('SELECT email,name,provider,profile_json,consent_at,created_at FROM users WHERE email=?').get(email);
    if (!u) return null;
    let profile = null; try { profile = u.profile_json ? JSON.parse(u.profile_json) : null; } catch { /* keep null */ }
    return { email: u.email, name: u.name || '', provider: u.provider || '', profile, status: profile ? mstatus(email) : 'incomplete',
      consent_at: u.consent_at || null, created_at: u.created_at || null, updated_at: new Date().toISOString() };
  }
  async function call(method, q, body, prefer) {
    const r = await fetch(url(q), { method, headers: headers({ 'content-type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) }), body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(explain(r.status, await r.text().catch(() => '')));
  }
  async function pushBatch(emails) {
    const rows = emails.map(row).filter(Boolean);
    for (let i = 0; i < rows.length; i += 200) await call('POST', '?on_conflict=email', rows.slice(i, i + 200), 'resolution=merge-duplicates,return=minimal');
  }
  async function drain() {
    if (running) return; running = true;
    try {
      const list = [...dirty]; dirty.clear();
      if (list.length) try { await pushBatch(list); warned = false; } catch (e) { list.forEach(x => dirty.add(x)); if (!warned) { console.error('Supabase profiles sync failed (will retry):', e.message); warned = true; } }
      for (const em of [...gone]) {
        try { await call('DELETE', '?email=eq.' + encodeURIComponent(em)); gone.delete(em); } catch (e) { if (!warned) { console.error('Supabase profiles delete failed (will retry):', e.message); warned = true; } }
      }
    } finally { running = false; }
  }
  api.sync = email => { if (!email) return; gone.delete(email); dirty.add(email); setImmediate(drain); };
  api.remove = email => { if (!email) return; dirty.delete(email); gone.add(email); setImmediate(drain); };
  api.flush = async () => { await drain(); };
  api.backfill = async () => { // bring the whole table up to date (first start, or after any outage)
    for (const r of db.prepare('SELECT email FROM users').all()) dirty.add(r.email);
    await drain();
    if (!dirty.size) console.log(`Supabase table "${table}" is up to date.`);
  };
  const t = setInterval(() => { if (dirty.size || gone.size) drain(); }, 30000); t.unref();
  return api;
};
