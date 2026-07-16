/* Circuit app. One shell, hash router, four views, one detail sheet.
   Data arrives as window.DATA (dev, plaintext) or window.__CIPHER__ (encrypted, unlocked by passphrase). */
(() => {
'use strict';
let DATA = null;
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
const EXTERNAL=/LAX|Blvd|Ave\b|\bDr\b|\bSt\b|Station|Silver Lake|Trader|Dan'?s|Hyperion|Fletcher|Sunset|Queen|Revolver|dispensary|SWED|Catalyst|LAXCC|Pine|Night|Intelligentsia|barber/i;
function placeHref(w){ if(!w) return SIG_MAP; return EXTERNAL.test(w)?gmap(w):SIG_MAP; }
function placeLink(w,cls){ if(!w) return ''; return `<a class="${(cls||'')+' maplink'}" href="${placeHref(w)}" target="_blank" rel="noopener">${esc(w)}</a>`; }

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const toMin = t => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const todayISO = () => { const n = new Date(); return n.getFullYear() + '-' + String(n.getMonth()+1).padStart(2,'0') + '-' + String(n.getDate()).padStart(2,'0'); };
const shortDate = iso => { const p = iso.split('-'); return MONTHS[+p[1]-1] + ' ' + (+p[2]); };

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
  if (window.DATA) { DATA = window.DATA; $('#gate').classList.add('hide'); start(); return; }  // dev plaintext
  $('#gate').classList.remove('hide');
  const tryPw = async () => {
    $('#gerr').textContent = '';
    try {
      const saved = store.get('pw');
      DATA = await decrypt($('#pw').value || saved || '');
      store.set('pw', $('#pw').value || saved);
      $('#gate').classList.add('hide'); start();
    } catch { $('#gerr').textContent = 'Wrong passphrase.'; store.set('pw', null); }
  };
  const saved = store.get('pw');
  if (saved) { $('#pw').value = saved; tryPw(); }
  $('#unlock').onclick = tryPw;
  $('#pw').onkeydown = e => { if (e.key === 'Enter') tryPw(); };
  $('#pw').focus();
}

/* ---------- start ---------- */
function start() {
  $('#app').classList.remove('hide');
  window.addEventListener('hashchange', route);
  document.querySelectorAll('nav.tabs a').forEach(a => a.onclick = () => { location.hash = '#/' + a.dataset.route; });
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
function route() {
  const [seg, id] = (location.hash.replace('#/', '') + '/').split('/');
  const tab = ['today', 'schedule', 'people', 'prep'].includes(seg) ? seg : 'today';
  document.querySelectorAll('nav.tabs a').forEach(a => a.classList.toggle('on', a.dataset.route === tab));
  ({ today: viewToday, schedule: viewSchedule, people: viewPeople, prep: viewPrep }[tab])();
  if (id) { tab === 'people' ? sheetPerson(id) : sheetSession(id); } else closeSheet();
  window.scrollTo(0, 0);
}
function render(h) { $('#view').innerHTML = h; }

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

function viewToday() {
  const days = DATA.dayplan.days, tISO = todayISO();
  if (curDay == null) { const i = days.findIndex(d => d.date >= tISO); curDay = i < 0 ? 0 : i; }
  const d = days[curDay], meta = DATA.dayplan.meta || {};
  const isToday = d.date === tISO;

  // Day chips
  const sel = days.map((x, i) => `<button class="chip ${i === curDay ? 'on' : ''}" data-day="${i}">${esc(x.label.slice(0,3))}<span style="opacity:.6;margin-left:5px;font-weight:400">${shortDate(x.date)}</span></button>`).join('');

  // To-handle strip: open tasks, high first
  const open = (DATA.tasks || []).filter(t => t.status === 'open')
    .sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1) || (a.due || '').localeCompare(b.due || ''));
  const handle = open.length ? `<div class="handle">
    <div class="h-head"><span class="h-k">To handle</span><span class="h-c">${open.length} open</span></div>
    ${open.map(t => `<div class="h-row"><div class="h-pri ${t.priority === 'high' ? 'high' : 'med'}">${esc(t.priority || '')}</div>
      <div><div class="h-title">${esc(t.title)}</div><div class="h-meta">${esc(t.kind || '')}${t.due ? ' · due ' + esc(t.due) : ''}</div></div></div>`).join('')}
  </div>` : '';

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
    let extra = '', markAttr = '';
    if (i === nowIdx) { extra += ' is-now'; markAttr = ' data-mark="Now"'; }
    else if (i === nextIdx) { extra += ' is-next'; markAttr = ' data-mark="Next"'; }
    if (k === 'flex') extra += ' flex';
    if (k === 'dressup') extra += ' dressup';
    const timeCol = !b.s
      ? '<div class="b-time floating">Floating</div>'
      : `<div class="b-time tnum">${esc(b.s)}${b.e ? '<span class="b-end">' + esc(b.e) + '</span>' : ''}</div>`;
    let body = '<div class="b-body">';
    body += `<div class="b-top"><span class="kchip ${k}">${esc(KIND_LABEL[k] || k)}</span></div>`;
    body += `<div class="b-title">${esc(b.t)}</div>`;
    if (b.w) body += `<div class="b-where">${placeLink(b.w)}</div>`;
    if (b.who) body += `<div class="b-who"><span class="who-lead">Catch</span>${esc(b.who)}</div>`;
    if (k === 'flex') body += '<span class="flex-flag">Protected, keep open</span>';
    if (k === 'dressup') body += '<span class="sharp-flag">Look sharp</span>';
    if (b.n) body += `<div class="b-note">${esc(b.n)}</div>`;
    body += '</div>';
    return `<div class="block ${k}${extra}"${markAttr}>${timeCol}${body}</div>`;
  }).join('');

  // Tonight's marquee: marquee sessions on this day, evening kinds
  const marquee = (DATA.sessions || []).filter(s => s.marquee && (s.kind === 'event' || s.kind === 'keynote') && s.day && s.day.startsWith(d.label + ' ' + MONTHS[+d.date.split('-')[1]-1]))
    .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  const marqueeHtml = marquee.length ? `<div class="marquee"><div class="m-k">Tonight's marquee</div>
    ${marquee.map(s => `<div class="m-row"><div class="m-time tnum">${esc(s.start || '')}${s.end ? ' to ' + esc(s.end) : ''}</div>
      <div class="m-title">${esc(s.title)}</div><div class="m-room">${placeLink(s.room)}</div></div>`).join('')}</div>` : '';

  render(masthead() +
    handle +
    `<div class="day-head"><div class="day-tag">${esc(d.tag || 'Run of day')}</div>
      <div class="day-name">${esc(d.label)}<span class="dn-date">${shortDate(d.date)}</span></div></div>
     <div class="chips" style="margin-top:12px">${sel}</div>
     ${nowbar}
     ${meta.energy ? `<div class="energy-note">${esc(meta.energy)}</div>` : ''}
     <div class="timeline">${blocks}</div>
     ${marqueeHtml}`);

  tickCountdown();
  document.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { curDay = +b.dataset.day; viewToday(); window.scrollTo(0, 0); });
}

/* ---------- Schedule ---------- */
let schFilter = { day: 'all', obj: 'all', star: false };
function viewSchedule() {
  const S = DATA.sessions, objs = DATA.objectives || [];
  const objMap = {}; objs.forEach(o => objMap[o.id] = o);
  const starred = store.get('starred') || {};

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
  let list = S.filter(s =>
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
      <div class="sec-sub">${list.length} of ${S.length} sessions</div>
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
    `<div class="sec"><div class="sec-label">People to corner</div>
      <h2>Networking targets</h2><div class="sec-sub">${list.length} targets, openers loaded</div>
      <div class="chips" style="margin-top:14px">${objChips}</div>
      <div class="people">${cards}</div></div>`);

  tickCountdown();
  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { ppFilter.obj = ppFilter.obj === b.dataset.v ? 'all' : b.dataset.v; viewPeople(); });
  document.querySelectorAll('[data-p]').forEach(c => c.onclick = () => { location.hash = '#/people/' + c.dataset.p; });
}

/* ---------- Prep ---------- */
function viewPrep() {
  const L = DATA.logistics || {}, P = DATA.packing || { sections: [] }, briefs = DATA.briefs || [];
  const f = L.flights || {}, out = f.out || {}, back = f.back || {};
  const t = L.transport || {}, air = t.uber_airport || {}, lg = L.lodging || {}, ven = L.venue || {}, bg = L.badge || {}, cn = L.cannabis || {};
  const checks = store.get('pack') || {};

  // Flights
  const flights = `<div class="sec"><div class="sec-label">Flights</div><h2>Both legs on Air Canada</h2>
    <div class="flights">
      <div class="fl"><div class="fl-k">Out</div><div class="fl-code">${esc(out.code || '')}</div>
        <div class="fl-line">${esc(out.dep || '')}<br>Lands ${esc(out.arr || '')}${out.conf ? '<br>Conf <b>' + esc(out.conf) + '</b>' : ''}</div>
        <div class="fl-stat">${esc(out.status || '')}</div></div>
      <div class="fl"><div class="fl-k">Back</div><div class="fl-code">${esc(back.code || '')}</div>
        <div class="fl-line">${esc(back.dep || '')}<br>Lands ${esc(back.arr || '')}${back.conf ? '<br>Conf <b>' + esc(back.conf) + '</b>' : ''}</div>
        <div class="fl-stat">${esc(back.status || '')}</div></div>
    </div></div>`;

  // Lodging + transport + venue + badge
  const logi = `<div class="sec"><div class="sec-label">Lodging and transport</div><h2>Getting around, staying put</h2>
    <div class="logi">
      <div class="lo-cell full"><div class="lo-k">Transport</div>
        <div class="lo-v">${esc(t.recommended || '')}${t.lacc_distance ? `<span class="lo-sub">LACC is ${esc(t.lacc_distance)} from Silver Lake.</span>` : ''}</div></div>
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

  // Cannabis
  const cann = (cn.note || cn.near_airport || cn.near_dans) ? `<div class="sec"><div class="sec-label">Cannabis</div><h2>Where and how, once you land</h2>
    <div class="cann">
      ${cn.note ? `<div class="cn-note">${esc(cn.note)}</div>` : ''}
      ${cn.near_airport ? `<div class="cn-sub"><div class="cn-k">Near the airport</div><div class="cn-v">${esc(cn.near_airport)}</div></div>` : ''}
      ${cn.near_dans ? `<div class="cn-sub"><div class="cn-k">Near Dan's</div><div class="cn-v">${esc(cn.near_dans)}</div></div>` : ''}
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

  // Open tasks
  const open = (DATA.tasks || []).filter(t => t.status === 'open')
    .sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1) || (a.due || '').localeCompare(b.due || ''));
  const tasksHtml = open.length ? `<div class="sec"><div class="sec-label">Open tasks</div><h2>Before the floor opens</h2>
    <div class="handle" style="margin-top:8px">
      ${open.map(t => `<div class="h-row"><div class="h-pri ${t.priority === 'high' ? 'high' : 'med'}">${esc(t.priority || '')}</div>
        <div><div class="h-title">${esc(t.title)}</div><div class="h-meta">${esc(t.kind || '')}${t.due ? ' · due ' + esc(t.due) : ''}</div></div></div>`).join('')}
    </div></div>` : '';

  // Budget (computed by the build)
  const B = DATA.budget || {};
  const budgetHtml = B.total ? `<div class="sec"><div class="sec-label">Budget</div><h2>What the trip costs</h2>
    <div class="bud-top">
      <div class="bud-big"><div class="bud-k">Your out of pocket</div><div class="bud-v tnum">$${B.your_cost}<span> ${esc(B.currency)}</span></div></div>
      <div class="bud-cov">Revolver covers <b class="tnum">$${B.covered}</b> (the flight). Total trip <b class="tnum">$${B.total}</b>.</div>
    </div>
    <div class="bud-cats">${(B.by_cat || []).map(c => `<div class="bud-cat"><span>${esc(c.cat)}</span><span class="tnum">$${c.total}</span></div>`).join('')}</div>
    <details class="brief"><summary><span class="bs-t">Line items</span><span class="bs-i">+</span></summary><div class="bs-body">
      ${(B.rows || []).map(r => `<div class="bud-row"><div class="br-l">${esc(r.label)}<span class="br-m">${esc(r.cat)} · ${esc(r.payer)}${r.qty > 1 ? ' · x' + r.qty : ''} · ${r.actual ? 'paid' : 'est'}${r.note ? ' · ' + esc(r.note) : ''}</span></div><div class="br-amt tnum">$${r.line}</div></div>`).join('')}
    </div></details>
    <div class="sec-sub" style="margin-top:10px">Actual = booked and paid. Everything else is a grounded estimate. Edit data/budget.json as you spend and it recomputes.</div></div>` : '';

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

  render(masthead() + budgetHtml + flights + logi + venueHtml + cann + packing + briefsHtml + tasksHtml);

  tickCountdown();

  // Packing interactions
  const recount = () => {
    const c = store.get('pack') || {};
    const done = packIds.filter(id => c[id]).length;
    $('#pp-fill').style.width = (totalN ? done / totalN * 100 : 0) + '%';
    $('#pp-count').textContent = done + ' / ' + totalN + ' packed';
    $('#pp-done').style.display = (done === totalN && totalN) ? '' : 'none';
  };
  document.querySelectorAll('[data-pk]').forEach(cb => cb.onchange = () => {
    const c = store.get('pack') || {}; c[cb.dataset.pk] = cb.checked; store.set('pack', c);
    cb.closest('label'); recount();
  });
  $('#pp-reset').onclick = () => {
    if (!confirm('Clear all ticks?')) return;
    store.set('pack', {});
    document.querySelectorAll('[data-pk]').forEach(cb => cb.checked = false);
    recount();
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
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, url) => `<a href="${esc(url)}" target="_blank" rel="noopener">${txt}</a>`)
    .replace(/(^|[\s(])((?:https?:\/\/)[^\s)]+)/g, (m, pre, url) => `${pre}<a href="${esc(url)}" target="_blank" rel="noopener">${url}</a>`);
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
function openSheet(h) { $('#sheetc').innerHTML = h; $('#scrim').classList.add('on'); $('#sheet').classList.add('on'); }
function closeSheet() { $('#scrim').classList.remove('on'); $('#sheet').classList.remove('on'); }
function sheetSession(id) {
  const s = DATA.sessions.find(x => x.id === id); if (!s) return;
  const objs = DATA.objectives || [], objMap = {}; objs.forEach(o => objMap[o.id] = o);
  const starred = store.get('starred') || {};
  const chips = (s.objectives || []).map(oid => { const o = objMap[oid]; return o ? `<span class="sh-chip">${esc(o.short)}</span>` : ''; }).join('');
  openSheet(`<div class="sh-kicker">${esc(s.type || 'Session')}</div>
    <h3>${esc(s.title)}</h3>
    <div class="meta">${esc(s.day || '')}${s.start ? ' · ' + esc(s.start) + (s.end ? ' to ' + esc(s.end) : '') : ''}${s.room ? ' · ' + placeLink(s.room) : ''}</div>
    ${chips ? `<div class="sh-chips">${chips}</div>` : ''}
    ${s.speakers ? `<div class="lbl">Speakers</div><div class="val">${esc(s.speakers)}</div>` : ''}
    ${s.relevance ? `<div class="lbl">Why this one</div><div class="val">${esc(s.relevance)}</div>` : ''}
    ${s.tier ? `<div class="lbl">Badge</div><div class="val">${esc(s.tier)}</div>` : ''}
    <div><button class="btn primary" id="star">${starred[id] ? '★ Starred' : '☆ Star this'}</button>
    ${s.url ? `<a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener">Program page</a>` : ''}</div>`);
  $('#star').onclick = () => { const st = store.get('starred') || {}; st[id] = !st[id]; store.set('starred', st); sheetSession(id); };
}
function sheetPerson(id) {
  const c = DATA.contacts.find(x => x.id === id); if (!c) return;
  const objs = DATA.objectives || [], objMap = {}; objs.forEach(o => objMap[o.id] = o);
  const chips = (c.objectives || []).map(oid => { const o = objMap[oid]; return o ? `<span class="sh-chip">${esc(o.short)}</span>` : ''; }).join('');
  openSheet(`<div class="sh-kicker">${c.hook_confirmed ? 'Hook confirmed' : 'Target'}</div>
    <h3>${esc(c.name)}</h3>
    <div class="meta"><b>${esc(c.role || '')}</b>${c.company ? ' @ ' + esc(c.company) : ''}</div>
    ${chips ? `<div class="sh-chips">${chips}</div>` : ''}
    ${c.source ? `<div class="lbl">Where to find</div><div class="val">${esc(c.source)}</div>` : ''}
    ${c.opener ? `<div class="lbl">Opener</div><div class="quote">${esc(c.opener)}</div>` : ''}
    ${c.hook_confirmed === false ? '<div class="warn">Hook unconfirmed. Verify before leading with it.</div>' : ''}`);
}

boot();
})();
