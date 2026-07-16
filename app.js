/* Circuit app. One shell, hash router, four views, one detail sheet.
   Data arrives as window.DATA (dev, plaintext) or window.__CIPHER__ (encrypted, unlocked by passphrase). */
(() => {
'use strict';
let DATA = null;
const $ = s => document.querySelector(s);
const el = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.firstElementChild; };
const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const store = { get: k => { try { return JSON.parse(localStorage.getItem('circuit:' + k) || 'null'); } catch { return null; } },
                set: (k, v) => localStorage.setItem('circuit:' + k, JSON.stringify(v)) };

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
  const start = DATA.dayplan?.days?.[0]?.date;
  if (!start) return;
  const days = Math.ceil((new Date(start + 'T00:00') - new Date()) / 86400000);
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

/* ---------- Today (run of day) ---------- */
let curDay = null;
function viewToday() {
  const days = DATA.dayplan.days;
  const todayISO = new Date().toISOString().slice(0, 10);
  if (curDay == null) { const i = days.findIndex(d => d.date >= todayISO); curDay = i < 0 ? days.length - 1 : i; }
  const d = days[curDay], meta = DATA.dayplan.meta || {};
  const sel = days.map((x, i) => `<button class="chip ${i === curDay ? 'on' : ''}" data-day="${i}">${x.label.slice(0,3)}</button>`).join('');
  const isToday = d.date === todayISO;
  let nowIdx = -1;
  if (isToday) { const nowm = nowMin(); nowIdx = d.blocks.findIndex(b => b.s && toMin(b.s) >= nowm); }
  const blocks = d.blocks.map((b, i) => {
    const flag = isToday && i === nowIdx ? '<span class="nowflag">NEXT</span>' : '';
    const t = b.s ? `${b.s}${b.e ? '<small>' + b.e + '</small>' : ''}` : '<span style="color:var(--faint);font-size:12px">flex</span>';
    return `<div class="row ${b.k === 'flex' ? 'flex' : ''} ${isToday && i === nowIdx ? 'now' : ''}">
      <div class="time">${t}</div>
      <div class="body">${flag}<span class="kchip ${b.k}">${b.k}</span>
        <div class="ti" style="margin-top:5px">${esc(b.t)}</div>
        ${b.w ? `<div class="rm">${esc(b.w)}</div>` : ''}
        ${b.who ? `<div class="who">${esc(b.who)}</div>` : ''}
        ${b.n ? `<div class="mt">${esc(b.n)}</div>` : ''}
        ${b.k === 'flex' ? '<span class="tag-protect">protected, keep open</span>' : ''}
      </div></div>`;
  }).join('');
  render(`<div class="vhead"><h1>Run of day</h1><div class="sub">${esc(d.label)}, ${esc(d.tag || '')}</div></div>
    <div class="chips">${sel}</div>
    <div class="mt" style="color:var(--grey);font-size:13px;margin-bottom:10px">${esc(meta.energy || '')}</div>
    ${blocks}`);
  document.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { curDay = +b.dataset.day; viewToday(); });
}
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };

/* ---------- Schedule ---------- */
let schFilter = { day: 'all', obj: 'all', star: false };
function viewSchedule() {
  const S = DATA.sessions, objs = DATA.objectives || [];
  const days = [...new Set(S.map(s => s.day).filter(Boolean))];
  const starred = store.get('starred') || {};
  const dayChips = ['all', ...days].map(x => `<button class="chip ${schFilter.day === x ? 'on' : ''}" data-f="day" data-v="${esc(x)}">${x === 'all' ? 'All days' : esc(x.split(' ')[0])}</button>`).join('');
  const objChips = objs.map(o => `<button class="chip obj ${schFilter.obj === o.id ? 'on' : ''}" data-f="obj" data-v="${o.id}">${esc(o.short)}</button>`).join('');
  const starChip = `<button class="chip ${schFilter.star ? 'on' : ''}" data-f="star" data-v="1">★ Starred</button>`;
  let list = S.filter(s =>
    (schFilter.day === 'all' || s.day === schFilter.day) &&
    (schFilter.obj === 'all' || (s.objectives || []).includes(schFilter.obj)) &&
    (!schFilter.star || starred[s.id]));
  const byDay = {};
  list.forEach(s => (byDay[s.day || 'TBD'] = byDay[s.day || 'TBD'] || []).push(s));
  const body = Object.keys(byDay).map(day => `<h2 style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:var(--faint);margin:22px 0 2px">${esc(day)}</h2>` +
    byDay[day].sort((a, b) => (a.start || '').localeCompare(b.start || '')).map(s => `
      <div class="row" data-sess="${esc(s.id)}">
        <div class="time">${esc(s.start || '')}</div>
        <div class="body"><div class="ti">${starred[s.id] ? '★ ' : ''}${esc(s.title)}</div>
          <div class="rm">${esc(s.room || '')} ${s.type ? '· ' + esc(s.type) : ''}</div>
          ${s.relevance ? `<div class="mt">${esc(s.relevance)}</div>` : ''}</div></div>`).join('')).join('') || '<div class="empty">Nothing matches these filters.</div>';
  render(`<div class="vhead"><h1>Schedule</h1><div class="sub">${list.length} of ${S.length} sessions</div></div>
    <div class="chips">${dayChips}</div><div class="chips">${starChip}${objChips}</div>${body}`);
  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
    const f = b.dataset.f; if (f === 'star') schFilter.star = !schFilter.star;
    else schFilter[f] = schFilter[f] === b.dataset.v ? (f === 'day' ? 'all' : 'all') : b.dataset.v; viewSchedule();
  });
  document.querySelectorAll('[data-sess]').forEach(r => r.onclick = () => { location.hash = '#/schedule/' + r.dataset.sess; });
}

/* ---------- People ---------- */
let ppFilter = { obj: 'all', status: 'all' };
function viewPeople() {
  const C = DATA.contacts, objs = DATA.objectives || [];
  const objChips = objs.map(o => `<button class="chip obj ${ppFilter.obj === o.id ? 'on' : ''}" data-f="obj" data-v="${o.id}">${esc(o.short)}</button>`).join('');
  let list = C.filter(c => ppFilter.obj === 'all' || (c.objectives || []).includes(ppFilter.obj));
  const cards = list.map(c => `<div class="pcard" data-p="${esc(c.id)}">
    <div class="pn">${esc(c.name)}</div>
    <div class="pr">${esc(c.role || '')}${c.company ? ' · ' + esc(c.company) : ''}</div>
    <div class="pmeta">${(c.objectives || []).map(o => `<span class="ochip">${esc((objs.find(x => x.id === o) || {}).short || o)}</span>`).join('')}
      <span class="status ${c.status === 'target' ? 'target' : ''}">${esc(c.status || '')}</span></div>
  </div>`).join('') || '<div class="empty">No contacts here.</div>';
  render(`<div class="vhead"><h1>People</h1><div class="sub">${list.length} targets, openers loaded</div></div>
    <div class="chips">${objChips}</div>${cards}`);
  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { ppFilter.obj = ppFilter.obj === b.dataset.v ? 'all' : b.dataset.v; viewPeople(); });
  document.querySelectorAll('[data-p]').forEach(c => c.onclick = () => { location.hash = '#/people/' + c.dataset.p; });
}

/* ---------- Prep ---------- */
function viewPrep() {
  const L = DATA.logistics || {}, P = DATA.packing || { sections: [] };
  const checks = store.get('pack') || {};
  const packHtml = P.sections.map((sec, si) => `<div class="psec"><h2 class="${sec.buy ? 'buy' : ''}">${esc(sec.h)}</h2>
    ${sec.note ? `<div class="note">${esc(sec.note)}</div>` : ''}<ul>${sec.items.map((it, ii) => {
      const id = 'p' + si + '_' + ii;
      return `<li><label><input type="checkbox" data-pk="${id}" ${checks[id] ? 'checked' : ''}>
        <span class="pt">${esc(it.t)}${it.q ? ' <span class="q">' + esc(it.q) + '</span>' : ''}${it.why ? '<span class="why">' + esc(it.why) + '</span>' : ''}</span>
        ${it.p ? '<span class="price">' + esc(it.p) + '</span>' : ''}</label></li>`;
    }).join('')}</ul></div>`).join('');
  const flights = L.flights ? `<div class="row"><div class="time">Out</div><div class="body"><div class="ti">${esc(L.flights.out?.code || '')}</div><div class="mt">${esc(L.flights.out?.dep || '')}</div></div></div>
    <div class="row"><div class="time">Back</div><div class="body"><div class="ti">${esc(L.flights.back?.code || '')}</div><div class="mt">${esc(L.flights.back?.dep || '')} → ${esc(L.flights.back?.arr || '')}</div></div></div>` : '';
  render(`<div class="vhead"><h1>Prep</h1><div class="sub">Backpack + carry-on. Ticks save on this device.</div></div>
    <h2 style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:var(--faint);margin:8px 0 2px">Flights</h2>${flights}
    <h2 style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:var(--faint);margin:18px 0 0">Lodging + transport</h2>
    <div class="row"><div class="body"><div class="ti">${esc(L.lodging?.place || '')}</div><div class="mt">${esc(L.lodging?.note || '')}</div></div></div>
    <div class="row"><div class="body"><div class="mt">${esc(L.transport?.recommended || '')}</div></div></div>
    ${packHtml}`);
  document.querySelectorAll('[data-pk]').forEach(c => c.onchange = () => { const k = store.get('pack') || {}; k[c.dataset.pk] = c.checked; store.set('pack', k); });
}

/* ---------- sheet (the one modal) ---------- */
function openSheet(h) { $('#sheetc').innerHTML = h; $('#scrim').classList.add('on'); $('#sheet').classList.add('on'); }
function closeSheet() { $('#scrim').classList.remove('on'); $('#sheet').classList.remove('on'); }
function sheetSession(id) {
  const s = DATA.sessions.find(x => x.id === id); if (!s) return;
  const starred = store.get('starred') || {};
  openSheet(`<h3>${esc(s.title)}</h3>
    <div class="meta">${esc(s.day || '')} ${esc(s.start || '')}${s.end ? ' to ' + esc(s.end) : ''} · ${esc(s.room || '')}</div>
    ${s.speakers ? `<div class="lbl">Speakers</div><div class="val">${esc(s.speakers)}</div>` : ''}
    ${s.relevance ? `<div class="lbl">Why</div><div class="val">${esc(s.relevance)}</div>` : ''}
    ${s.tier ? `<div class="lbl">Badge</div><div class="val">${esc(s.tier)}</div>` : ''}
    <div><button class="btn primary" id="star">${starred[id] ? '★ Starred' : '☆ Star this'}</button>
    ${s.url ? `<a class="btn" href="${esc(s.url)}" target="_blank">Program page</a>` : ''}</div>`);
  $('#star').onclick = () => { const st = store.get('starred') || {}; st[id] = !st[id]; store.set('starred', st); sheetSession(id); };
}
function sheetPerson(id) {
  const c = DATA.contacts.find(x => x.id === id); if (!c) return;
  const objs = DATA.objectives || [];
  openSheet(`<h3>${esc(c.name)}</h3>
    <div class="meta">${esc(c.role || '')}${c.company ? ' · ' + esc(c.company) : ''}</div>
    <div class="pmeta" style="margin-top:10px">${(c.objectives || []).map(o => `<span class="ochip">${esc((objs.find(x => x.id === o) || {}).short || o)}</span>`).join('')} <span class="status ${c.status === 'target' ? 'target' : ''}">${esc(c.status || '')}</span></div>
    ${c.source ? `<div class="lbl">Where to find</div><div class="val">${esc(c.source)}</div>` : ''}
    ${c.opener ? `<div class="lbl">Opener</div><div class="quote">${esc(c.opener)}</div>` : ''}
    ${c.hook_confirmed === false ? '<div class="mt" style="margin-top:10px;color:var(--red)">Hook unconfirmed, verify before leading with it.</div>' : ''}`);
}

boot();
})();
