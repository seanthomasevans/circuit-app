/* Circuit data layer. Supabase for the mutable, synced entities.
   Reads cache to localStorage for offline; writes queue offline and flush on reconnect.
   Depends on the supabase-js UMD global (loaded in index.html) and window.CIRCUIT_CFG. */
window.DB = (() => {
  const cfg = window.CIRCUIT_CFG || {};
  const ready = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.startsWith('REPLACE');
  const sb = ready ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON, {
    auth: { persistSession: true, autoRefreshToken: true }
  }) : null;
  // Reference data (contacts, tasks, budget, schedule) ships static in the bundle.
  // Supabase holds ONLY what the user generates live, so there is nothing to seed and nothing to drift.
  const TABLES = ['item_state', 'captures', 'chat'];
  const QKEY = 'circuit:wq';
  const cacheGet = t => { try { return JSON.parse(localStorage.getItem('circuit:cache:' + t) || '[]'); } catch { return []; } };
  const cacheSet = (t, rows) => localStorage.setItem('circuit:cache:' + t, JSON.stringify(rows));
  const queue = () => { try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch { return []; } };
  const setQueue = q => localStorage.setItem(QKEY, JSON.stringify(q));

  async function ownerId() { const { data } = await sb.auth.getUser(); return data?.user?.id || null; }

  async function loadAll() {
    if (!ready) return {};
    const out = {};
    await Promise.all(TABLES.map(async t => {
      try {
        const { data, error } = await sb.from(t).select('*');
        // supabase-js returns errors in `error`, not by throwing. A transient error must NOT
        // overwrite the good cache with an empty array (that was a silent data-loss-on-read bug).
        if (error) { out[t] = cacheGet(t); return; }
        out[t] = data || []; cacheSet(t, out[t]);
      } catch { out[t] = cacheGet(t); }
    }));
    return out;
  }

  async function flush() {
    if (!ready || !navigator.onLine) return;
    let q = queue(); if (!q.length) return;
    const owner = await ownerId();
    const keep = [];
    for (const op of q) {
      try {
        if (op.kind === 'upsert') {
          const { error } = await sb.from(op.table).upsert(serverRow(op.table, op.row, owner),
            op.table === 'item_state' ? { onConflict: 'owner,key' } : undefined);
          if (error) throw error;
        } else if (op.kind === 'delete') {
          const col = op.table === 'item_state' ? 'key' : 'id';
          const { error } = await sb.from(op.table).delete().eq(col, op.id);
          if (error) throw error;
        }
      } catch { keep.push(op); }
    }
    setQueue(keep);
  }

  // item_state has a composite primary key (owner, key) and no id column.
  const rowKey = (table, r) => table === 'item_state' ? r.key : r.id;
  // Synchronous local cache write, so the UI can render a change instantly, before the network round-trip.
  const cachePut = (t, row) => { const k = rowKey(t, row); const rows = cacheGet(t).filter(r => rowKey(t, r) !== k); rows.push(row); cacheSet(t, rows); };
  const serverRow = (table, row, owner) => {
    // Strip client-only fields the table does not have before sending to PostgREST.
    if (table === 'item_state') { const { id, ...rest } = row; return { ...rest, owner }; }
    return { ...row, owner };
  };

  async function upsert(table, row) {
    const owner = ready ? await ownerId() : null;
    // optimistic cache update (cache keeps a stable local key; item_state mirrors key into id upstream)
    const k = rowKey(table, row);
    const rows = cacheGet(table).filter(r => rowKey(table, r) !== k); rows.push(row); cacheSet(table, rows);
    if (ready && navigator.onLine) {
      try {
        const q = sb.from(table).upsert(serverRow(table, row, owner),
          table === 'item_state' ? { onConflict: 'owner,key' } : undefined);
        const { error } = await q; if (!error) return;
      } catch {}
    }
    const wq = queue(); wq.push({ kind: 'upsert', table, row }); setQueue(wq);
  }
  async function remove(table, id) {
    cacheSet(table, cacheGet(table).filter(r => rowKey(table, r) !== id));
    if (ready && navigator.onLine) {
      try {
        const col = table === 'item_state' ? 'key' : 'id';
        const { error } = await sb.from(table).delete().eq(col, id); if (!error) return;
      } catch {}
    }
    const q = queue(); q.push({ kind: 'delete', table, id }); setQueue(q);
  }

  function subscribe(onChange) {
    if (!ready) return;
    sb.channel('circuit').on('postgres_changes', { event: '*', schema: 'public' }, () => onChange()).subscribe();
    window.addEventListener('online', () => flush().then(onChange));
  }

  // auth
  const auth = {
    async session() { return ready ? (await sb.auth.getSession()).data.session : null; },
    async signIn(email, password) { return sb.auth.signInWithPassword({ email, password }); },
    async signInLink(email) { return sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href } }); },
    async signOut() {
      // Clear the write queue and cached rows so a different login can't inherit or flush
      // the previous user's pending writes or see their cached data.
      localStorage.removeItem(QKEY);
      TABLES.forEach(t => localStorage.removeItem('circuit:cache:' + t));
      return sb.auth.signOut();
    },
    onChange(cb) { if (ready) sb.auth.onAuthStateChange((_e, s) => cb(s)); },
  };

  return { ready, TABLES, loadAll, upsert, remove, subscribe, flush, auth, cacheGet, cachePut };
})();
