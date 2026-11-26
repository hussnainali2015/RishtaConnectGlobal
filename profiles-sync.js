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
    if (status === 404 || /PGRST205|relation .* does not exist|Could not find the table/i.test(body)) // a missing COLUMN (PGRST204) is handled below return `the table "${table}" does not exist in Supabase. Run the SQL in SUPABASE-PROFILES.md once.`;
    if (status === 401 || status === 403 || /JWT|apikey|permission denied/i.test(body)) return 'Supabase refused the key. Use the SECRET key (sb_secret_... or service_role), not the public one.';
    let j = {}; try { j = JSON.parse(body); } catch { /* not json */ }
    const code = j.code || '', msg = j.message || body.slice(0, 200), raw = `HTTP ${status} ${code} ${msg}`.trim();
    if (code === 'PGRST204' || /Could not find the '.*' column/i.test(msg)) return `${raw}. The table "${table}" in Supabase has different columns from what the site sends. Run the "fix an existing table" SQL in SUPABASE-PROFILES.md, or use a new table name (PROFILES_TABLE=member_profiles) and create it with the SQL there.`;
    if (code === '42P10' || /ON CONFLICT/i.test(msg)) return `${raw}. The "email" column must be the primary key or have a unique constraint. Run the "fix an existing table" SQL in SUPABASE-PROFILES.md.`;
    if (code === '23502') return `${raw}. A column that the site does not fill (for example "id") is marked NOT NULL with no default. Run the "fix an existing table" SQL in SUPABASE-PROFILES.md.`;
    if (code === '22P02' || code === '22007' || code === '42804') return `${raw}. A column has a type that does not match the data (the site sends text for email, name, provider, status, consent_at, created_at; json for profile; a timestamp for updated_at).`;
    if (code === '23503') return `${raw}. The table has a foreign key (for example to auth.users) that the site's rows cannot satisfy. Use a separate table name (PROFILES_TABLE=member_profiles).`;
    return raw;
  }
  const WANT = ['email', 'name', 'provider', 'profile', 'status', 'consent_at', 'created_at', 'updated_at'];
  /** Reads the table's shape from Supabase once, and says in plain words what is wrong with it. Never blocks sign-ups. */
  async function checkSchema() {
    const problems = [];
    try {
      const r = await fetch(`${base}/rest/v1/`, { headers: headers({ accept: 'application/openapi+json' }) });
      if (!r.ok) return problems; // some projects do not expose it: skip quietly
      const spec = await r.json();
      const def = (spec.definitions && spec.definitions[table]) || (spec.components && spec.components.schemas && spec.components.schemas[table]);
      if (!def) problems.push(`the table "${table}" does not exist in Supabase yet. Run the SQL in SUPABASE-PROFILES.md once.`);
      else {
        const props = def.properties || {}, have = Object.keys(props);
        const missing = WANT.filter(c => !have.includes(c)), needed = (def.required || []).filter(c => !WANT.includes(c));
        if (missing.length) problems.push(`the table "${table}" has no column named: ${missing.join(', ')}. Run the "fix an existing table" SQL in SUPABASE-PROFILES.md.`);
        if (needed.length) problems.push(`the table "${table}" requires a value for: ${needed.join(', ')}, which the site does not send. Run the "fix an existing table" SQL in SUPABASE-PROFILES.md.`);
        if (props.email && !/Primary Key/i.test(props.email.description || '')) problems.push('"email" is not the primary key. It needs a unique constraint for saving to work (see "fix an existing table" in SUPABASE-PROFILES.md).');
      }
    } catch { /* offline or blocked: skip */ }
    for (const m of problems) console.error('Supabase profiles check: ' + m);
    return problems;
  }
  api.checkSchema = checkSchema;
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
    await checkSchema();
    for (const r of db.prepare('SELECT email FROM users').all()) dirty.add(r.email);
    await drain();
    if (!dirty.size) console.log(`Supabase table "${table}" is up to date.`);
  };
  const t = setInterval(() => { if (dirty.size || gone.size) drain(); }, 30000); t.unref();
  return api;
};