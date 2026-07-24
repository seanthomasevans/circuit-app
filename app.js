/* Circuit app. One shell, hash router, four views, one detail sheet.
   Static reference (event, objectives, dayplan, sessions, briefs, packing, logistics) arrives encrypted
   in window.__CIPHER__, unlocked by the login password. Mutable synced entities (contacts, tasks,
   meetings, budget_items, item_state, captures) come live from Supabase via window.DB and are merged in. */
(() => {
'use strict';
let DATA = null;      // static reference, unlocked from the cipher
let REF = null;       // the raw decrypted reference (kept so we can re-merge on every DB change)
const $ = s => document.querySelector(s);
// House style: no em dashes in rendered prose. Normalize source em/en-dash separators at display time
// (data files are source-of-truth and not edited here). Em dash between words -> comma; stray en dash between spaces -> comma.
const esc = s => (s == null ? '' : String(s))
  .replace(/\s*—\s*/g, ', ')
  .replace(/(\S)\s+–\s+(\S)/g, '$1, $2')
  .replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const store = { get: k => { try { return JSON.parse(localStorage.getItem('circuit:' + k) || 'null'); } catch { return null; } },
                set: (k, v) => localStorage.setItem('circuit:' + k, JSON.stringify(v)) };

const SIG_MAP='https://maps.goeshow.com/acm/siggraph/2026/floor_map';
const gmap=q=>'https://maps.google.com/?q='+encodeURIComponent(q);
const EXTERNAL=/LAX|Blvd|Ave\b|\bDr\b|\bSt\b|Station|Broadway|Grand\b|Figueroa|Spring|STILE|Green Qween|Whole Foods|Verve|Grand Central|Bottega|Perch|Ralphs|Queen|Revolver|dispensary|barber/i;
function placeHref(w){ if(!w) return SIG_MAP; return EXTERNAL.test(w)?gmap(w):SIG_MAP; }
function placeLink(w,cls){ if(!w) return ''; return `<a class="${(cls||'')+' maplink'}" href="${placeHref(w)}" target="_blank" rel="noopener">${esc(w)}</a>`; }

// LACC walk-time model: classify a room into a building zone, estimate minutes to walk between two.
function roomZone(w){
  const s=(w||'').toLowerCase();
  if(/west hall|exhibit|\bfloor\b|appy/.test(s)) return 'west';
  if(/hall k|hall j|hall h|south hall(?! steps)/.test(s)) return 'southk';
  if(/concourse|immersive|art gallery|emerging|south hall steps/.test(s)) return 'concourse';
  if(/petree/.test(s)) return 'petree';
  if(/\b5\d\d|502|511|515|518/.test(s)) return 'rooms5';
  if(/\b4\d\d|403|406|408|411/.test(s)) return 'rooms4';
  return '';
}
const ZONE_WALK={
  'west-southk':9,'west-concourse':5,'west-petree':8,'west-rooms4':9,'west-rooms5':9,
  'southk-concourse':5,'southk-petree':7,'southk-rooms4':8,'southk-rooms5':8,
  'concourse-petree':3,'concourse-rooms4':6,'concourse-rooms5':6,
  'petree-rooms4':5,'petree-rooms5':5,'rooms4-rooms5':4,
};
function walkMin(a,b){ if(!a||!b) return 0; if(a===b) return 3; return ZONE_WALK[a+'-'+b]||ZONE_WALK[b+'-'+a]||6; }

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const toMin = t => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const todayISO = () => { const n = new Date(); return n.getFullYear() + '-' + String(n.getMonth()+1).padStart(2,'0') + '-' + String(n.getDate()).padStart(2,'0'); };
const shortDate = iso => { const p = iso.split('-'); return MONTHS[+p[1]-1] + ' ' + (+p[2]); };

/* ---------- budget engine (JS port of circuit/models.compute_budget) ---------- */
function computeBudget(items, currency) {
  const rows = [], byCatM = {}, byPayerM = {};
  let actual = 0, est = 0;
  (items || []).forEach(it => {
    const line = Math.round(Number(it.amount || 0) * parseInt(it.qty || 1, 10) * 100) / 100;
    rows.push({ ...it, line });
    byCatM[it.cat] = Math.round(((byCatM[it.cat] || 0) + line) * 100) / 100;
    byPayerM[it.payer] = Math.round(((byPayerM[it.payer] || 0) + line) * 100) / 100;
    if (it.actual) actual += line; else est += line;
  });
  const total = Math.round((actual + est) * 100) / 100;
  const sean = byPayerM['Sean'] || 0;
  const covered = Math.round((total - sean) * 100) / 100;
  return {
    currency: currency || 'CAD',
    rows: rows.slice().sort((a, b) => b.line - a.line),
    by_cat: Object.entries(byCatM).map(([cat, t]) => ({ cat, total: t })).sort((a, b) => b.total - a.total),
    by_payer: Object.entries(byPayerM).map(([payer, t]) => ({ payer, total: t })).sort((a, b) => b.total - a.total),
    total, actual: Math.round(actual * 100) / 100, estimate: Math.round(est * 100) / 100,
    your_cost: sean, covered,
  };
}

/* ---------- merge: static reference + mutable DB entities into one DATA the views read ---------- */
function mergeData(db) {
  db = db || {};
  const d = { ...REF };
  // Reference data (contacts, tasks, meetings, budget, sessions, day-plan) already lives in REF, the
  // static bundle, which is the single source of truth. Supabase only overlays user-generated live data:
  //   item_state -> checks / stars / done   ·   captures -> knowledge   ·   chat -> the agent conversation.
  const state = {}; (db.item_state || []).forEach(r => { state[r.key] = r.value; });
  d._state = state;
  d.captures = db.captures || [];
  d.chat = (db.chat || []).slice().sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  // Budget follows the selected hotel: swap the Lodging line's nightly to the picked hotel's rate.
  const lo = d.logistics && d.logistics.lodging_options;
  if (d.budget_items && lo && (lo.picks || []).length) {
    const sh = lo.picks.find(p => p.id === (state['hotel'] || lo.selected_default)) || lo.picks[0];
    const items = d.budget_items.map(it => (sh && it.cat === 'Lodging')
      ? { ...it, amount: sh.nightly, label: sh.name + ', ' + (it.qty || 5) + ' nights', note: (sh.booked ? 'Don covers it, ' : '') + '~$' + sh.nightly + '/nt' }
      : it);
    d.budget = computeBudget(items, (d.budget && d.budget.currency) || 'CAD');
  }
  DATA = d;
}
// The currently-selected hotel (item_state 'hotel', else the default), and a plain-English commute line.
function selectedHotel() {
  const lo = (DATA.logistics && DATA.logistics.lodging_options) || {};
  const picks = lo.picks || [];
  return picks.find(p => p.id === ((DATA._state && DATA._state['hotel']) || lo.selected_default)) || picks[0] || null;
}
function commuteStr(h) {
  if (!h) return '';
  return h.mode === 'walk' ? `~${h.walk_min} min walk to the LACC (${h.dist})`
    : `${h.dist} out, so rideshare (~$8-10, 5-10 min) or Metro. Not a walk.`;
}

/* ---------- unlock ---------- */
async function decrypt(pw) {
  const c = window.__CIPHER__;
  const enc = new TextEncoder();
  const raw = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64(c.salt), iterations: c.iter, hash: 'SHA-256' },
    raw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(c.iv) }, key, b64(c.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
function b64(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

async function boot() {
  // Dev plaintext shortcut (no auth, no DB): window.DATA carries everything.
  if (window.DATA) { REF = window.DATA; mergeData(DATA_devTables(window.DATA)); $('#gate').classList.add('hide'); start(); return; }

  $('#gate').classList.add('hide');   // keep it hidden while we try a silent auto-unlock; shown only if that fails
  const emailEl = $('#email'), pwEl = $('#pw');
  emailEl.value = store.get('email') || '';

  // Remembered credentials: auto-unlock silently, no gate. Every reload/deploy just re-decrypts the
  // fresh bundle and re-auths with the saved password, so you are never bounced to the login again.
  const savedEmail = store.get('email'), savedPw = store.get('pw');
  if (savedEmail && savedPw) {
    try {
      const ref = await decrypt(savedPw);           // throws if the password is wrong or changed
      if (DB.ready) { const { error } = await DB.auth.signIn(savedEmail, savedPw); if (error) throw new Error('auth'); }
      REF = ref;
      await enter();
      return;                                        // stayed signed in, gate never shown
    } catch (e) { store.set('pw', null); }           // stale/changed: clear and fall through to the gate
  }

  $('#gate').classList.remove('hide');
  const signIn = async () => {
    $('#gerr').textContent = '';
    const email = (emailEl.value || '').trim();
    const pw = pwEl.value || '';
    if (!email || !pw) { $('#gerr').textContent = 'Enter your email and password.'; return; }
    $('#unlock').disabled = true; $('#unlock').textContent = 'Signing in…';
    try {
      // (a) decrypt the static bundle, (b) authenticate Supabase, both with the SAME password.
      const ref = await decrypt(pw);            // throws on wrong password
      const { error } = await DB.auth.signIn(email, pw);
      if (error) throw new Error(error.message || 'auth');
      REF = ref;
      store.set('email', email);
      store.set('pw', pw);                      // remember it so reloads and deploys keep you in
      await enter();
    } catch (e) {
      $('#gerr').textContent = /auth|invalid|credential/i.test(String(e && e.message))
        ? 'Wrong email or password.' : 'Wrong password.';
    } finally {
      $('#unlock').disabled = false; $('#unlock').textContent = 'Sign in';
    }
  };

  $('#unlock').onclick = signIn;
  pwEl.onkeydown = e => { if (e.key === 'Enter') signIn(); };
  emailEl.onkeydown = e => { if (e.key === 'Enter') pwEl.focus(); };
  (emailEl.value ? pwEl : emailEl).focus();
}

// In dev (plaintext) mode there is no Supabase, so the live tables start empty; reference is in REF.
function DATA_devTables(d) {
  return { item_state: [], captures: d.captures || [], chat: d.chat || [] };
}

/* ---------- enter: load DB, merge, subscribe, start ---------- */
let reloadPending = false;
async function reloadFromDB() {
  const db = DB.ready ? await DB.loadAll() : {};
  mergeData(db);
}
async function enter() {
  if (DB.ready) {
    try { await reloadFromDB(); }
    catch { mergeData(dbFromCache()); }   // offline: hydrate from cache
    DB.subscribe(() => {
      if (reloadPending) return;
      reloadPending = true;
      reloadFromDB().then(() => { reloadPending = false; rerender(); }).catch(() => { reloadPending = false; });
    });
    DB.flush();
  } else {
    mergeData({});
  }
  $('#gate').classList.add('hide');
  start();
}
function dbFromCache() {
  const o = {};
  (DB.TABLES || []).forEach(t => { o[t] = DB.cacheGet(t); });
  return o;
}

/* ---------- start ---------- */
function start() {
  $('#app').classList.remove('hide');
  window.addEventListener('hashchange', route);
  document.querySelectorAll('nav.tabs a').forEach(a => a.onclick = () => { location.hash = '#/' + a.dataset.route; });
  const fab = $('#fab'); if (fab) fab.onclick = openFabMenu;
  $('#scrim').onclick = closeSheet;
  setCtx();
  if (!location.hash) location.hash = '#/today';
  route();
}
function setCtx() {
  const arrive = DATA.event?.arrive || DATA.dayplan?.days?.[0]?.date;
  if (!arrive) return;
  const days = Math.ceil((new Date(arrive + 'T09:00') - new Date()) / 86400000);
  $('#ctx').textContent = days > 0 ? 'Arrival in ' + days + (days === 1 ? ' day' : ' days') : (DATA.event?.name || '');
}

/* ---------- router ---------- */
const TABS = ['today', 'schedule', 'people', 'prep', 'money', 'knowledge', 'agent'];
const VIEWS = { today: viewToday, schedule: viewSchedule, people: viewPeople, prep: viewPrep, money: viewMoney, knowledge: viewKnowledge, agent: viewAgent };
function route() {
  const [seg, id] = (location.hash.replace('#/', '') + '/').split('/');
  const tab = TABS.includes(seg) ? seg : 'today';
  document.querySelectorAll('nav.tabs a').forEach(a => a.classList.toggle('on', a.dataset.route === tab));
  const fab = document.getElementById('fab'); if (fab) fab.style.display = (tab === 'knowledge' || tab === 'agent') ? 'none' : '';
  VIEWS[tab]();
  if (id && (tab === 'people' || tab === 'schedule')) { tab === 'people' ? sheetPerson(id) : sheetSession(id); } else closeSheet();
  window.scrollTo(0, 0);
}
// Re-render the active view in place after a DB change, without scroll-jumping or forcing a route.
function rerender() {
  const seg = (location.hash.replace('#/', '') + '/').split('/')[0];
  const tab = TABS.includes(seg) ? seg : 'today';
  const y = window.scrollY;
  VIEWS[tab]();
  // if a sheet is open, refresh its contents from the new data
  if (sheetState.kind === 'person') sheetPerson(sheetState.id, true);
  else if (sheetState.kind === 'task') sheetTask(sheetState.id, true);
  window.scrollTo(0, y);
}
function render(h) { $('#view').innerHTML = h; }

/* ---------- DB write helpers (optimistic: write, re-merge from cache, re-render) ---------- */
async function saveRow(table, row) {
  DB.cachePut(table, row);                 // optimistic: local cache + render now
  mergeData(dbFromCache()); rerender();
  await DB.upsert(table, row);             // persist (realtime reconciles later)
  await syncAfterWrite();
}
async function deleteRow(table, id) {
  await DB.remove(table, id);
  await syncAfterWrite();
}
async function saveState(key, value) {
  // item_state PK is (owner, key); db.js caches by .id, so mirror key into id for the local cache.
  // One optimistic re-render, then persist. Used by discrete toggles (task done, block done, star)
  // that need the view to reflect the change. The realtime subscription reconciles later.
  const row = { id: key, key, value };
  DB.cachePut('item_state', row);
  mergeData(dbFromCache()); rerender();
  try { await DB.upsert('item_state', row); } catch {}
}
// Persist an item_state toggle WITHOUT re-rendering. For in-place UIs like the packing list, which
// update their own DOM (checkbox + progress bar); re-rendering the whole view under the pointer
// dropped rapid clicks and made the list feel impossible to complete.
async function persistState(key, value) {
  const row = { id: key, key, value };
  DB.cachePut('item_state', row);
  if (DATA && DATA._state) DATA._state[key] = value;   // keep in-memory state coherent, no re-render
  try { await DB.upsert('item_state', row); } catch {}
}
// After an optimistic write, rebuild DATA from the (now-updated) local cache and re-render immediately.
// The realtime subscription will reconcile with the server shortly after.
async function syncAfterWrite() {
  mergeData(dbFromCache());
  rerender();
}
function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}
function slug(s) {
  return (String(s || 'contact').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'contact')
    + '-' + Math.random().toString(36).slice(2, 6);
}

/* ---------- masthead (shared) ---------- */
function masthead() {
  const ev = DATA.event || {};
  const span = (ev.start && ev.end) ? shortDate(ev.start) + '–' + shortDate(ev.end) + ', ' + ev.start.slice(0, 4) : '';
  const b = (ev.badge || '').split('/').map(s => s.trim());
  const badge = b.length >= 4
    ? `<div class="badge-line">Badge <span class="sep">·</span> <b>${esc(b[0])}</b><span class="sep">/</span>${esc(b[1])}<span class="sep">/</span>${esc(b[2])}<span class="sep">/</span>${esc(b[3])}</div>`
    : '';
  return `<div class="mast">
    <div class="kicker">Circuit · trip brief</div>
    <div class="title">${esc(ev.name || 'Event')}<span>.</span></div>
    <p class="tagline">${esc(ev.tagline || '')}</p>
    <div class="mast-meta">${span ? '<strong>' + esc(span) + '</strong>' : ''}<span>${esc(ev.location || '')}</span></div>
    <div class="count"><span class="cd-k">Arrival in</span><span class="cd-v tnum" id="cd">···</span></div>
    ${badge}</div>`;
}
function tickCountdown() {
  const cd = $('#cd'); if (!cd) return;
  const arrive = new Date((DATA.event?.arrive || DATA.dayplan?.days?.[0]?.date) + 'T09:00:00');
  const ms = arrive - new Date();
  if (ms <= 0) { cd.innerHTML = 'On the ground <span>trip underway</span>'; return; }
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  cd.innerHTML = d + '<span>days</span> ' + h + '<span>hr</span> ' + m + '<span>min</span>';
}

/* ---------- Objectives (the trip's five goals, clearly named) ---------- */
// Number map, so the short tags used across the app tie back to a stated legend.
function objMapN() { const m = {}; (DATA.objectives || []).forEach((o, i) => m[o.id] = { ...o, n: i + 1 }); return m; }
function objectivesCard() {
  const objs = DATA.objectives || [];
  if (!objs.length) return '';
  return `<div class="objs"><div class="objs-k">Why you're here · your five objectives</div>
    ${objs.map((o, i) => `<div class="obj-row"><span class="obj-n">${i + 1}</span><div class="obj-l">${esc(o.label)}<span class="obj-s">${esc(o.short)}</span></div></div>`).join('')}
  </div>`;
}

/* ---------- Today (run of day) ---------- */
let curDay = null;
const KIND_LABEL = { session:'Session', travel:'Travel', meal:'Meal', coffee:'Coffee', network:'Network', flex:'Flex', evening:'Evening', admin:'Admin', dressup:'Dress up', paper:'Paper' };

// Task completion is an item_state overlay ('task:<id>') on top of the static task's default status,
// so a check persists and syncs without mutating the static source.
function taskDone(t) {
  const k = 'task:' + t.id;
  if (DATA._state && k in DATA._state) return !!DATA._state[k];
  return t.status === 'done';
}
// A checkable, tappable task row shared by Today and Prep.
function taskRowHtml(t) {
  const done = taskDone(t);
  return `<div class="h-row${done ? ' done' : ''}" data-task="${esc(t.id)}">
    <button class="h-check${done ? ' on' : ''}" data-tcheck="${esc(t.id)}" aria-label="toggle done"></button>
    <div class="h-tap" data-tedit="${esc(t.id)}">
      <div class="h-title">${esc(t.title)}</div>
      <div class="h-meta"><span class="h-pri ${t.priority === 'high' ? 'high' : 'med'}">${esc(t.priority || '')}</span>${t.kind ? ' · ' + esc(t.kind) : ''}${t.due ? ' · due ' + esc(t.due) : ''}</div>
    </div></div>`;
}
// Wire the shared task-row interactions within a container that has just been rendered.
function bindTaskRows() {
  document.querySelectorAll('[data-tcheck]').forEach(b => b.onclick = e => { e.stopPropagation(); toggleTask(b.dataset.tcheck); });
  document.querySelectorAll('[data-tedit]').forEach(b => b.onclick = () => sheetTask(b.dataset.tedit));
}

function viewToday() {
  const days = DATA.dayplan.days, tISO = todayISO();
  if (curDay == null) { const i = days.findIndex(d => d.date >= tISO); curDay = i < 0 ? 0 : i; }
  const d = days[curDay], meta = DATA.dayplan.meta || {};
  const isToday = d.date === tISO;

  // Reasoning layer: same-time clashes, A/B branches, can't-miss stars for this day.
  const an = (DATA.analysis && DATA.analysis.days && DATA.analysis.days[d.date]) || {};
  const cantMiss = (an.cant_miss || []).map(x => (x.title || '').toLowerCase().trim()).filter(Boolean);
  const isCantMiss = t => { const s = (t || '').toLowerCase().trim(); return !!s && cantMiss.some(cm => cm === s || cm.includes(s) || s.includes(cm)); };

  // Day chips
  // Only today-onward: the prep and arrival days are done, no need to navigate back to them.
  const sel = days.map((x, i) => x.date < tISO ? '' : `<button class="chip ${i === curDay ? 'on' : ''}" data-day="${i}">${esc(x.label.slice(0,3))}<span style="opacity:.6;margin-left:5px;font-weight:400">${shortDate(x.date)}</span></button>`).join('');

  // To-handle strip: open + doing tasks, high first; each is checkable and tappable.
  const open = (DATA.tasks || []).filter(t => !taskDone(t))
    .sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1) || (a.due || '').localeCompare(b.due || ''));
  const handle = `<div class="handle">
    <div class="h-head"><span class="h-k">To handle</span><span class="h-actions"><span class="h-c">${open.length} open</span></span></div>
    ${open.length ? open.map(t => taskRowHtml(t)).join('') : '<div class="h-empty">Nothing open.</div>'}
  </div>`;

  // NOW/NEXT
  let nowIdx = -1, nextIdx = -1;
  if (isToday) {
    const nm = nowMin();
    for (let i = 0; i < d.blocks.length; i++) {
      const s = toMin(d.blocks[i].s), e = toMin(d.blocks[i].e);
      if (s === null) continue;
      const end = e !== null ? e : s + 30;
      if (nm >= s && nm < end) { nowIdx = i; break; }
    }
    if (nowIdx === -1) { for (let j = 0; j < d.blocks.length; j++) { const sj = toMin(d.blocks[j].s); if (sj !== null && sj > nm) { nextIdx = j; break; } } }
  }
  let nowbar = '';
  if (isToday && (nowIdx >= 0 || nextIdx >= 0)) {
    const r = d.blocks[nowIdx >= 0 ? nowIdx : nextIdx];
    const lead = nowIdx >= 0 ? '<b>NOW</b>' : '<b>NEXT</b>';
    const tm = r.s ? r.s + (r.e ? ' to ' + r.e : '') + ' · ' : '';
    nowbar = `<div class="nowbar">${lead} ${esc(tm)}${esc(r.t)}${r.w ? ' · ' + esc(r.w) : ''}</div>`;
  }

  // Timeline: walk-time between rooms, tinted primary pick, tap a secondary to swap it in.
  let prevRoom = null, prevZone = null;
  const blocks = d.blocks.map((b, i) => {
    const k = b.k || 'session';
    const bkey = 'block:' + d.date + ':' + i;
    const bdone = !!(DATA._state && DATA._state[bkey]);
    const hasAlts = Array.isArray(b.alts) && b.alts.length;
    // pick override: option 0 = your default block, 1..n = its alts. Tapping a secondary swaps it in.
    const options = hasAlts ? [{ t: b.t, w: b.w, why: b.n, who: b.who }, ...b.alts] : null;
    const chosen = hasAlts ? (+(DATA._state && DATA._state['pick:' + d.date + ':' + i]) || 0) : 0;
    const P = hasAlts ? options[chosen] : {};
    const pTitle = hasAlts ? P.t : b.t, pRoom = hasAlts ? P.w : b.w, pNote = hasAlts ? P.why : b.n, pWho = hasAlts ? P.who : b.who;
    let extra = bdone ? ' done' : '', markAttr = '';
    if (i === nowIdx) { extra += ' is-now'; markAttr = ' data-mark="Now"'; }
    else if (i === nextIdx) { extra += ' is-next'; markAttr = ' data-mark="Next"'; }
    if (k === 'flex') extra += ' flex';
    if (k === 'dressup') extra += ' dressup';
    if (isCantMiss(pTitle)) extra += ' cant-miss';
    if (hasAlts) extra += ' has-alts';
    // walk time from the previous room-bearing block (uses the effective, possibly swapped, room)
    let trans = '';
    const zone = roomZone(pRoom);
    if (b.s && pRoom && prevRoom && pRoom !== prevRoom) {
      const mins = walkMin(prevZone, zone);
      if (mins >= 4) trans = `<div class="transit"><span class="tr-arrow">↳</span><span class="tr-min">~${mins} min walk</span><span class="tr-a">${esc(prevRoom)} → ${esc(pRoom)}</span></div>`;
    }
    if (b.s && pRoom) { prevRoom = pRoom; prevZone = zone; }
    const timeCol = !b.s
      ? '<div class="b-time floating">Floating</div>'
      : `<div class="b-time tnum">${esc(b.s)}${b.e ? '<span class="b-end">' + esc(b.e) + '</span>' : ''}</div>`;
    let body = '<div class="b-body">';
    body += `<div class="b-top"><span class="kchip ${k}">${esc(KIND_LABEL[k] || k)}</span>${hasAlts ? '<span class="pick-tag">' + (chosen ? 'Swapped' : 'Pick') + '</span>' : ''}<button class="b-check${bdone ? ' on' : ''}" data-bcheck="${esc(bkey)}" aria-label="mark done"></button></div>`;
    body += `<div class="b-title">${isCantMiss(pTitle) ? '<span class="cm-star">★</span> ' : ''}${esc(pTitle)}</div>`;
    if (pRoom) body += `<div class="b-where">${placeLink(pRoom)}</div>`;
    if (pWho) body += `<div class="b-who"><span class="who-lead">Catch</span>${esc(pWho)}</div>`;
    if (k === 'flex') body += '<span class="flex-flag">Protected, keep open</span>';
    if (k === 'dressup') body += '<span class="sharp-flag">Look sharp</span>';
    if (pNote) body += `<div class="b-note">${esc(pNote)}</div>`;
    if (hasAlts) {
      const others = options.map((o, oi) => ({ o, oi })).filter(x => x.oi !== chosen);
      body += `<div class="alts"><div class="alts-k">Tap to switch your pick</div>` +
        others.map(({ o, oi }) => `<div class="alt" data-pick="${d.date}|${i}|${oi}"><div class="alt-t">${esc(o.t)}${oi === 0 ? '<span class="alt-def">your default</span>' : ''}</div><div class="alt-m">${o.w ? placeLink(o.w) + ' · ' : ''}${esc(o.why || '')}</div></div>`).join('') + `</div>`;
    }
    body += '</div>';
    return trans + `<div class="block ${k}${extra}"${markAttr}>${timeCol}${body}</div>`;
  }).join('');

  // Tonight's marquee: marquee sessions on this day, evening kinds
  // Match by day-of-month from the session's day text ("Wednesday July 22" -> 22), NOT by weekday label
  // (a prep Wednesday and the conference Wednesday share a label). Prep days have no sessions, so empty.
  const dnum = +d.date.split('-')[2];
  const marquee = (DATA.sessions || []).filter(s => s.marquee && (s.kind === 'event' || s.kind === 'keynote')
      && s.day && parseInt((s.day.match(/\b(\d{1,2})\b/) || [])[1], 10) === dnum)
    .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  const marqueeHtml = marquee.length ? `<div class="marquee"><div class="m-k">Tonight's marquee</div>
    ${marquee.map(s => `<div class="m-row"><div class="m-time tnum">${esc(s.start || '')}${s.end ? ' to ' + esc(s.end) : ''}</div>
      <div class="m-title">${esc(s.title)}</div><div class="m-room">${placeLink(s.room)}</div></div>`).join('')}</div>` : '';

  // Same-time decisions: conflicts to know about + A/B branches to pick.
  const branches = an.branches || [], conflicts = an.conflicts || [];
  const decisionsHtml = (branches.length || conflicts.length) ? `<div class="decisions">
    ${conflicts.map(c => `<div class="conflict-row"><span class="conflict-flag">Clash ${esc(c.when || '')}</span><span class="cf-txt">${esc((c.blocks || []).join('  vs  '))}${c.reason ? ' — ' + esc(c.reason) : ''}</span></div>`).join('')}
    ${branches.map(b => `<div class="branch"><div class="br-h"><span class="br-k">Pick one</span><span class="br-t">${esc(b.at || '')}</span></div>
      ${(b.options || []).map(o => `<div class="br-opt${b.recommend && o.label === b.recommend ? ' pick' : ''}"><div class="br-lab">${esc(o.label || '')}</div>
        <div><div class="br-ot">${esc(o.title || '')}</div>${o.why ? `<div class="br-ow">${esc(o.why)}</div>` : ''}</div></div>`).join('')}
    </div>`).join('')}
  </div>` : '';

  render(masthead() +
    handle +
    objectivesCard() +
    `<div class="day-head"><div class="day-tag">${esc(d.tag || 'Run of day')}</div>
      <div class="day-name">${esc(d.label)}<span class="dn-date">${shortDate(d.date)}</span></div></div>
     <div class="chips" style="margin-top:12px">${sel}</div>
     ${nowbar}
     ${meta.energy ? `<div class="energy-note">${esc(meta.energy)}</div>` : ''}
     ${decisionsHtml}
     <div class="timeline">${blocks}</div>
     ${marqueeHtml}`);

  tickCountdown();
  bindTaskRows();
  document.querySelectorAll('[data-bcheck]').forEach(b => b.onclick = e => {
    e.stopPropagation(); const key = b.dataset.bcheck;
    saveState(key, !(DATA._state && DATA._state[key]));
  });
  // tap a secondary option to swap it in as your pick (map links inside still open)
  document.querySelectorAll('[data-pick]').forEach(el => el.onclick = e => {
    if (e.target.closest('a')) return;
    const [date, idx, opt] = el.dataset.pick.split('|');
    saveState('pick:' + date + ':' + idx, +opt);
  });
  document.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { curDay = +b.dataset.day; viewToday(); window.scrollTo(0, 0); });
}

/* ---------- Schedule ---------- */
let schFilter = { day: 'all', obj: 'all', star: false };
function viewSchedule() {
  const S = DATA.sessions, objs = DATA.objectives || [];
  const objMap = objMapN();
  const state = DATA._state || {};
  const starred = {}; Object.keys(state).forEach(k => { if (k.startsWith('star:') && state[k]) starred[k.slice(5)] = true; });

  // Experience Hall + Evenings (marquee)
  const marq = S.filter(s => s.marquee);
  const evenings = marq.filter(s => s.kind === 'event' || s.kind === 'keynote').sort((a, b) => (a.day || '').localeCompare(b.day || '') || (a.start || '').localeCompare(b.start || ''));
  const exhibits = marq.filter(s => s.kind === 'exhibit').sort((a, b) => (a.day || '').localeCompare(b.day || '') || (a.start || '').localeCompare(b.start || ''));
  const vrow = s => `<div class="vrow" data-sess="${esc(s.id)}"><div class="v-when tnum">${esc(dayShort(s.day))}<span class="v-time">${esc(s.start || '')}${s.end ? ' to ' + esc(s.end) : ''}</span></div>
    <div><div class="v-title">${esc(s.title)}</div><div class="v-meta"><span class="v-room">${placeLink(s.room)}</span>${s.type ? ' · ' + esc(s.type) : ''}</div></div></div>`;
  const hall = `<div class="sec"><div class="sec-label">Experience hall and evenings</div>
    <h2>The marquee nights and the exhibit floors</h2>
    <div class="venue-group"><div class="venue-h">Evenings</div>${evenings.map(vrow).join('') || '<div class="empty">None flagged.</div>'}</div>
    <div class="venue-group"><div class="venue-h">Exhibits</div>
      <div class="venue-note">SIGGRAPH 2026 has no separate VR Theater. The Immersive Pavilion and Experience Hall are where that content lives this year.</div>
      ${exhibits.map(vrow).join('') || '<div class="empty">None flagged.</div>'}</div></div>`;

  // Filters
  const dayOrder = ['Sunday July 19', 'Monday July 20', 'Tuesday July 21', 'Wednesday July 22', 'Thursday July 23'];
  const dayChips = ['all', ...dayOrder].map(x => `<button class="chip ${schFilter.day === x ? 'on' : ''}" data-f="day" data-v="${esc(x)}">${x === 'all' ? 'All days' : esc(x.split(' ')[0])}</button>`).join('');
  const objChips = objs.map((o, i) => `<button class="chip obj ${schFilter.obj === o.id ? 'on' : ''}" data-f="obj" data-v="${o.id}"><span class="obj-tag-n">${i + 1}</span>${esc(o.short)}</button>`).join('');
  const starChip = `<button class="chip ${schFilter.star ? 'on' : ''}" data-f="star" data-v="1">★ Starred</button>`;

  const dayKey = s => (s.day || 'TBD').match(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+\w+\s+\d+/) ? s.day.match(/^(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+\w+\s+\d+/)[0] : (s.day || 'TBD');
  // The main program excludes marquee items (they are featured above in Experience Hall),
  // so nothing shows twice.
  const prog = S.filter(s => !s.marquee);
  let list = prog.filter(s =>
    (schFilter.day === 'all' || dayKey(s) === schFilter.day) &&
    (schFilter.obj === 'all' || (s.objectives || []).includes(schFilter.obj)) &&
    (!schFilter.star || starred[s.id]));
  const byDay = {};
  list.forEach(s => { const k = dayKey(s); (byDay[k] = byDay[k] || []).push(s); });
  const orderedKeys = [...dayOrder.filter(k => byDay[k]), ...Object.keys(byDay).filter(k => !dayOrder.includes(k))];
  const program = orderedKeys.map(day =>
    `<div class="day"><div class="day-h">${esc(day)}</div>` +
    byDay[day].sort((a, b) => (a.start || '').localeCompare(b.start || '')).map(s => {
      const o = (s.objectives || [])[0] ? objMap[(s.objectives || [])[0]] : null;
      return `<div class="sess" data-sess="${esc(s.id)}"><div class="s-time">${esc(s.start || '')}</div>
        <div><div class="s-title">${starred[s.id] ? '<span class="star">★</span> ' : ''}${esc(s.title)}</div>
          <div class="s-meta"><span class="s-room">${placeLink(s.room)}</span>${s.type ? ' · ' + esc(s.type) : ''}${o ? '<span class="s-obj"><span class="obj-tag-n">' + o.n + '</span>' + esc(o.short) + '</span>' : ''}</div>
          ${s.relevance ? `<div class="s-rel">${esc(s.relevance)}</div>` : ''}</div></div>`;
    }).join('') + '</div>').join('') || '<div class="empty">Nothing matches these filters.</div>';

  render(masthead() + hall +
    `<div class="sec"><div class="sec-label">Program</div><h2>The full schedule</h2>
      <div class="sec-sub">${list.length} of ${prog.length} sessions</div>
      <div class="chips" style="margin-top:14px">${dayChips}</div>
      <div class="chips">${starChip}${objChips}</div>
      ${program}</div>`);

  tickCountdown();
  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
    const f = b.dataset.f;
    if (f === 'star') schFilter.star = !schFilter.star;
    else schFilter[f] = schFilter[f] === b.dataset.v ? 'all' : b.dataset.v;
    viewSchedule();
  });
  document.querySelectorAll('[data-sess]').forEach(r => r.onclick = () => { location.hash = '#/schedule/' + r.dataset.sess; });
}
function dayShort(day) {
  if (!day) return '';
  const m = day.match(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)/);
  return m ? m[1].slice(0, 3) : day.split(' ')[0];
}

/* ---------- People (the hunt) ---------- */
let ppFilter = { obj: 'all' };
// Met status is an item_state overlay ('met:<id>') on top of the contact's default status.
function metState(c) { const k = 'met:' + c.id; if (DATA._state && k in DATA._state) return !!DATA._state[k]; return c.status === 'met'; }
function viewPeople() {
  const C = DATA.contacts, objs = DATA.objectives || [];
  const objMap = objMapN();
  const objChips = objs.map((o, i) => `<button class="chip obj ${ppFilter.obj === o.id ? 'on' : ''}" data-f="obj" data-v="${o.id}"><span class="obj-tag-n">${i + 1}</span>${esc(o.short)}</button>`).join('');
  const total = C.length, caught = C.filter(metState).length, pct = total ? Math.round(caught / total * 100) : 0;
  const list = C.filter(c => ppFilter.obj === 'all' || (c.objectives || []).includes(ppFilter.obj))
    .slice().sort((a, b) => (metState(a) ? 1 : 0) - (metState(b) ? 1 : 0));  // targets first, caught sink
  const cards = list.map(c => {
    const met = metState(c);
    const chips = (c.objectives || []).map(oid => { const o = objMap[oid]; return o ? `<span class="c-chip"><span class="obj-tag-n">${o.n}</span>${esc(o.short)}</span>` : ''; }).join('');
    return `<div class="card${met ? ' caught' : ''}" data-p="${esc(c.id)}">
      <div class="c-top"><div class="c-name">${esc(c.name)}${c.verified ? ' <span class="c-ok" title="verified">✓</span>' : ''}${(c.links && c.links.length) ? ` <span class="c-link-n">${c.links.length}🔗</span>` : ''}</div><button class="catch-btn${met ? ' on' : ''}" data-met="${esc(c.id)}">${met ? '✓ Caught' : 'Mark met'}</button></div>
      <div class="c-role"><b>${esc(c.title || c.role || '')}</b>${c.company ? ' @ ' + esc(c.company) : ''}</div>
      ${chips ? `<div class="c-chips">${chips}</div>` : ''}
      ${c.opener ? `<div class="c-open">${esc(c.opener)}</div>` : ''}
      ${c.hook_confirmed === false && !met ? '<div class="c-warn">Hook unconfirmed · verify before leading with it.</div>' : ''}
      ${met ? `<button class="send-btn" data-send="${esc(c.id)}">Send them something fun ↗</button>` : ''}
    </div>`;
  }).join('') || '<div class="empty">No one here.</div>';

  render(masthead() +
    `<div class="sec"><div class="sec-label">The hunt</div><h2>People</h2>
      <div class="hunt">
        <div class="hunt-top"><div class="hunt-score tnum">${caught}<span> / ${total} caught</span></div><div class="hunt-pts tnum">${caught * 10} pts</div></div>
        <div class="hunt-bar"><i style="width:${pct}%"></i></div>
        <div class="hunt-sub">${caught === total && total ? 'Full house. You cornered everyone.' : (total - caught) + ' still in the wild. Tap Mark met the moment you shake their hand.'}</div>
      </div>
      <div class="chips" style="margin-top:14px">${objChips}</div>
      <div class="people">${cards}</div></div>`);

  tickCountdown();
  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { ppFilter.obj = ppFilter.obj === b.dataset.v ? 'all' : b.dataset.v; viewPeople(); });
  document.querySelectorAll('[data-p]').forEach(el => el.onclick = e => { if (e.target.closest('button')) return; sheetPerson(el.dataset.p); });
  document.querySelectorAll('[data-met]').forEach(b => b.onclick = e => { e.stopPropagation(); const c = DATA.contacts.find(x => x.id === b.dataset.met); if (c) saveState('met:' + c.id, !metState(c)); });
  document.querySelectorAll('[data-send]').forEach(b => b.onclick = async e => {
    e.stopPropagation(); const c = DATA.contacts.find(x => x.id === b.dataset.send); if (!c) return;
    b.disabled = true; b.textContent = 'Queued for the Agent';
    await saveRow('chat', { id: uuid(), role: 'user', body: `Draft a short, warm, personalized follow-up to ${c.name} (${c.role || ''}${c.company ? ' @ ' + c.company : ''}) that I can send after meeting them at SIGGRAPH. Tie it to ${(c.objectives || []).join(', ') || 'our work'}, make it feel like we do genuinely cool stuff, keep it human and specific, no AI-slop. Suggest one fun, personalized thing to send them.`, status: 'pending', created_at: new Date().toISOString() });
  });
}

/* ---------- Prep ---------- */
function viewPrep() {
  const L = DATA.logistics || {}, P = DATA.packing || { sections: [] }, briefs = DATA.briefs || [];
  const f = L.flights || {}, out = f.out || {}, back = f.back || {};
  const t = L.transport || {}, air = t.uber_airport || {}, lg = L.lodging || {}, ven = L.venue || {}, bg = L.badge || {}, sn = L.sundries || {};
  const state = DATA._state || {};
  // packing checks now live in item_state (key 'pack:<id>') so they sync across devices.
  const checks = {}; Object.keys(state).forEach(k => { if (k.startsWith('pack:')) checks[k.slice(5)] = state[k]; });

  // Flights: editorial route card, look restored from the flights.html decision page
  const fRow = ((DATA.budget || {}).rows || []).find(r => r.cat === 'Flights');
  const flights = `<div class="sec"><div class="sec-label">Flights</div>
    <div class="fl-route">YYZ <span class="arr">→</span> LAX</div>
    <div class="fl-meta">
      ${out.conf ? `<span>Conf <strong>${esc(out.conf)}</strong></span>` : ''}
      ${out.status ? `<span><strong>${esc(out.status)}</strong></span>` : ''}
      <span>Both legs <strong>Air Canada</strong></span>
    </div>
    <div class="flightsv">
      <div class="fv"><div class="fv-k">Out</div>
        <div class="fv-t">${esc(out.code || '')}</div>
        <div class="fv-d">${esc(out.dep || '')}<br>Lands ${esc(out.arr || '')}</div></div>
      <div class="fv"><div class="fv-k">Back</div>
        <div class="fv-t">${esc(back.code || '')}</div>
        <div class="fv-d">${esc(back.dep || '')}<br>Lands ${esc(back.arr || '')}</div></div>
    </div>
    ${fRow ? `<div class="fl-price tnum">$${fRow.line}<span> round trip · ${esc(fRow.payer)}${fRow.note ? ' · ' + esc(fRow.note) : ''}</span></div>` : ''}</div>`;

  // Lodging + transport + venue + badge (lodging + commute derive from the selected hotel)
  const sh = selectedHotel();
  const logi = `<div class="sec"><div class="sec-label">Lodging and transport</div><h2>Getting around, staying put</h2>
    <div class="logi">
      <div class="lo-cell"><div class="lo-k">Lodging</div>
        <div class="lo-v"><b>${esc(sh ? sh.name : (lg.place || ''))}</b>${sh && sh.address ? ', ' + esc(sh.address) : ''}<span class="lo-sub">${sh ? esc((sh.booked ? 'Booked. ' : '') + commuteStr(sh)) : esc(lg.note || '')}</span></div></div>
      <div class="lo-cell"><div class="lo-k">Airport rides</div>
        <div class="lo-v">In <b>${esc(air.in || '')}</b> · out <b>${esc(air.out || '')}</b><span class="lo-sub">Uber both airport legs.</span></div></div>
      <div class="lo-cell full"><div class="lo-k">Getting to the floor</div>
        <div class="lo-v">${sh ? esc(commuteStr(sh)) : esc(t.recommended || '')}</div></div>
      <div class="lo-cell full"><div class="lo-k">Venue</div>
        <div class="lo-v"><b>${esc(ven.name || '')}</b>${ven.addr ? ', ' + esc(ven.addr) : ''}<span class="lo-sub">${esc(ven.dates || '')}${ven.floor_hours ? ' · floor ' + esc(ven.floor_hours) : ''}</span></div></div>
    </div>
    <div class="badge-card">
      <div class="bc-name">${esc(bg.name || '')}</div>
      <div class="bc-line">${esc(bg.title || '')}${bg.org ? ' · ' + esc(bg.org) : ''}${bg.tier ? ' · ' + esc(bg.tier) : ''}</div>
      ${bg.risk ? `<div class="bc-risk">${esc(bg.risk)}</div>` : ''}
    </div></div>`;

  // Lodging options: tap a hotel to make it your base (plan + budget follow); links open booking.
  const lo = L.lodging_options;
  const selId = sh ? sh.id : '';
  const walkLabel = p => p.mode === 'walk' ? `${p.walk_min} min walk` : `${p.dist}, ride`;
  const lodgeOpts = (lo && (lo.picks || []).length) ? `<div class="sec"><div class="sec-label">Lodging</div><h2>Your base, tap to switch</h2>
    ${lo.note ? `<div class="sec-sub">${esc(lo.note)}</div>` : ''}
    <div class="hotels">
      ${lo.picks.map(p => `<div class="hotel${p.id === selId ? ' current' : (p.best ? ' best' : '')}" data-hotel="${esc(p.id)}">
        <div class="ht-top"><div class="ht-name">${esc(p.name)}${p.id === selId ? '<span class="ht-cur">Selected</span>' : (p.best ? '<span class="ht-pick">Best</span>' : '')}</div><div class="ht-walk">${esc(walkLabel(p))}</div></div>
        ${p.rate ? `<div class="ht-rate">${esc(p.rate)}</div>` : ''}
        <div class="ht-links"><a class="ht-link sv" href="https://www.google.com/maps/place/${encodeURIComponent((p.address || p.name) + ', Los Angeles')}" target="_blank" rel="noopener">Street View</a>${(p.links || []).map(k => `<a class="ht-link" href="${esc(k.u)}" target="_blank" rel="noopener">${esc(k.l)}</a>`).join('')}</div>
      </div>`).join('')}
    </div></div>` : '';

  // Sundries: errands near the hotel
  const cann = (sn.note || sn.near_hotel || sn.grocery) ? `<div class="sec"><div class="sec-label">Sundries</div><h2>Errands near the hotel</h2>
    <div class="cann">
      ${sn.near_hotel ? `<div class="cn-sub"><div class="cn-k">The dispensary run</div><div class="cn-v">${esc(sn.near_hotel)}</div></div>` : ''}
      ${sn.grocery ? `<div class="cn-sub" style="margin-top:12px"><div class="cn-k">Groceries</div><div class="cn-v">${esc(sn.grocery)}</div></div>` : ''}
      ${sn.note ? `<div class="cn-note" style="margin-top:12px">${esc(sn.note)}</div>` : ''}
    </div></div>` : '';

  // Packing with gamified progress bar
  const packIds = [];
  const packSecs = P.sections.map((sec, si) => {
    const items = (sec.items || []).map((it, ii) => {
      const id = 'p' + si + '_' + ii; packIds.push(id);
      return `<li><label><input type="checkbox" data-pk="${id}" ${checks[id] ? 'checked' : ''}>
        <span class="pt">${esc(it.t)}${it.q ? ' <span class="q">' + esc(it.q) + '</span>' : ''}${it.why ? '<span class="why">' + esc(it.why) + '</span>' : ''}</span>
        ${it.p ? '<span class="price">' + esc(it.p) + '</span>' : ''}</label></li>`;
    }).join('');
    return `<div class="psec"><h3 class="${sec.buy ? 'buy' : ''}">${esc(sec.h)}</h3>
      ${sec.note ? `<div class="note">${esc(sec.note)}</div>` : ''}<ul>${items}</ul></div>`;
  }).join('');
  const doneN = packIds.filter(id => checks[id]).length, totalN = packIds.length;
  const pct = totalN ? Math.round(doneN / totalN * 100) : 0;
  const packing = `<div class="sec"><div class="sec-label">Packing</div><h2>Backpack and one carry-on</h2>
    <div class="sec-sub">No checked bag. Ticks save on this device.</div>
    <div class="pack-prog" id="pack-prog">
      <div class="pp-top"><div class="pp-bar"><i id="pp-fill" style="width:${pct}%"></i></div>
        <b class="pp-count" id="pp-count">${doneN} / ${totalN} packed</b>
        <button class="pp-reset" id="pp-reset">reset</button></div>
      <div class="pp-done" id="pp-done" style="${doneN === totalN && totalN ? '' : 'display:none'}">All packed. You are ready.</div>
    </div>
    ${packSecs}</div>`;

  // Briefs (collapsible markdown) — only the prep-relevant ones; older context lives in Knowledge.
  const prepBriefs = briefs.filter(b => b.where !== 'knowledge');
  const briefsHtml = prepBriefs.length ? `<div class="sec"><div class="sec-label">Reference briefs</div><h2>The background reading</h2>
    ${prepBriefs.map((b) => `<details class="brief"><summary><span class="bs-t">${esc(b.title)}</span><span class="bs-i">+</span></summary>
      <div class="bs-body"><div class="md">${renderMd(b.md)}</div></div></details>`).join('')}</div>` : '';

  // Tasks (checkable + editable + add)
  const open = (DATA.tasks || []).filter(t => !taskDone(t))
    .sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1) || (a.due || '').localeCompare(b.due || ''));
  const doneTasks = (DATA.tasks || []).filter(t => taskDone(t));
  const tasksHtml = `<div class="sec"><h2>Before the floor opens</h2>
    <div class="sec-label" style="margin:8px 0 0">Tasks</div>
    <div class="handle" style="margin-top:10px">
      ${open.length ? open.map(t => taskRowHtml(t)).join('') : '<div class="h-empty">Nothing open.</div>'}
      ${doneTasks.map(t => taskRowHtml(t)).join('')}
    </div></div>`;

  // Venue map (grounded, real links)
  const SIGMAP = 'https://maps.goeshow.com/acm/siggraph/2026/floor_map';
  const venueHtml = `<div class="sec"><div class="sec-label">Venue map</div><h2>Where things are</h2>
    <div class="venue-map">
      <a class="btn primary" href="${SIGMAP}" target="_blank" rel="noopener">Open the SIGGRAPH interactive floor map</a>
      <a class="btn" href="https://maps.google.com/?q=Los+Angeles+Convention+Center+1201+S+Figueroa" target="_blank" rel="noopener">LACC on Google Maps</a>
    </div>
    <div class="sec-sub" style="margin:16px 0 2px">Two buildings joined by the Concourse. Zone orientation from the program:</div>
    <div class="zone"><span class="zn">West Hall A</span><span class="zd">Exhibition floor. fal, Luma, Runway, vendors. Tue to Thu.</span></div>
    <div class="zone"><span class="zn">Concourse Hall</span><span class="zd">Immersive Pavilion, Art Gallery, Emerging Tech, Spatial Storytelling.</span></div>
    <div class="zone"><span class="zn">Hall K</span><span class="zd">Keynotes, Real-Time Live, the animation screenings.</span></div>
    <div class="zone"><span class="zn">Petree</span><span class="zd">Production sessions, the Sphere Oz talk, Autodesk firesides.</span></div>
    <div class="zone"><span class="zn">400 / 500 rooms</span><span class="zd">Papers, courses, the NVIDIA 502A block, industry sessions.</span></div>
    <div class="sec-sub" style="margin-top:12px">Tap any room in the schedule to open the interactive map for the exact spot.</div></div>`;

  // ADHD helper order: what to DO first (tasks, packing), then the reference you reach for.
  render(masthead() + tasksHtml + lodgeOpts + flights + logi + packing + cann + venueHtml + briefsHtml);

  tickCountdown();
  bindTaskRows();

  // Tap a hotel to make it your base (plan + budget follow); links still open.
  document.querySelectorAll('[data-hotel]').forEach(el => el.onclick = e => {
    if (e.target.closest('a')) return;
    saveState('hotel', el.dataset.hotel);
  });

  // Packing interactions -> item_state (synced). Optimistic: flip the bar immediately, persist in the background.
  const localChecks = { ...checks };
  const recount = () => {
    const done = packIds.filter(id => localChecks[id]).length;
    $('#pp-fill').style.width = (totalN ? done / totalN * 100 : 0) + '%';
    $('#pp-count').textContent = done + ' / ' + totalN + ' packed';
    $('#pp-done').style.display = (done === totalN && totalN) ? '' : 'none';
  };
  document.querySelectorAll('[data-pk]').forEach(cb => cb.onchange = () => {
    localChecks[cb.dataset.pk] = cb.checked;
    recount();                                       // update the bar in place
    persistState('pack:' + cb.dataset.pk, cb.checked); // persist without rebuilding the view
  });
  $('#pp-reset').onclick = async () => {
    if (!confirm('Clear all ticks?')) return;
    for (const id of packIds) { if (localChecks[id]) { localChecks[id] = false; await DB.upsert('item_state', { id: 'pack:' + id, key: 'pack:' + id, value: false }); } }
    document.querySelectorAll('[data-pk]').forEach(cb => cb.checked = false);
    await syncAfterWrite();
  };
}

/* ---------- markdown (light) ---------- */
function renderMd(md) {
  const lines = String(md || '').split('\n');
  let html = '', inList = false, para = [];
  const flushPara = () => { if (para.length) { html += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } };
  const flushList = () => { if (inList) { html += '</ul>'; inList = false; } };
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, url) => `<a href="${url}" target="_blank" rel="noopener">${txt}</a>`)
    .replace(/(^|[\s(])((?:https?:\/\/)[^\s)]+)/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  for (let raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^###\s+/.test(line)) { flushPara(); flushList(); html += '<h3>' + inline(line.replace(/^###\s+/, '')) + '</h3>'; }
    else if (/^##\s+/.test(line)) { flushPara(); flushList(); html += '<h2>' + inline(line.replace(/^##\s+/, '')) + '</h2>'; }
    else if (/^#\s+/.test(line)) { flushPara(); flushList(); html += '<h2>' + inline(line.replace(/^#\s+/, '')) + '</h2>'; }
    else if (/^\s*[-*]\s+/.test(line)) { flushPara(); if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; }
    else if (line.trim() === '') { flushPara(); flushList(); }
    else { flushList(); para.push(line.trim()); }
  }
  flushPara(); flushList();
  return html;
}

/* ---------- sheet (the one modal) ---------- */
let sheetState = { kind: null, id: null };
function openSheet(h, keepScroll) {
  const sc = $('#sheetc');
  const prev = keepScroll ? sc.scrollTop : 0;
  sc.innerHTML = h; $('#scrim').classList.add('on'); $('#sheet').classList.add('on');
  if (keepScroll) sc.scrollTop = prev;
}
function closeSheet() { sheetState = { kind: null, id: null }; $('#scrim').classList.remove('on'); $('#sheet').classList.remove('on'); }
function isStarred(id) { return !!(DATA._state && DATA._state['star:' + id]); }
function sheetSession(id, keep) {
  const s = DATA.sessions.find(x => x.id === id); if (!s) return;
  sheetState = { kind: 'session', id };
  const objMap = objMapN();
  const starred = isStarred(id);
  const chips = (s.objectives || []).map(oid => { const o = objMap[oid]; return o ? `<span class="sh-chip"><span class="obj-tag-n">${o.n}</span>${esc(o.short)}</span>` : ''; }).join('');
  openSheet(`<div class="sh-kicker">${esc(s.type || 'Session')}</div>
    <h3>${esc(s.title)}</h3>
    <div class="meta">${esc(s.day || '')}${s.start ? ' · ' + esc(s.start) + (s.end ? ' to ' + esc(s.end) : '') : ''}${s.room ? ' · ' + placeLink(s.room) : ''}</div>
    ${chips ? `<div class="sh-chips">${chips}</div>` : ''}
    ${s.speakers ? `<div class="lbl">Speakers</div><div class="val">${esc(s.speakers)}</div>` : ''}
    ${s.relevance ? `<div class="lbl">Why this one</div><div class="val">${esc(s.relevance)}</div>` : ''}
    ${s.tier ? `<div class="lbl">Badge</div><div class="val">${esc(s.tier)}</div>` : ''}
    <div><button class="btn primary" id="star">${starred ? '★ Starred' : '☆ Star this'}</button>
    ${s.url ? `<a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener">Program page</a>` : ''}</div>`, keep);
  $('#star').onclick = () => saveState('star:' + id, !isStarred(id));
}

/* ---------- People: read-only contact detail (editing is the Agent's job) ---------- */
function sheetPerson(id, keep) {
  const c = (DATA.contacts || []).find(x => x.id === id);
  if (!c) return;
  sheetState = { kind: 'person', id };
  const objMap = objMapN();
  const chips = (c.objectives || []).map(oid => { const o = objMap[oid]; return o ? `<span class="sh-chip"><span class="obj-tag-n">${o.n}</span>${esc(o.short)}</span>` : ''; }).join('');
  const links = (c.links || []).map(l => `<a class="sh-link" href="${esc(l.u)}" target="_blank" rel="noopener">${esc(l.l || 'Link')} ↗</a>`).join('');
  openSheet(`<div class="sh-kicker">${c.verified ? 'Verified · ' : ''}${c.hook_confirmed ? 'Hook confirmed' : (c.status ? esc(c.status) : 'Contact')}</div>
    <h3>${esc(c.name)}${c.verified ? ' <span class="sh-ok">✓</span>' : ''}</h3>
    <div class="meta">${esc(c.title || c.role || '')}${c.company ? ' · ' + esc(c.company) : ''}</div>
    ${c.email ? `<div class="sh-email"><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ''}
    ${links ? `<div class="sh-links">${links}</div>` : ''}
    ${chips ? `<div class="sh-chips">${chips}</div>` : ''}
    ${c.bio ? `<div class="lbl">Who they are</div><div class="val">${esc(c.bio)}</div>` : ''}
    ${c.synergy ? `<div class="lbl">The angle</div><div class="val">${esc(c.synergy)}</div>` : ''}
    ${c.followup ? `<div class="lbl">Follow up</div><div class="val">${esc(c.followup)}</div>` : ''}
    ${c.source ? `<div class="lbl">Where you met</div><div class="val">${esc(c.source)}</div>` : ''}
    ${c.opener ? `<div class="lbl">Talking point</div><div class="val">${esc(c.opener)}</div>` : ''}
    ${c.notes ? `<div class="lbl">Notes</div><div class="val">${esc(c.notes)}</div>` : ''}
    ${c.enrich_notes ? `<div class="lbl">To confirm</div><div class="val">${esc(c.enrich_notes)}</div>` : ''}
    ${c.hook_confirmed === false ? '<div class="warn">Hook unconfirmed, verify before leading with it.</div>' : ''}
    <div class="sh-hint">Need this changed? Tell the Agent.</div>`, keep);
}

/* ---------- Tasks: read-only detail + a done toggle (adds/edits are the Agent's job) ---------- */
function sheetTask(id, keep) {
  const t = (DATA.tasks || []).find(x => x.id === id);
  if (!t) return;
  sheetState = { kind: 'task', id };
  const done = taskDone(t);
  openSheet(`<div class="sh-kicker">Task${done ? ' · done' : ''}</div>
    <h3>${esc(t.title)}</h3>
    <div class="meta">${t.priority ? esc(t.priority) + ' priority' : ''}${t.kind ? ' · ' + esc(t.kind) : ''}${t.due ? ' · due ' + esc(t.due) : ''}</div>
    ${(t.note || t.n) ? `<div class="lbl">Detail</div><div class="val">${esc(t.note || t.n)}</div>` : ''}
    <div><button class="btn primary" id="t-toggle">${done ? 'Mark not done' : 'Mark done'}</button></div>
    <div class="sh-hint">Need to add or change a task? Tell the Agent.</div>`, keep);
  $('#t-toggle').onclick = async () => { await toggleTask(id); closeSheet(); };
}
async function toggleTask(id) {
  const t = (DATA.tasks || []).find(x => x.id === id); if (!t) return;
  await saveState('task:' + id, !taskDone(t));
}

/* ---------- Money (the financial model, its own module) ---------- */
function viewMoney() {
  const B = DATA.budget || {};
  const cur = esc(B.currency || 'CAD');
  const rows = B.rows || [];
  const total = B.total || 0, yours = B.your_cost || 0, covered = B.covered || 0;
  const money = n => '$' + Math.round(n || 0).toLocaleString('en-US');
  const pct = n => total ? Math.round((n / total) * 100) : 0;

  // your spend, split paid vs still-to-spend + grouped by category
  const mine = rows.filter(r => r.payer === 'Sean');
  const myPaid = mine.filter(r => r.actual).reduce((s, r) => s + r.line, 0);
  const myEst = Math.max(0, yours - myPaid);
  const myCat = {};
  mine.forEach(r => { const c = myCat[r.cat] || (myCat[r.cat] = { cat: r.cat, total: 0, paid: 0, notes: [] }); c.total += r.line; if (r.actual) c.paid += r.line; if (r.note) c.notes.push(r.note); });
  const myCats = Object.values(myCat).sort((a, b) => b.total - a.total);
  const myMax = Math.max(1, ...myCats.map(c => c.total));

  // who covers the trip
  const payers = (B.by_payer || []).slice().sort((a, b) => b.total - a.total);
  const payMax = Math.max(1, ...payers.map(p => p.total));
  const PAYNOTE = { Don: 'flights + hotel, paid', Sean: 'your spend', Rudy: 'one lunch, paid', 'Dark Half': 'conference pass' };

  // cash in pocket, pulled from the Cash line note
  const cashRow = rows.find(r => r.cat === 'Cash');
  const cashM = cashRow && /(\$?\d+)\s*USD/i.exec(cashRow.note || '');
  const cashLine = cashM ? `${cashM[1].replace(/^\$?/, '$')} USD in your pocket (${money(cashRow.line)} ${cur})` : '';

  const payerBars = payers.filter(p => p.total > 0 || p.payer !== 'Dark Half').map(p =>
    `<div class="mrow"><div class="ml">${esc(p.payer)}<span class="msub">${esc(PAYNOTE[p.payer] || '')}</span></div>
     <div class="mbar"><i style="width:${Math.max(2, (p.total / payMax) * 100)}%;${p.payer === 'Sean' ? 'background:var(--red)' : ''}"></i></div>
     <div class="mv">${money(p.total)}</div></div>`).join('');

  const catBars = myCats.map(c => {
    const done = c.paid >= c.total - 0.5;
    return `<div class="mrow"><div class="ml">${esc(c.cat)}<span class="msub">${done ? 'paid' : 'estimate'}</span></div>
     <div class="mbar"><i style="width:${Math.max(2, (c.total / myMax) * 100)}%;${done ? '' : 'background:var(--faint)'}"></i></div>
     <div class="mv">${money(c.total)}</div></div>`;
  }).join('');

  const body = `<div class="sec headview"><h2>What the trip costs</h2>
    <div class="sec-label" style="margin:8px 0 0">Your money, and who covers the rest</div>

    <div class="mhero">
      <div class="mhero-k">Your out of pocket</div>
      <div class="mhero-v tnum">${money(yours)}<span> ${cur}</span></div>
      <div class="mhero-sub">Total trip ${money(total)}. Others cover ${money(covered)}, or ${pct(covered)}% of it.</div>
    </div>

    <div class="msplit">
      <div class="you" style="flex:${yours || 1}"><b>You</b> ${pct(yours)}%</div>
      <div class="cov" style="flex:${covered || 1}"><b>Covered</b> ${pct(covered)}%</div>
    </div>

    <div class="sec-label mgap">Who's covering it</div>
    ${payerBars}

    <div class="sec-label mgap">Your ${money(yours)}, broken down</div>
    <div class="mpr">
      <div class="p" style="flex:${myPaid || 0.01}">Spent ${money(myPaid)}</div>
      <div class="r" style="flex:${myEst || 0.01}">Still to spend ${money(myEst)}</div>
    </div>
    ${cashLine ? `<div class="mcash">${esc(cashLine)}</div>` : ''}
    ${catBars}

    <details class="brief mgap"><summary><span class="bs-t">Every line item</span><span class="bs-i">+</span></summary><div class="bs-body">
      ${rows.map(r => `<div class="bud-row"><div class="br-l">${esc(r.label)}<span class="br-m">${esc(r.cat)} · ${esc(r.payer)}${r.qty > 1 ? ' · x' + r.qty : ''} · ${r.actual ? 'paid' : 'est'}${r.note ? ' · ' + esc(r.note) : ''}</span></div><div class="br-amt tnum">${money(r.line)}</div></div>`).join('')}
    </div></details>
    <div class="sec-sub" style="margin-top:12px">Paid = booked and settled. Estimate = a grounded guess, not spent yet. All in ${cur}. To change a number, tell the Agent.</div></div>`;
  render(body);
  tickCountdown();
}

/* ---------- Knowledge (capture inbox + what the reasoning flagged) ---------- */
function capWhen(iso) {
  if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function viewKnowledge() {
  const caps = (DATA.captures || []).slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  const list = caps.length ? caps.map(c => `<div class="cap-item"><div><div class="ci-body">${esc(c.body)}</div>
      <div class="ci-meta">${(c.tags || []).map(t => `<span class="ci-tag">${esc(t)}</span>`).join('')}${esc(capWhen(c.created_at))}</div></div>
      <button class="ci-del" data-capdel="${esc(c.id)}" aria-label="delete">×</button></div>`).join('')
    : '<div class="empty">Nothing captured yet. Jot the thing before it evaporates.</div>';

  // Reasoning: the high-value sessions the schedule analysis flagged that your plan does not include.
  const days = (DATA.analysis && DATA.analysis.days) || {};
  const missing = [];
  Object.keys(days).forEach(dt => (days[dt].missing_cant_miss || []).forEach(m => missing.push({ ...m, date: dt })));
  const reasoning = missing.length ? `<details class="brief"><summary><span class="bs-t">What the reasoning flagged (${missing.length})</span><span class="bs-i">+</span></summary><div class="bs-body">
      <div class="sec-sub" style="margin-bottom:10px">High-value sessions the analysis found that your day plan does not include yet. Same-time clashes and A/B picks live in Today.</div>
      ${missing.map(m => `<div class="reason-row"><div class="rr-when tnum">${esc(shortDate(m.date))}${m.time ? ' · ' + esc(m.time) : ''}</div><div><div class="rr-t">${esc(m.title)}</div>${m.why ? `<div class="rr-w">${esc(m.why)}</div>` : ''}</div></div>`).join('')}
    </div></details>` : '';

  // Context: older reference (prior SIGGRAPH notes) lives here, not in Prep.
  const kBriefs = (DATA.briefs || []).filter(b => b.where === 'knowledge');
  const context = kBriefs.map(b => `<details class="brief"><summary><span class="bs-t">${esc(b.title)}</span><span class="bs-i">+</span></summary>
      <div class="bs-body"><div class="md">${renderMd(b.md)}</div></div></details>`).join('');

  // Research & reasoning: deep-researched threads + items distilled from your captures.
  const K = DATA.knowledge || { threads: [], items: [] };
  const LANE_LABEL = { 'spatial-3d-gen': 'Spatial & 3D', 'gen-video-humans': 'Gen video · humans',
    'series-episodic-pipelines': 'Series & episodic', 'agent-pipelines-workflows': 'Agent pipelines', 'other': 'Floor' };
  // Flag a research item as relevant → floats it up, filters to it, and queues it for deeper synthesis.
  const kflag = id => !!(DATA._state && DATA._state['kflag:' + id]);
  const p = t => t ? `<p>${esc(t).replace(/\n+/g, '</p><p>')}</p>` : '';
  const sect = (label, body) => body ? `<div class="kw-sec"><div class="kw-h">${label}</div><div class="kw-b">${body}</div></div>` : '';
  const termsHtml = ts => (ts && ts.length) ? `<div class="kw-terms">${ts.map(t =>
      `<div class="kw-term"><span class="kw-ts" data-itex="${esc(t.sym)}"></span><span class="kw-td">${esc(t.def)}</span></div>`).join('')}</div>` : '';
  const mathHtml = m => (m && m.length) ? `<div class="kw-sec"><div class="kw-h">The math, in plain terms</div>${m.map(x =>
      `<div class="kw-m"><div class="kw-mn">${esc(x.name)}</div>${x.latex ? `<div class="kw-eq" data-tex="${esc(x.latex)}"></div>` : ''}${termsHtml(x.terms)}<div class="kw-mp">${esc(x.plain)}</div></div>`).join('')}</div>` : '';
  const linksHtml = ls => (ls && ls.length) ? `<div class="kw-links">${ls.map(l =>
      `<a class="kw-link" href="${esc(l.u)}" target="_blank" rel="noopener">${esc(l.l)} ↗</a>`).join('')}</div>` : '';
  // one card renderer for both curated (innovation/gap/angle) and deep (problem/method/math/…) items
  const kw = it => {
    const gist = it.one_liner || it.innovation || it.key_claim || '';
    const conf = it.match_confidence ? `<span class="kw-conf c-${esc(it.match_confidence)}">${esc(it.match_confidence)}</span>` : '';
    const angle = it.sean_objective || it.sean_angle;
    const slidesHtml = (it.slides && it.slides.length)
      ? `<div class="kw-sec"><div class="kw-h">Slides you shot, cleaned up · ${it.slides.length}</div><div class="kw-slides">${it.slides.map(s => `<figure class="kw-slide"><img loading="lazy" src="${esc(s.img)}" alt="${esc(s.caption || '')}"><figcaption>${esc(s.caption || '')}</figcaption></figure>`).join('')}</div></div>`
      : '';
    const body =
      slidesHtml +
      (it.eli ? `<div class="kw-eli">${p(it.eli)}</div>` : '') +
      sect('The problem', p(it.problem)) +
      sect('How it works', p(it.method)) +
      mathHtml(it.the_math) +
      sect("What's new", p(it.whats_new)) +
      sect('How it encodes geometry', p(it.representation)) +
      sect('Results', p(it.results)) +
      (it.chart ? `<div class="kw-sec kw-chart"><div class="kw-chart-svg">${it.chart.svg}</div>${it.chart.caption ? `<div class="kw-chart-cap">${esc(it.chart.caption)}</div>` : ''}</div>` : '') +
      ((it.clips && it.clips.length) ? `<div class="kw-sec"><div class="kw-h">Clip${it.clips.length > 1 ? 's' : ''} you filmed</div>${it.clips.map(c =>
        `<div class="kw-clip">${esc(c.motion_description || c.key_claim || c.title || '')}${c.file ? ` <span class="kw-clip-f">${esc(c.file)}</span>` : ''}</div>`).join('')}</div>` : '') +
      (angle ? `<div class="kw-sec angle"><div class="kw-h">Your angle · Dark Half</div><div class="kw-b">${p(angle)}</div></div>` : '') +
      linksHtml(it.links) +
      (it.unresolved ? `<div class="kw-unres">Open: ${esc(it.unresolved)}</div>` : '');
    const blob = (it.title + ' ' + (it.authors || '') + ' ' + gist + ' ' + (it.eli || '')).toLowerCase();
    const fl = kflag(it.id);
    const rd = it.relevance ? `<span class="kw-rel r${it.relevance}" title="relevance ${it.relevance} of 3 to your objectives"></span>` : '';
    return `<details class="kw-card${fl ? ' flagged' : ''}" data-lane="${esc(it.lane || 'other')}" data-rel="${it.relevance || 0}" data-flagged="${fl ? 1 : 0}" data-search="${esc(blob)}"><summary>
        <div class="kw-ct">${rd}<span class="kw-t">${esc(it.title)}</span>${conf}<button class="kw-flag${fl ? ' on' : ''}" data-flag="${esc(it.id || '')}" aria-label="flag relevant">${fl ? '★' : '☆'}</button></div>
        ${it.authors ? `<div class="kw-by">${esc(it.authors)}</div>` : ''}
        ${gist ? `<div class="kw-gist">${esc(gist)}</div>` : ''}
      </summary><div class="kw-body">${body || '<p class="kw-thin">No detail yet.</p>'}</div></details>`;
  };
  // Triage sort: flagged first, then by relevance-to-Sean's-objectives (3=core … 0). Nothing dropped.
  const sortTriage = items => [...(items || [])].sort((a, b) =>
    ((kflag(b.id) ? 1 : 0) - (kflag(a.id) ? 1 : 0)) || ((b.relevance || 0) - (a.relevance || 0)));
  const threadsHtml = (K.threads || []).map(th => `<div class="kw-thread">
      <div class="kw-th-h"><span class="kw-th-t">${esc(th.title)}</span>${th.tag ? `<span class="kw-th-tag">${esc(th.tag)}</span>` : ''}</div>
      ${th.synthesis ? `<div class="kw-syn">${esc(th.synthesis)}</div>` : ''}
      <div class="kw-cards">${sortTriage(th.items).map(kw).join('')}</div></div>`).join('');
  const capItemsHtml = (K.items || []).length ? `<div class="kw-thread"><div class="kw-th-h"><span class="kw-th-t">From your captures</span></div><div class="kw-cards">${(K.items || []).map(kw).join('')}</div></div>` : '';
  const introHtml = K.intro ? `<div class="kw-intro">${esc(K.intro)}</div>` : '';
  // Filter/search bar: makes 40+ items navigable. Chips per lane (with counts) + free-text + can't-miss.
  const allItems = (K.threads || []).flatMap(t => t.items || []).concat(K.items || []);
  const laneCounts = {};
  allItems.forEach(it => { const l = it.lane || 'other'; laneCounts[l] = (laneCounts[l] || 0) + 1; });
  const LANE_ORDER = ['spatial-3d-gen', 'gen-video-humans', 'series-episodic-pipelines', 'agent-pipelines-workflows', 'other'];
  const chips = [`<button class="kw-chip on" data-lane="all">All · ${allItems.length}</button>`]
    .concat(LANE_ORDER.filter(l => laneCounts[l]).map(l => `<button class="kw-chip" data-lane="${l}">${LANE_LABEL[l]} · ${laneCounts[l]}</button>`));
  const cantMiss = allItems.filter(it => (it.relevance || 0) >= 3).length;
  if (cantMiss) chips.push(`<button class="kw-chip cm" data-lane="cantmiss">★ Can’t-miss · ${cantMiss}</button>`);
  const flaggedN = allItems.filter(it => kflag(it.id)).length;
  chips.push(`<button class="kw-chip flag" data-lane="flagged">⚑ Flagged · ${flaggedN}</button>`);
  const filterBar = allItems.length > 6 ? `<div class="kw-filter" id="kw-filter">
      <input id="kw-search" type="search" placeholder="Search papers, authors, ideas…" autocapitalize="off" spellcheck="false">
      <div class="kw-chips-row">${chips.join('')}</div></div>` : '';
  const researchHtml = (threadsHtml || capItemsHtml) ? `<div class="ksec"><div class="sec-label">Research &amp; reasoning</div>${introHtml}${filterBar}${threadsHtml}${capItemsHtml}</div>` : '';

  render(
    `<div class="sec headview"><div class="sec-label">Knowledge</div><h2>Knowledge &amp; reasoning</h2>
      <div class="sec-sub">A name, a link, a thing you saw on the floor. Drop it now, triage later. Syncs across devices.</div>
      <div class="cap-compose">
        <textarea id="cap-txt" placeholder="What do you want to remember?"></textarea>
        <div class="cap-bar">
          <button class="cap-mic" id="cap-mic" aria-label="dictate"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/></svg></button>
          <div class="cap-hint">Tap the mic to dictate, or type.</div>
          <button class="btn primary cap-save" id="cap-save">Save</button>
        </div>
      </div>
      ${researchHtml}
      ${reasoning}
      ${context}
      ${list}</div>`);
  tickCountdown();
  // Typeset equations with KaTeX. Display for the equation block, inline for each defined symbol.
  // Falls back to raw LaTeX if KaTeX isn't loaded/cached.
  document.querySelectorAll('.kw-eq[data-tex]').forEach(el => {
    if (window.katex) {
      try { katex.render(el.dataset.tex, el, { throwOnError: false, displayMode: true }); }
      catch (e) { el.textContent = el.dataset.tex; }
    } else { el.textContent = el.dataset.tex; }
  });
  document.querySelectorAll('.kw-ts[data-itex]').forEach(el => {
    if (window.katex) {
      try { katex.render(el.dataset.itex, el, { throwOnError: false, displayMode: false }); }
      catch (e) { el.textContent = el.dataset.itex; }
    } else { el.textContent = el.dataset.itex; }
  });
  $('#cap-mic').onclick = () => dictate($('#cap-txt'), $('#cap-mic'));
  $('#cap-save').onclick = async () => {
    const body = ($('#cap-txt').value || '').trim(); if (!body) return;
    $('#cap-save').disabled = true;
    await saveRow('captures', { id: uuid(), body, tags: ['note'], status: 'inbox', created_at: new Date().toISOString() });
  };
  // Knowledge filter: lane chips + free-text search; hides empty threads as you narrow.
  const kwBar = document.getElementById('kw-filter');
  if (kwBar) {
    let lane = 'all', q = '';
    const cards = [...document.querySelectorAll('.kw-card')];
    const threads = [...document.querySelectorAll('.kw-thread')];
    const apply = () => {
      cards.forEach(c => {
        const okLane = lane === 'all' || (lane === 'cantmiss' ? (+c.dataset.rel >= 3)
          : lane === 'flagged' ? (c.dataset.flagged === '1') : c.dataset.lane === lane);
        const okQ = !q || (c.dataset.search || '').includes(q);
        c.style.display = (okLane && okQ) ? '' : 'none';
      });
      threads.forEach(t => {
        t.style.display = [...t.querySelectorAll('.kw-card')].some(c => c.style.display !== 'none') ? '' : 'none';
      });
    };
    kwBar.querySelectorAll('.kw-chip').forEach(ch => ch.onclick = () => {
      lane = ch.dataset.lane;
      kwBar.querySelectorAll('.kw-chip').forEach(x => x.classList.toggle('on', x === ch));
      apply();
    });
    const si = document.getElementById('kw-search');
    if (si) si.oninput = () => { q = si.value.trim().toLowerCase(); apply(); };
  }
  // Flag a research item as relevant (persists + syncs; floats it up; feeds deeper synthesis).
  document.querySelectorAll('.kw-flag').forEach(b => b.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    const id = b.dataset.flag; if (!id) return;
    saveState('kflag:' + id, !kflag(id));
  });
  document.querySelectorAll('[data-capdel]').forEach(b => b.onclick = async () => { if (!confirm('Delete this capture?')) return; await deleteRow('captures', b.dataset.capdel); });
}

/* ---------- Agent (a real chat: you talk, it changes the plan, it reports back) ---------- */
function viewAgent() {
  const chat = DATA.chat || []; // sorted ascending in mergeData
  const last = chat[chat.length - 1];
  const waiting = last && last.role === 'user';
  const bubbles = chat.length ? chat.map(m => {
    const who = m.role === 'agent' ? 'agent' : 'user';
    const changes = (m.meta && m.meta.changes) || m.changes;
    const chHtml = Array.isArray(changes) && changes.length
      ? `<div class="cbub-changes"><div class="cc-k">Changes made</div>${changes.map(c => `<div class="cc-row">${esc(typeof c === 'string' ? c : (c.summary || JSON.stringify(c)))}</div>`).join('')}</div>` : '';
    return `<div class="cbub ${who}"><div class="cb-body">${esc(m.body)}</div>${chHtml}<div class="cb-when">${esc(capWhen(m.created_at))}</div></div>`;
  }).join('') : `<div class="chat-empty">Talk to Circuit like you talk to me. Ask it to move a session, add a contact, adjust the budget, rework the plan. It makes the change and tells you what it did.</div>`;

  render(
    `<div class="sec headview agent-view"><div class="sec-label">Agent</div><h2>Talk to Circuit</h2>
      <div class="chat" id="chat">${bubbles}${waiting ? '<div class="chat-working">Queued. The agent runs when the laptop is on, then replies here.</div>' : ''}</div>
    </div>
    <div class="chat-dock">
      <button class="chat-mic" id="chat-mic" aria-label="dictate"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/></svg></button>
      <textarea class="chat-in" id="chat-in" rows="1" placeholder="Ask Circuit to change something…"></textarea>
      <button class="chat-send" id="chat-send" aria-label="send"><svg viewBox="0 0 24 24"><path d="M12 20V6M6 12l6-6 6 6"/></svg></button>
    </div>`);
  tickCountdown();
  const box = $('#chat'); if (box) box.scrollTop = box.scrollHeight;
  const inp = $('#chat-in'), mic = $('#chat-mic');
  mic.onclick = () => dictate(inp, mic);
  const send = async () => {
    const body = (inp.value || '').trim(); if (!body) return;
    inp.value = '';
    await saveRow('chat', { id: uuid(), role: 'user', body, status: 'pending', created_at: new Date().toISOString() });
  };
  $('#chat-send').onclick = send;
  inp.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
}

/* ---------- shared: in-browser dictation (Web Speech) ---------- */
let _rec = null;
function dictate(targetEl, btnEl, onStop, onStart) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('Voice input is not supported in this browser. Type it instead.'); return; }
  if (_rec) { _rec.stop(); return; }
  const r = new SR(); _rec = r; r.lang = 'en-US'; r.interimResults = true; r.continuous = true;
  const base = targetEl.value ? targetEl.value + ' ' : '';
  btnEl.classList.add('recording'); if (onStart) onStart();
  r.onresult = e => { let txt = ''; for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript; targetEl.value = base + txt; };
  r.onend = () => { btnEl.classList.remove('recording'); _rec = null; if (onStop) onStop(); };
  r.onerror = () => { btnEl.classList.remove('recording'); _rec = null; if (onStop) onStop(); };
  try { r.start(); } catch (e) {}
}

/* ---------- FAB: quick chooser for Agent / Knowledge (mobile) ---------- */
function openFabMenu() {
  openSheet(`<div class="sh-kicker">Quick</div><h3>Drop it in</h3>
    <div class="fab-menu">
      <button class="btn primary" id="fm-ask">Talk to the Agent</button>
      <button class="btn" id="fm-cap">Capture a thought</button>
    </div>
    <div class="sec-sub" style="margin-top:16px">The Agent changes the plan. Knowledge just remembers it.</div>`);
  $('#fm-ask').onclick = () => { closeSheet(); location.hash = '#/agent'; };
  $('#fm-cap').onclick = () => { closeSheet(); location.hash = '#/knowledge'; };
}

boot();
})();
