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
  DATA = d;
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

  $('#gate').classList.remove('hide');
  const emailEl = $('#email'), pwEl = $('#pw');
  emailEl.value = store.get('email') || '';

  const signIn = async () => {
    $('#gerr').textContent = '';
    const email = (emailEl.value || '').trim();
    const pw = pwEl.value || '';
    if (!email || !pw) { $('#gerr').textContent = 'Enter your email and password.'; return; }
    $('#unlock').disabled = true; $('#unlock').textContent = 'Signing in…';
    try {
      // (a) authenticate Supabase, (b) decrypt the static bundle with the SAME password.
      const ref = await decrypt(pw);            // throws on wrong password
      const { error } = await DB.auth.signIn(email, pw);
      if (error) throw new Error(error.message || 'auth');
      REF = ref;
      store.set('email', email);
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

  // Auto-resume: a persisted Supabase session means we only need the password to decrypt.
  const sess = DB.ready ? await DB.auth.session() : null;
  if (sess && store.get('email')) {
    // Session is live but the reference cipher still needs the password each cold start.
    emailEl.value = store.get('email'); pwEl.focus();
  } else {
    (emailEl.value ? pwEl : emailEl).focus();
  }
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
  const row = { id: key, key, value };
  DB.cachePut('item_state', row);          // optimistic check/star, renders instantly
  mergeData(dbFromCache()); rerender();
  await DB.upsert('item_state', row);
  await syncAfterWrite();
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

/* ---------- Today (run of day) ---------- */
let curDay = null;
const KIND_LABEL = { session:'Session', travel:'Travel', meal:'Meal', coffee:'Coffee', network:'Network', flex:'Flex', evening:'Evening', admin:'Admin', dressup:'Dress up' };

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
  const sel = days.map((x, i) => `<button class="chip ${i === curDay ? 'on' : ''}" data-day="${i}">${esc(x.label.slice(0,3))}<span style="opacity:.6;margin-left:5px;font-weight:400">${shortDate(x.date)}</span></button>`).join('');

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

  // Timeline
  const blocks = d.blocks.map((b, i) => {
    const k = b.k || 'session';
    const bkey = 'block:' + d.date + ':' + i;
    const bdone = !!(DATA._state && DATA._state[bkey]);
    let extra = bdone ? ' done' : '', markAttr = '';
    if (i === nowIdx) { extra += ' is-now'; markAttr = ' data-mark="Now"'; }
    else if (i === nextIdx) { extra += ' is-next'; markAttr = ' data-mark="Next"'; }
    if (k === 'flex') extra += ' flex';
    if (k === 'dressup') extra += ' dressup';
    if (isCantMiss(b.t)) extra += ' cant-miss';
    const timeCol = !b.s
      ? '<div class="b-time floating">Floating</div>'
      : `<div class="b-time tnum">${esc(b.s)}${b.e ? '<span class="b-end">' + esc(b.e) + '</span>' : ''}</div>`;
    let body = '<div class="b-body">';
    body += `<div class="b-top"><span class="kchip ${k}">${esc(KIND_LABEL[k] || k)}</span><button class="b-check${bdone ? ' on' : ''}" data-bcheck="${esc(bkey)}" aria-label="mark done"></button></div>`;
    body += `<div class="b-title">${isCantMiss(b.t) ? '<span class="cm-star">★</span> ' : ''}${esc(b.t)}</div>`;
    if (b.w) body += `<div class="b-where">${placeLink(b.w)}</div>`;
    if (b.who) body += `<div class="b-who"><span class="who-lead">Catch</span>${esc(b.who)}</div>`;
    if (k === 'flex') body += '<span class="flex-flag">Protected, keep open</span>';
    if (k === 'dressup') body += '<span class="sharp-flag">Look sharp</span>';
    if (b.n) body += `<div class="b-note">${esc(b.n)}</div>`;
    body += '</div>';
    return `<div class="block ${k}${extra}"${markAttr}>${timeCol}${body}</div>`;
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
  document.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { curDay = +b.dataset.day; viewToday(); window.scrollTo(0, 0); });
}

/* ---------- Schedule ---------- */
let schFilter = { day: 'all', obj: 'all', star: false };
function viewSchedule() {
  const S = DATA.sessions, objs = DATA.objectives || [];
  const objMap = {}; objs.forEach(o => objMap[o.id] = o);
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
  const objChips = objs.map(o => `<button class="chip obj ${schFilter.obj === o.id ? 'on' : ''}" data-f="obj" data-v="${o.id}">${esc(o.short)}</button>`).join('');
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
          <div class="s-meta"><span class="s-room">${placeLink(s.room)}</span>${s.type ? ' · ' + esc(s.type) : ''}${o ? '<span class="s-obj">' + esc(o.short) + '</span>' : ''}</div>
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

/* ---------- People ---------- */
let ppFilter = { obj: 'all' };
function viewPeople() {
  const C = DATA.contacts, objs = DATA.objectives || [];
  const objMap = {}; objs.forEach(o => objMap[o.id] = o);
  const objChips = objs.map(o => `<button class="chip obj ${ppFilter.obj === o.id ? 'on' : ''}" data-f="obj" data-v="${o.id}">${esc(o.short)}</button>`).join('');
  let list = C.filter(c => ppFilter.obj === 'all' || (c.objectives || []).includes(ppFilter.obj));
  const cards = list.map(c => {
    const chips = (c.objectives || []).map(oid => { const o = objMap[oid]; return o ? `<span class="c-chip">${esc(o.short)}</span>` : ''; }).join('');
    const statCls = c.hook_confirmed ? 'c-stat hooked' : 'c-stat';
    const statTxt = c.hook_confirmed ? 'hook confirmed' : 'target';
    return `<div class="card" data-p="${esc(c.id)}">
      <div class="c-top"><div class="c-name">${esc(c.name)}</div><div class="${statCls}">${statTxt}</div></div>
      <div class="c-role"><b>${esc(c.role || '')}</b>${c.company ? ' @ ' + esc(c.company) : ''}</div>
      ${chips ? `<div class="c-chips">${chips}</div>` : ''}
      ${c.source ? `<div class="c-src">${esc(c.source)}</div>` : ''}
      ${c.opener ? `<div class="c-open">${esc(c.opener)}</div>` : ''}
      ${c.hook_confirmed === false ? '<div class="c-warn">Hook unconfirmed · verify before leading with it.</div>' : ''}
    </div>`;
  }).join('') || '<div class="empty">No contacts here.</div>';

  render(masthead() +
    `<div class="sec"><h2>Networking targets</h2>
      <div class="sec-label" style="margin:8px 0 0">People to corner</div>
      <div class="sec-sub">${list.length} people, talking points loaded. Tap one for the detail.</div>
      <div class="chips" style="margin-top:14px">${objChips}</div>
      <div class="people">${cards}</div></div>`);

  tickCountdown();
  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { ppFilter.obj = ppFilter.obj === b.dataset.v ? 'all' : b.dataset.v; viewPeople(); });
  document.querySelectorAll('[data-p]').forEach(c => c.onclick = () => sheetPerson(c.dataset.p));
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

  // Lodging + transport + venue + badge
  const logi = `<div class="sec"><div class="sec-label">Lodging and transport</div><h2>Getting around, staying put</h2>
    <div class="logi">
      <div class="lo-cell full"><div class="lo-k">Transport</div>
        <div class="lo-v">${esc(t.recommended || '')}${t.lacc_distance ? `<span class="lo-sub">The LACC is ${esc(t.lacc_distance)} away.</span>` : ''}</div></div>
      <div class="lo-cell"><div class="lo-k">Airport rides</div>
        <div class="lo-v">In <b>${esc(air.in || '')}</b> · out <b>${esc(air.out || '')}</b><span class="lo-sub">Uber both airport legs.</span></div></div>
      <div class="lo-cell"><div class="lo-k">Lodging</div>
        <div class="lo-v"><b>${esc(lg.place || '')}</b>${lg.area ? ', ' + esc(lg.area) : ''}<span class="lo-sub">${esc(lg.note || '')}</span></div></div>
      <div class="lo-cell full"><div class="lo-k">Venue</div>
        <div class="lo-v"><b>${esc(ven.name || '')}</b>${ven.addr ? ', ' + esc(ven.addr) : ''}<span class="lo-sub">${esc(ven.dates || '')}${ven.floor_hours ? ' · floor ' + esc(ven.floor_hours) : ''}</span></div></div>
    </div>
    <div class="badge-card">
      <div class="bc-name">${esc(bg.name || '')}</div>
      <div class="bc-line">${esc(bg.title || '')}${bg.org ? ' · ' + esc(bg.org) : ''}${bg.tier ? ' · ' + esc(bg.tier) : ''}</div>
      ${bg.risk ? `<div class="bc-risk">${esc(bg.risk)}</div>` : ''}
    </div></div>`;

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

  // Briefs (collapsible markdown)
  const briefsHtml = briefs.length ? `<div class="sec"><div class="sec-label">Reference briefs</div><h2>The background reading</h2>
    ${briefs.map((b, i) => `<details class="brief"${i === 0 ? ' open' : ''}><summary><span class="bs-t">${esc(b.title)}</span><span class="bs-i">+</span></summary>
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
  render(masthead() + tasksHtml + packing + flights + logi + cann + venueHtml + briefsHtml);

  tickCountdown();
  bindTaskRows();

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
    recount();
    saveState('pack:' + cb.dataset.pk, cb.checked);
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
  const objs = DATA.objectives || [], objMap = {}; objs.forEach(o => objMap[o.id] = o);
  const starred = isStarred(id);
  const chips = (s.objectives || []).map(oid => { const o = objMap[oid]; return o ? `<span class="sh-chip">${esc(o.short)}</span>` : ''; }).join('');
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
  const objs = DATA.objectives || [], objMap = {}; objs.forEach(o => objMap[o.id] = o);
  const chips = (c.objectives || []).map(oid => { const o = objMap[oid]; return o ? `<span class="sh-chip">${esc(o.short)}</span>` : ''; }).join('');
  openSheet(`<div class="sh-kicker">${c.hook_confirmed ? 'Hook confirmed' : (c.status ? esc(c.status) : 'Contact')}</div>
    <h3>${esc(c.name)}</h3>
    <div class="meta">${esc(c.role || '')}${c.company ? ' · ' + esc(c.company) : ''}</div>
    ${chips ? `<div class="sh-chips">${chips}</div>` : ''}
    ${c.source ? `<div class="lbl">Where to find</div><div class="val">${esc(c.source)}</div>` : ''}
    ${c.opener ? `<div class="lbl">Talking point</div><div class="val">${esc(c.opener)}</div>` : ''}
    ${c.notes ? `<div class="lbl">Notes</div><div class="val">${esc(c.notes)}</div>` : ''}
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
  const body = `<div class="sec headview"><h2>What the trip costs</h2>
    <div class="sec-label" style="margin:8px 0 0">Financial model</div>
    <div class="bud-top">
      <div class="bud-big"><div class="bud-k">Your out of pocket</div><div class="bud-v tnum">$${B.your_cost || 0}<span> ${esc(B.currency || 'CAD')}</span></div></div>
      <div class="bud-cov">Covered <b class="tnum">$${B.covered || 0}</b>. Total trip <b class="tnum">$${B.total || 0}</b>.</div>
    </div>
    <div class="bud-cats">${(B.by_cat || []).map(c => `<div class="bud-cat"><span>${esc(c.cat)}</span><span class="tnum">$${c.total}</span></div>`).join('')}</div>
    <details class="brief" open><summary><span class="bs-t">Line items</span><span class="bs-i">+</span></summary><div class="bs-body">
      ${(B.rows || []).map(r => `<div class="bud-row"><div class="br-l">${esc(r.label)}<span class="br-m">${esc(r.cat)} · ${esc(r.payer)}${r.qty > 1 ? ' · x' + r.qty : ''} · ${r.actual ? 'paid' : 'est'}${r.note ? ' · ' + esc(r.note) : ''}</span></div><div class="br-amt tnum">$${r.line}</div></div>`).join('')}
    </div></details>
    <div class="sec-sub" style="margin-top:10px">Paid = booked and settled. Everything else is a grounded estimate in ${esc(B.currency || 'CAD')}. To change a number, tell the Agent.</div></div>`;
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
      ${reasoning}
      ${list}</div>`);
  tickCountdown();
  $('#cap-mic').onclick = () => dictate($('#cap-txt'), $('#cap-mic'));
  $('#cap-save').onclick = async () => {
    const body = ($('#cap-txt').value || '').trim(); if (!body) return;
    $('#cap-save').disabled = true;
    await saveRow('captures', { id: uuid(), body, tags: ['note'], status: 'inbox', created_at: new Date().toISOString() });
  };
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
