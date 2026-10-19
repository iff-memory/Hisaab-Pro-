import { drawQr } from './qr.js';
import { parseOne, parseMany, parseLedgerLine, INC_RE } from './parse.js';
import * as db from './db.js';

// ---------- state ----------
let S = { tx: [], people: [], budget: 0, upi: { vpa: '', name: '' } };
let pe = { id: null, dir: 'gave' };   // person-entry being edited
let view = { tab: 'home', pid: null, confirmDel: false, focus: null };
let hv = { mo: 0, q: '', cat: 'all' };   // home screen: month offset, search text, category filter
let sh = { mode: 'add', id: null, type: 'exp', cat: 'other', typeManual: false, catManual: false, date: '' };
let lang = 'en-IN', listening = false, countUp = true, installEvt = null, toastTimer = null, lastAdded = null;
const prevVals = {};
const TABS = ['home', 'ledger', 'insights', 'more'];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => '₹' + Math.abs(Math.round(n * 100) / 100).toLocaleString('en-IN');
const fmt = v => (v < 0 ? '-' : '') + inr(v);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const dshort = ts => new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const sum = (a, f) => a.reduce((t, x) => t + f(x), 0);
const buzz = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };

const CATS = [
  { id: 'food', n: 'Food', c: '#E4572E', kw: 'zomato|swiggy|chai|tea|coffee|lunch|dinner|breakfast|khana|nashta|snack|snacks|restaurant|cafe|biryani|pizza|burger|samosa|juice|thali|dhaba|ice cream' },
  { id: 'groceries', n: 'Groceries', c: '#43A047', kw: 'sabzi|sabji|grocery|groceries|kirana|milk|doodh|atta|dal|rice|chawal|fruits|vegetables|bigbasket|blinkit|zepto|eggs|oil' },
  { id: 'travel', n: 'Travel', c: '#1E88E5', kw: 'uber|ola|rapido|auto|petrol|diesel|fuel|bus|metro|train|ticket|flight|cab|toll|parking|taxi|irctc' },
  { id: 'shopping', n: 'Shopping', c: '#8E24AA', kw: 'amazon|flipkart|myntra|meesho|clothes|shirt|shoes|mall|shopping|kapde|jeans|saree|bag' },
  { id: 'bills', n: 'Bills', c: '#F9A825', kw: 'rent|kiraya|bijli|electricity|recharge|wifi|internet|water|gas|emi|bill|insurance|mobile|broadband|dth|fees|fee' },
  { id: 'health', n: 'Health', c: '#E91E63', kw: 'medicine|dawa|doctor|hospital|pharmacy|medical|gym|dentist|test|checkup' },
  { id: 'fun', n: 'Fun', c: '#00ACC1', kw: 'movie|netflix|game|party|cinema|spotify|outing|picnic|hotstar|concert' },
  { id: 'other', n: 'Other', c: '#78909C', kw: '' }
];
CATS.forEach(c => { c.re = c.kw ? new RegExp('\\b(' + c.kw + ')\\b', 'i') : null; });
const INC = { id: 'income', n: 'Money in', c: '#2E9E6B' };
const guessCat = text => (CATS.find(c => c.re && c.re.test(text)) || CATS[CATS.length - 1]).id;
const catOf = t => t.type === 'inc' ? INC : (CATS.find(c => c.id === (t.cat || guessCat(t.note))) || CATS[CATS.length - 1]);

const ymd = ts => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const today = () => ymd(Date.now());
const tsFor = (dateStr, oldTs) => (oldTs && ymd(oldTs) === dateStr) ? oldTs : dateStr === today() ? Date.now() : new Date(dateStr + 'T12:00:00').getTime();
const dateFor = (r, d) => { if (r.off == null) return d || today(); const x = new Date(); x.setDate(x.getDate() + r.off); return ymd(x.getTime()); };
const monthLabel = off => monthRange(off).label;
const monthRange = off => {
  const n = new Date(), s0 = new Date(n.getFullYear(), n.getMonth() + off, 1), e0 = new Date(n.getFullYear(), n.getMonth() + off + 1, 1);
  return { s: s0.getTime(), e: e0.getTime(), label: s0.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) };
};
const offsetOf = ts => { const n = new Date(), d = new Date(ts); return (d.getFullYear() - n.getFullYear()) * 12 + d.getMonth() - n.getMonth(); };

const personBalance = p =>
  sum(p.entries.filter(e => e.dir === 'gave'), e => e.amt) - sum(p.entries.filter(e => e.dir === 'got'), e => e.amt);

function balanceText(b) {
  if (Math.abs(b) < 0.005) return { t: 'Settled', c: '' };
  return b > 0 ? { t: 'Owes you ' + inr(b), c: 'pos' } : { t: 'You owe ' + inr(b), c: 'neg' };
}

function showToast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button id="undo">Undo</button>' : ''}`;
  t.classList.add('show');
  if (undo) $('#undo').onclick = () => { undo(); hideToast(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}
const hideToast = () => $('#toast').classList.remove('show');

// Numbers count up from zero when a screen opens, and from their old value when data changes.
function runCounters(fromZero) {
  document.querySelectorAll('[data-count]').forEach(el => {
    const to = parseFloat(el.dataset.count) || 0, key = el.dataset.key;
    const from = fromZero ? 0 : (prevVals[key] ?? to);
    prevVals[key] = to;
    if (reduceMotion || from === to) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 650;
    const tick = now => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(k < 1 ? from + (to - from) * e : to);
      if (k < 1) requestAnimationFrame(tick);
    };
    el.textContent = fmt(from);
    requestAnimationFrame(tick);
  });
}

// ---------- views ----------
const swipeRow = (action, id, inner, cls = '', attrs = '') =>
  `<div class="swipe" data-swipe="${action}" data-id="${id}"><div class="swipe-bg" aria-hidden="true">Delete</div><div class="line ${cls}" ${attrs}>${inner}</div></div>`;

function monthTx() { const r = monthRange(hv.mo); return S.tx.filter(t => t.ts >= r.s && t.ts < r.e); }

function listHTML() {
  const q = hv.q.trim().toLowerCase();
  let rows = monthTx();
  const monthCount = rows.length;
  if (hv.cat === 'income') rows = rows.filter(t => t.type === 'inc');
  else if (hv.cat !== 'all') rows = rows.filter(t => t.type === 'exp' && catOf(t).id === hv.cat);
  if (q) rows = rows.filter(t => t.note.toLowerCase().includes(q) || String(t.amt).includes(q));
  rows.sort((a, b) => b.ts - a.ts);
  if (!rows.length) {
    return `<p class="empty">${monthCount ? 'Nothing matches. Try another word or category.' : hv.mo === 0 ? 'No entries yet. Tap + to add your first expense.' : 'No entries in this month.'}</p>`;
  }
  const html = rows.slice(0, 200).map(t => {
    const c = catOf(t);
    return swipeRow('delTx', t.id, `
      <div class="n"><b>${esc(t.note)}</b><small class="meta"><span class="cat"><i class="dot" style="--c:${c.c}"></i>${c.n}</span><span>${dshort(t.ts)}</span></small></div>
      <div class="r num ${t.type === 'inc' ? 'pos' : ''}">${t.type === 'inc' ? '+' : '-'}${inr(t.amt)}
        <button class="x" data-a="delTx" data-id="${t.id}" aria-label="Delete ${esc(t.note)}">×</button></div>`,
      t.id === lastAdded ? 'new' : '', `data-a="editTx" data-id="${t.id}" role="button" tabindex="0" aria-label="Edit ${esc(t.note)}"`);
  }).join('');
  return `<section class="sheet tight">${html}</section><p class="hint">Tap an entry to edit it. Swipe left to delete.</p>`;
}

function homeView() {
  const r = monthRange(hv.mo), m = monthTx(), cur = hv.mo === 0;
  const spent = sum(m.filter(t => t.type === 'exp'), t => t.amt);
  const inc = sum(m.filter(t => t.type === 'inc'), t => t.amt);
  const left = inc - spent;

  let week = '';
  if (cur) {
    const d = new Date(), days = [];
    for (let i = 6; i >= 0; i--) {
      const s0 = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i).getTime();
      days.push({ s: s0, v: sum(S.tx.filter(t => t.type === 'exp' && t.ts >= s0 && t.ts < s0 + 86400000), t => t.amt) });
    }
    const max = Math.max(1, ...days.map(x => x.v));
    week = `<div class="week" aria-label="Spending in the last 7 days">${days.map(x =>
      `<div class="bar" title="${esc(inr(x.v))}"><i style="height:${Math.max(4, x.v / max * 100)}%"></i><span>${new Date(x.s).toLocaleDateString('en-IN', { weekday: 'narrow' })}</span></div>`).join('')}</div>`;
  }

  let budget = '';
  if (S.budget > 0) {
    const pct = spent / S.budget, cls = pct > 1 ? 'over' : pct >= 0.8 ? 'warn' : '';
    budget = `<div class="line budget"><div class="bl"><span class="l">Budget ${inr(S.budget)}</span>
      <b class="num ${pct > 1 ? 'neg' : ''}">${pct > 1 ? inr(spent - S.budget) + ' over' : inr(S.budget - spent) + ' left'}</b></div>
      <div class="meter"><i class="${cls}" style="transform:scaleX(${Math.min(1, pct)})"></i></div></div>`;
  }

  const chips = [{ id: 'all', n: 'All' }, ...CATS, INC].map(c =>
    `<button class="chip ${hv.cat === c.id ? 'on' : ''}" data-a="filt" data-cat="${c.id}">${c.c ? `<i class="dot" style="--c:${c.c}"></i>` : ''}${c.n}</button>`).join('');

  return `
    ${moBar(r, cur)}
    <section class="sheet" aria-label="${r.label}">
      <div class="line"><span class="l">Spent</span><b class="v num" data-key="spent" data-count="${spent}">${fmt(spent)}</b></div>
      <div class="line"><span class="l">Money in</span><b class="v num pos" data-key="inc" data-count="${inc}">${fmt(inc)}</b></div>
      ${budget}
      <div class="line total"><span class="l">Left</span>
        <b class="v num ${left < 0 ? 'neg' : ''}" data-key="left" data-count="${left}">${fmt(left)}</b></div>
    </section>
    ${week}
    ${!S.budget && cur ? '<p class="hint"><button class="link-btn" data-a="tab" data-tab="more">Set a monthly budget</button> to see how much you have left.</p>' : ''}
    <h2>Entries</h2>
    <input id="search" type="search" placeholder="Search entries" aria-label="Search entries" value="${esc(hv.q)}" autocomplete="off">
    <div class="chips" aria-label="Filter by category">${chips}</div>
    <div id="list">${listHTML()}</div>`;
}

const curPerson = () => S.people.find(x => x.id === view.pid);
const UPI_RE = /^[\w.\-]{2,}@[A-Za-z]{2,}$/;
const upiOk = () => UPI_RE.test(S.upi.vpa || '');
const noonOf = ymdStr => new Date(ymdStr + 'T12:00:00').getTime();

// Due date status. Only shown while the person still owes you.
function dueInfo(p) {
  if (!p.due || personBalance(p) <= 0.005) return null;
  const days = Math.round((noonOf(p.due) - noonOf(today())) / 86400000);
  const when = new Date(noonOf(p.due)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  if (days < 0) return { text: `Overdue by ${-days} ${-days === 1 ? 'day' : 'days'}`, cls: 'neg', days, when };
  if (days === 0) return { text: 'Due today', cls: 'warn', days, when };
  if (days <= 3) return { text: `Due in ${days} ${days === 1 ? 'day' : 'days'}`, cls: 'warn', days, when };
  return { text: `Due ${when}`, cls: '', days, when };
}
function reminderText(p, b) {
  const di = dueInfo(p);
  return `Hi ${p.name}, a gentle reminder about ${inr(b)} pending${di ? ` (due ${di.when})` : ''}.${upiOk() ? ` You can pay via UPI: ${S.upi.vpa}.` : ''} Thank you!`;
}
function upiLink(amount, withName = true) {
  const name = (S.upi.name || '').slice(0, 24);
  return `upi://pay?pa=${S.upi.vpa}&cu=INR${withName && name ? `&pn=${encodeURIComponent(name)}` : ''}${amount > 0 ? `&am=${amount.toFixed(2)}` : ''}`;
}
// Statements are worded neutrally so they read correctly for both people.
function statementText(p) {
  const b = personBalance(p);
  const lines = [...p.entries].sort((a, c) => a.ts - c.ts)
    .map(e => `${dshort(e.ts)}: ${e.dir === 'gave' ? 'Given' : 'Received'} ${inr(e.amt)}${e.note ? ' (' + e.note + ')' : ''}`);
  const end = Math.abs(b) < 0.005 ? 'Settled, nothing pending.' : b > 0 ? `Pending from ${p.name}: ${inr(b)}` : `Pending to ${p.name}: ${inr(b)}`;
  return [`Statement: ${p.name}`, ...lines, end, ...(b > 0.005 && upiOk() ? [`Pay via UPI: ${S.upi.vpa}`] : []), 'Made with Hisaab'].join('\n');
}
function fitText(c, text, maxW) {
  if (c.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && c.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
function drawStatement(cv, p) {
  const all = [...p.entries].sort((a, c) => a.ts - c.ts), shown = all.slice(-16), hidden = all.length - shown.length;
  const W = 720, RH = 58, HEAD = 130, b = personBalance(p), owes = b > 0.005 && upiOk();
  const rowsH = Math.max(1, shown.length + (hidden ? 1 : 0)) * RH;
  const H = HEAD + rowsH + 110 + (owes ? 50 : 0) + 50;
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d'), F = 'system-ui, -apple-system, "Noto Sans", "Noto Sans Devanagari", sans-serif';
  c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
  c.fillStyle = '#16204A'; c.fillRect(0, 0, W, HEAD - 14);
  c.fillStyle = '#fff'; c.font = `700 40px ${F}`; c.fillText(fitText(c, p.name, W - 80), 40, 62);
  c.font = `400 24px ${F}`; c.fillStyle = 'rgba(255,255,255,.75)';
  c.fillText('Statement, ' + new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }), 40, 98);
  const bottom = HEAD + rowsH;
  c.strokeStyle = '#E0525F'; c.lineWidth = 2; c.beginPath();
  [118, 126].forEach(x => { c.moveTo(x, HEAD - 14); c.lineTo(x, bottom); }); c.stroke();
  c.strokeStyle = '#D9DFEE'; c.lineWidth = 1;
  let y = HEAD;
  const line = yy => { c.beginPath(); c.moveTo(0, yy + 0.5); c.lineTo(W, yy + 0.5); c.stroke(); };
  if (hidden) { c.font = `400 22px ${F}`; c.fillStyle = '#5B6683'; c.fillText(`${hidden} earlier ${hidden === 1 ? 'entry' : 'entries'} not shown`, 150, y + RH - 20); y += RH; line(y); }
  if (!shown.length && !hidden) { c.font = `400 24px ${F}`; c.fillStyle = '#5B6683'; c.fillText('No entries yet', 150, y + RH - 20); line(y + RH); }
  shown.forEach(e => {
    const gave = e.dir === 'gave', amt = inr(e.amt);
    c.font = `400 22px ${F}`; c.fillStyle = '#5B6683'; c.fillText(dshort(e.ts), 24, y + RH - 20);
    c.font = `700 28px ${F}`; c.fillStyle = gave ? '#B8283F' : '#157A4D'; c.textAlign = 'right'; c.fillText(amt, W - 36, y + RH - 18); c.textAlign = 'left';
    const aw = c.measureText(amt).width;
    c.font = `600 26px ${F}`; c.fillStyle = '#182036';
    const label = gave ? 'Given' : 'Received'; c.fillText(label, 150, y + RH - 18);
    const lw = c.measureText(label).width;
    if (e.note) { c.font = `400 22px ${F}`; c.fillStyle = '#5B6683'; c.fillText(fitText(c, e.note, W - 36 - aw - 150 - lw - 40), 150 + lw + 14, y + RH - 19); }
    y += RH; line(y);
  });
  c.fillStyle = '#182036'; c.fillRect(0, bottom + 2, W, 3);
  const bt = Math.abs(b) < 0.005 ? 'Settled' : b > 0 ? `Pending from ${p.name}` : `Pending to ${p.name}`;
  c.font = `600 26px ${F}`; c.fillStyle = '#182036';
  const money = Math.abs(b) < 0.005 ? '' : inr(b);
  c.font = `700 44px ${F}`; const mw = money ? c.measureText(money).width : 0;
  c.font = `600 26px ${F}`; c.fillText(fitText(c, bt, W - 80 - mw - 20), 40, bottom + 72);
  if (money) { c.font = `700 44px ${F}`; c.fillStyle = b > 0 ? '#157A4D' : '#B8283F'; c.textAlign = 'right'; c.fillText(money, W - 36, bottom + 74); c.textAlign = 'left'; }
  if (owes) { c.font = `400 24px ${F}`; c.fillStyle = '#5B6683'; c.fillText(fitText(c, `Pay via UPI: ${S.upi.vpa}`, W - 80), 40, bottom + 122); }
  c.font = `400 20px ${F}`; c.fillStyle = '#8A93A8'; c.textAlign = 'center'; c.fillText('Made with Hisaab', W / 2, H - 18); c.textAlign = 'left';
}
async function shareCanvas(cv, filename) {
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  if (!blob) return showToast('Could not make the image');
  const file = new File([blob], filename, { type: 'image/png' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast('Image saved. Find it in Downloads or Gallery.');
}
async function shareText(text) {
  try { if (navigator.share) { await navigator.share({ text }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); showToast('Statement copied'); } catch (e) { showToast('Could not copy the text'); }
}

function ledgerView() {
  if (view.pid) {
    const p = curPerson();
    if (!p) { view.pid = null; return ledgerView(); }
    const b = personBalance(p), bt = balanceText(b), di = dueInfo(p);
    const phone = (p.phone || '').replace(/\D/g, '');
    const wa = `https://wa.me/${phone}?text=${encodeURIComponent(reminderText(p, b))}`;
    const rows = [...p.entries].sort((a, c) => c.ts - a.ts).map(e => swipeRow('delEntry', e.id, `
        <div class="n"><b>${e.dir === 'gave' ? 'You gave' : 'You got'}${e.note ? ': ' + esc(e.note) : ''}</b><small>${dshort(e.ts)}</small></div>
        <div class="r num ${e.dir === 'got' ? 'pos' : 'neg'}">${inr(e.amt)}
          <button class="x" data-a="delEntry" data-id="${e.id}" aria-label="Delete entry">×</button></div>`,
      e.id === lastAdded ? 'new' : '', `data-a="editEntry" data-id="${e.id}" role="button" tabindex="0" aria-label="Edit entry"`)).join('');
    return `
      <button class="back" data-a="back">← All people</button>
      <section class="sheet" style="view-transition-name:person">
        <div class="line total no-rule"><span class="l">${esc(p.name)}</span><b class="v ${bt.c}">${bt.t}</b></div>
        ${di ? `<div class="line"><span class="l">Due</span><b class="${di.cls}">${di.cls ? `${di.text} (${di.when})` : di.when}</b></div>` : ''}
      </section>
      <div class="stack">
        <input id="amt" type="number" inputmode="decimal" min="0" placeholder="Amount" aria-label="Amount">
        <input id="note" type="text" placeholder="Note (optional)" aria-label="Note" autocomplete="off">
      </div>
      <label class="daterow"><span>Date</span><input id="edate" type="date" max="${today()}" value="${today()}"></label>
      <div class="pair">
        <button class="gave" data-a="entry" data-dir="gave">You gave</button>
        <button class="got" data-a="entry" data-dir="got">You got</button>
      </div>
      <p class="hint" id="msg"></p>
      <div class="pair">
        <button class="ghost" data-a="statement">Share statement</button>
        ${upiOk() ? `<button class="ghost" data-a="payQr" data-amt="${b > 0 ? b : 0}">Payment QR</button>` : ''}
      </div>
      ${b > 0 ? `<a class="link" href="${wa}" target="_blank" rel="noopener">Remind ${esc(p.name)} on WhatsApp</a>` : ''}
      <h2>History</h2>
      ${rows ? `<section class="sheet tight">${rows}</section><p class="hint">Tap an entry to edit it. Swipe left to delete.</p>`
             : '<p class="empty">Nothing here yet. Enter an amount, then tap You gave or You got.</p>'}
      <div class="pair" style="margin-top:24px">
        <button class="ghost" data-a="editPerson">Edit details</button>
        ${view.confirmDel
          ? `<button class="ghost" data-a="delPerson" style="color:var(--owe);border-color:var(--owe)">Tap again to delete</button>`
          : `<button class="ghost" data-a="askDel">Delete person</button>`}
      </div>`;
  }
  let toGet = 0, toGive = 0, overdue = 0;
  S.people.forEach(p => {
    const b = personBalance(p), di = dueInfo(p);
    b > 0 ? toGet += b : toGive += -b;
    if (di && di.days < 0) overdue += b;
  });
  const rank = p => { const b = personBalance(p), di = dueInfo(p); return [di && di.days < 0 ? 0 : 1, Math.abs(b) < 0.005 ? 1 : 0, -Math.abs(b)]; };
  const sorted = [...S.people].sort((a, c) => { const x = rank(a), y = rank(c); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
  const rows = sorted.map(p => {
    const bt = balanceText(personBalance(p)), di = dueInfo(p);
    return `<button class="person line" data-a="open" data-id="${p.id}" style="view-transition-name:${p.id === view.focus ? 'person' : 'none'}">
      <span class="n"><b>${esc(p.name)}</b><small>${p.entries.length} ${p.entries.length === 1 ? 'entry' : 'entries'}${di ? `<span class="due ${di.cls}">${di.text}</span>` : ''}</small></span>
      <span class="num ${bt.c}" style="font-weight:700">${bt.t}</span></button>`;
  }).join('');
  return `
    <section class="sheet">
      <div class="line"><span class="l">You will get</span><b class="v num pos" data-key="toget" data-count="${toGet}">${fmt(toGet)}</b></div>
      ${overdue > 0 ? `<div class="line"><span class="l">Overdue</span><b class="v num neg" data-key="overdue" data-count="${overdue}">${fmt(overdue)}</b></div>` : ''}
      <div class="line"><span class="l">You owe</span><b class="v num neg" data-key="togive" data-count="${toGive}">${fmt(toGive)}</b></div>
    </section>
    <h2>Quick entry</h2>
    <div class="quick" style="margin-top:0">
      <input id="lq" type="text" placeholder="Rahul ko 500 diye" aria-label="Quick ledger entry" autocomplete="off">
      <button class="primary" data-a="quickLedger" style="flex:none">Add</button>
    </div>
    <p class="hint" id="lmsg">Name and amount: “Rahul ko 500 diye” (you gave) or “Rahul se 300 mile” (you got).</p>
    <h2>Add a person</h2>
    <div class="stack">
      <input id="pname" type="text" placeholder="Name" aria-label="Name" autocomplete="off">
      <input id="pphone" type="tel" placeholder="WhatsApp number with country code (optional)" aria-label="Phone">
      <button class="primary" data-a="addPerson">Add person</button>
    </div>
    <p class="hint" id="msg"></p>
    <h2>People</h2>
    ${rows ? `<section class="sheet tight">${rows}</section>` : '<p class="empty">No one yet. Add a person to start their ledger.</p>'}`;
}

const moBar = (r, cur) => `
    <div class="mo">
      <button data-a="mo" data-d="-1" aria-label="Previous month">‹</button>
      <b>${r.label}</b>
      <button data-a="mo" data-d="1" aria-label="Next month" ${cur ? 'disabled' : ''}>›</button>
    </div>`;

const compact = v => v <= 0 ? '' : v >= 1e5 ? (v / 1e5).toFixed(1).replace('.0', '') + 'L' : v >= 1e3 ? (v / 1e3).toFixed(1).replace('.0', '') + 'k' : String(Math.round(v));
const spentIn = (s0, e0) => sum(S.tx.filter(t => t.type === 'exp' && t.ts >= s0 && t.ts < e0), t => t.amt);

function insightsView() {
  const r = monthRange(hv.mo), cur = hv.mo === 0;
  const m = monthTx(), exp = m.filter(t => t.type === 'exp');
  const spent = sum(exp, t => t.amt), inc = sum(m.filter(t => t.type === 'inc'), t => t.amt);
  if (!exp.length) {
    return `${moBar(r, cur)}<p class="empty">No spending in ${r.label} yet. Add an entry and your insights will show up here.</p>`;
  }

  // where it went
  const byCat = {};
  exp.forEach(t => { const id = catOf(t).id; byCat[id] = (byCat[id] || 0) + t.amt; });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([id, v]) => ({ c: CATS.find(c => c.id === id), v }));

  // busiest day, daily pace, comparison with the previous month
  const byDay = {};
  exp.forEach(t => { const k = ymd(t.ts); byDay[k] = (byDay[k] || 0) + t.amt; });
  const [topDayKey, topDayVal] = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
  const daysIn = cur ? new Date().getDate() : new Date(r.e - 1).getDate();
  const pr = monthRange(hv.mo - 1);
  const cut = cur ? Math.min(pr.e, new Date(pr.s).setDate(daysIn) + 86400000) : pr.e;
  const prev = spentIn(pr.s, cut);

  const lines = [];
  const share = Math.round(cats[0].v / spent * 100);
  const top = share === 100 ? `all of it on <b>${cats[0].c.n}</b>` : share >= 50 ? `mostly on <b>${cats[0].c.n}</b> (${share}%)` : `the most on <b>${cats[0].c.n}</b> (${share}%)`;
  lines.push(`${cur ? 'So far this month' : 'In ' + r.label} you spent <b>${inr(spent)}</b>, ${top}.`);
  lines.push(`That is about ${inr(Math.round(spent / daysIn))} a day.`);
  if (exp.length > 1) lines.push(`Your biggest day was ${new Date(topDayKey + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}, with ${inr(topDayVal)}.`);
  if (prev > 0) {
    const p = Math.round((spent - prev) / prev * 100);
    const base = cur ? 'the same days last month' : 'the month before';
    lines.push(Math.abs(p) < 3 ? `About the same as ${base}.` : `${Math.abs(p)}% ${p < 0 ? 'less' : 'more'} than ${base}.`);
  }
  if (inc > 0) lines.push(spent <= inc ? `You kept ${Math.round((inc - spent) / inc * 100)}% of the money that came in.` : `You spent ${inr(spent - inc)} more than came in.`);
  const story = lines.map((t, i) => `<span style="--k:${i}">${t}</span>`).join(' ');

  // last six months
  const months = [];
  for (let off = -5; off <= 0; off++) {
    const mr = monthRange(off);
    months.push({ off, v: spentIn(mr.s, mr.e), lbl: new Date(mr.s).toLocaleDateString('en-IN', { month: 'short' }) });
  }
  const mx = Math.max(1, ...months.map(x => x.v));
  const trend = months.map(x => `
    <button class="tbar ${x.off === hv.mo ? 'on' : ''}" data-a="moJump" data-off="${x.off}" aria-label="${x.lbl}: ${inr(x.v)}">
      <em class="num">${compact(x.v)}</em><span class="col"><i style="height:${Math.max(3, x.v / mx * 100)}%"></i></span><span>${x.lbl}</span>
    </button>`).join('');

  const catRows = cats.map(({ c, v }) => `
    <button class="person catrow line" data-a="catJump" data-cat="${c.id}" aria-label="Show ${c.n} entries">
      <span class="n"><b><i class="dot" style="--c:${c.c}"></i> ${c.n}</b>
        <span class="cbar"><i style="--c:${c.c};transform:scaleX(${v / cats[0].v})"></i></span></span>
      <span class="r num"><span>${inr(v)}</span><small>${Math.round(v / spent * 100)}%</small></span>
    </button>`).join('');

  const big = [...exp].sort((a, b) => b.amt - a.amt).slice(0, 3).map(t => {
    const c = catOf(t);
    return `<div class="line"><div class="n"><b>${esc(t.note)}</b><small class="meta"><span class="cat"><i class="dot" style="--c:${c.c}"></i>${c.n}</span><span>${dshort(t.ts)}</span></small></div>
      <div class="r num">${inr(t.amt)}</div></div>`;
  }).join('');

  return `
    ${moBar(r, cur)}
    <h2>Your month in words</h2>
    <section class="sheet story"><p>${story}</p></section>
    <h2>Where it went</h2>
    <section class="sheet tight">${catRows}</section>
    <p class="hint">Tap a category to see its entries.</p>
    <h2>Last 6 months</h2>
    <div class="trend">${trend}</div>
    <h2>Biggest spends</h2>
    <section class="sheet tight">${big}</section>`;
}

function moreView() {
  return `
    <h2>Your data</h2>
    <section class="sheet">
      <div class="line"><span class="l">Entries</span><b class="v num">${S.tx.length}</b></div>
      <div class="line"><span class="l">People</span><b class="v num">${S.people.length}</b></div>
    </section>
    <p class="hint">Everything is saved on this phone only. There is no account and nothing is uploaded.${db.isMemoryOnly() ? ' <b>Your browser is blocking storage, so data will be lost when you close this page.</b>' : ''}</p>
    <h2>Monthly budget</h2>
    <div class="pair">
      <input id="bud" type="number" inputmode="decimal" min="0" placeholder="For example 15000" aria-label="Monthly budget" value="${S.budget || ''}">
      <button class="primary" data-a="saveBudget">Save</button>
    </div>
    <p class="hint">Shows a progress bar on the Expenses screen. Leave it empty to turn it off.</p>
    <h2>Payment details</h2>
    <div class="stack">
      <input id="upi-id" type="text" inputmode="email" placeholder="Your UPI ID, like name@bank" aria-label="UPI ID" value="${esc(S.upi.vpa)}" autocomplete="off" autocapitalize="none" spellcheck="false">
      <input id="upi-name" type="text" placeholder="Name shown to the payer (optional)" aria-label="Name for payments" value="${esc(S.upi.name)}" autocomplete="off">
      <button class="primary" data-a="saveUpi">Save</button>
    </div>
    ${upiOk() ? '<button class="ghost full" data-a="myQr">Show my payment QR</button>' : ''}
    <p class="hint">Used in WhatsApp reminders, statements and payment QR codes. Stored only on this phone.</p>
    <h2>Backup</h2>
    <div class="stack">
      <button class="primary" data-a="export">Save backup file</button>
      <label class="btn ghost" for="imp">Restore from backup</label>
      <input id="imp" type="file" accept="application/json,.json" hidden>
    </div>
    <p class="hint">Save a backup now and then, and before clearing browser data or changing phone.</p>
    ${installEvt ? '<h2>App</h2><button class="ghost full" data-a="install">Install Hisaab on this phone</button>' : ''}`;
}

const SUBS = { home: () => monthLabel(hv.mo), insights: () => monthLabel(hv.mo), ledger: () => 'Money between people', more: () => 'Backup and settings' };

function render() {
  $('#sub').textContent = SUBS[view.tab]();
  const v = $('#view');
  v.classList.toggle('enter', countUp);
  v.innerHTML = { home: homeView, ledger: ledgerView, insights: insightsView, more: moreView }[view.tab]();
  TABS.forEach(t => {
    const b = $('#t-' + t);
    view.tab === t ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current');
  });
  const ind = $('.ind');
  ind.style.width = 100 / TABS.length + '%';
  ind.style.transform = `translateX(${TABS.indexOf(view.tab) * 100}%)`;
  $('#fab').classList.toggle('show', view.tab === 'home' && !sheetOpen());
  if (countUp) v.querySelectorAll('.sheet .line').forEach((el, i) => el.style.setProperty('--i', Math.min(i, 9)));
  runCounters(countUp);
  countUp = false; lastAdded = null; view.focus = null;
}
// Change screens with a soft cross-fade (and shared-element morph) where the browser supports it.
function go(change) {
  const run = () => { change(); countUp = true; render(); window.scrollTo(0, 0); };
  if (document.startViewTransition && !reduceMotion) document.startViewTransition(run); else run();
}
const say = (t, id = 'msg') => { const m = $('#' + id); if (m) m.textContent = t; };

// ---------- add-entry sheet ----------
const sheetOpen = () => $('#sheet').classList.contains('open');
let sheetToken = 0;
function renderCtl() {
  $('#sheet-ctl').innerHTML = `
    <div class="seg" role="group" aria-label="Type">
      <button class="${sh.type === 'exp' ? 'on' : ''}" data-a="setType" data-type="exp">Spent</button>
      <button class="${sh.type === 'inc' ? 'on' : ''}" data-a="setType" data-type="inc">Money in</button>
    </div>
    ${sh.type === 'exp' ? `<div class="chips" aria-label="Category">${CATS.map(c =>
      `<button class="chip ${sh.cat === c.id ? 'on' : ''}" data-a="setCat" data-cat="${c.id}"><i class="dot" style="--c:${c.c}"></i>${c.n}</button>`).join('')}</div>` : ''}`;
}
function renderPreview() {
  const el = $('#preview'); if (!el) return;
  const text = $('#q').value.trim();
  if (!text) { el.innerHTML = ''; return; }
  const list = sh.mode === 'edit' ? [parseOne(text)].filter(Boolean) : parseMany(text);
  if (!list.length) { el.innerHTML = '<span class="muted">Add an amount to continue.</span>'; return; }
  el.innerHTML = list.map(r => {
    const type = sh.typeManual ? sh.type : r.type;
    const c = type === 'inc' ? INC : CATS.find(x => x.id === (sh.catManual ? sh.cat : guessCat(r.note)));
    const when = r.off == null ? '' : r.off === 0 ? ', today' : r.off === -1 ? ', yesterday' : ', 2 days ago';
    return `<div class="pv"><b class="num ${type === 'inc' ? 'pos' : ''}">${type === 'inc' ? '+' : ''}${inr(r.amt)}</b><span>${esc(r.note)}</span><small><i class="dot" style="--c:${c.c}"></i>${c.n}${when}</small></div>`;
  }).join('');
}
function renderSheet() {
  const q = $('#q'), v = q ? q.value : '';
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const edit = sh.mode === 'edit';
  $('#sheet-body').innerHTML = `
    <h2>${edit ? 'Edit entry' : 'Add entry'}</h2>
    <div class="quick">
      <input id="q" type="text" placeholder="Zomato 250 or paise aaye 500" aria-label="Quick entry" autocomplete="off">
      ${SR ? `<button class="icon ${listening ? 'on' : ''}" data-a="mic" aria-label="Speak an entry">🎤</button>
      <button class="icon" data-a="lang" aria-label="Voice language">${lang === 'en-IN' ? 'EN' : 'हि'}</button>` : ''}
    </div>
    <div id="preview" class="preview" aria-live="polite"></div>
    <div id="sheet-ctl"></div>
    <label class="daterow"><span>Date</span><input id="qdate" type="date" max="${today()}" value="${sh.date}"></label>
    <button class="primary full" data-a="addTx">${edit ? 'Save changes' : 'Add entry'}</button>
    <p class="hint" id="smsg">Type naturally: “chai 20, samosa 30”, “kal petrol 500”, “paanch sau rent”. You can also paste a bank SMS.</p>`;
  $('#q').value = v; renderCtl(); renderPreview();
}
function openSheet(prefill) {
  sh = prefill ? { mode: 'edit', ...prefill }
               : { mode: 'add', id: null, type: 'exp', cat: 'other', typeManual: false, catManual: false, date: today() };
  $('#sheet-body').innerHTML = '';
  renderSheet();
  if (prefill) { $('#q').value = prefill.text; renderPreview(); }
  showSheet('#q');
}
function showSheet(focusSel) {
  const token = ++sheetToken, s = $('#sheet'), sc = $('#scrim');
  s.hidden = false; sc.hidden = false;
  $('#fab').classList.remove('show');
  requestAnimationFrame(() => requestAnimationFrame(() => { s.classList.add('open'); sc.classList.add('open'); }));
  if (focusSel) setTimeout(() => { const el = $(focusSel); if (token === sheetToken && el) el.focus(); }, 280);
}
function openEntrySheet(id) {
  const p = curPerson(), e = p && p.entries.find(x => x.id === id); if (!e) return;
  pe = { id, dir: e.dir };
  $('#sheet-body').innerHTML = `
    <h2>Edit entry</h2>
    <div class="seg" role="group" aria-label="Direction">
      <button class="${e.dir === 'gave' ? 'on' : ''}" data-a="peDir" data-dir="gave">You gave</button>
      <button class="${e.dir === 'got' ? 'on' : ''}" data-a="peDir" data-dir="got">You got</button>
    </div>
    <div class="stack">
      <input id="pe-amt" type="number" inputmode="decimal" min="0" placeholder="Amount" aria-label="Amount" value="${e.amt}">
      <input id="pe-note" type="text" placeholder="Note (optional)" aria-label="Note" value="${esc(e.note || '')}" autocomplete="off">
    </div>
    <label class="daterow"><span>Date</span><input id="pe-date" type="date" max="${today()}" value="${ymd(e.ts)}"></label>
    <button class="primary full" data-a="peSave">Save changes</button>
    <p class="hint" id="smsg"></p>`;
  showSheet('#pe-amt');
}
function openPersonSheet() {
  const p = curPerson(); if (!p) return;
  $('#sheet-body').innerHTML = `
    <h2>Edit person</h2>
    <div class="stack">
      <input id="pp-name" type="text" aria-label="Name" value="${esc(p.name)}" autocomplete="off">
      <input id="pp-phone" type="tel" placeholder="WhatsApp number with country code" aria-label="Phone" value="${esc(p.phone || '')}">
    </div>
    <label class="daterow"><span>Due date</span><input id="pp-due" type="date" value="${p.due || ''}"></label>
    <p class="hint">Optional. While they owe you, the due date shows as “Due” and then “Overdue”.</p>
    <button class="primary full" data-a="ppSave">Save changes</button>
    <button class="ghost full" style="margin-top:8px" data-a="ppClearDue">Clear due date</button>
    <p class="hint" id="smsg"></p>`;
  showSheet('#pp-name');
}
function openQrPanel(amount) {
  if (!upiOk()) { showToast('Add your UPI ID in More first'); return; }
  const amt = Math.round(amount * 100) / 100;
  $('#sheet-body').innerHTML = `
    <h2>Scan to pay</h2>
    <div class="qrcard"><canvas id="qr" aria-label="Payment QR code"></canvas></div>
    <p class="qrinfo"><b>${esc(S.upi.name || S.upi.vpa)}</b><br>${esc(S.upi.vpa)}${amt > 0 ? `<br><span class="num" style="font-size:22px;font-weight:700">${inr(amt)}</span>` : ''}</p>
    <button class="primary full" data-a="qrShare">Share QR image</button>
    <p class="hint">Works with any UPI app. Check the name and amount before you share it.</p>`;
  const cv = $('#qr');
  if (!drawQr(cv, upiLink(amt)) && !drawQr(cv, upiLink(amt, false))) {
    $('#sheet-body').innerHTML = '<h2>Scan to pay</h2><p class="empty">That UPI ID is too long to fit in a QR code.</p>';
  }
  showSheet();
}
function openStatementPanel() {
  const p = curPerson(); if (!p) return;
  $('#sheet-body').innerHTML = `
    <h2>Statement</h2>
    <div class="stmt"><canvas id="st-canvas" aria-label="Statement for ${esc(p.name)}"></canvas></div>
    <div class="pair">
      <button class="primary" data-a="stShareImg">Share image</button>
      <button class="ghost" data-a="stShareText">Share text</button>
    </div>`;
  drawStatement($('#st-canvas'), p);
  showSheet();
}
function closeSheet() {
  if (!sheetOpen()) return;
  const token = ++sheetToken, s = $('#sheet'), sc = $('#scrim');
  s.style.transition = ''; s.style.transform = '';
  s.classList.remove('open'); sc.classList.remove('open');
  if (document.activeElement) document.activeElement.blur();
  setTimeout(() => { if (token === sheetToken) { s.hidden = true; sc.hidden = true; } }, 340);
  $('#fab').classList.toggle('show', view.tab === 'home');
}
// drag the sheet down to close it
let drag = null;
const sheetEl = $('#sheet');
sheetEl.addEventListener('pointerdown', e => {
  if (!e.target.closest('.grab')) return;
  drag = { y: e.clientY, id: e.pointerId };
  sheetEl.setPointerCapture(e.pointerId); sheetEl.style.transition = 'none';
});
sheetEl.addEventListener('pointermove', e => {
  if (drag && e.pointerId === drag.id) sheetEl.style.transform = `translateY(${Math.max(0, e.clientY - drag.y)}px)`;
});
const endDrag = e => {
  if (!drag || e.pointerId !== drag.id) return;
  const dy = e.clientY - drag.y; drag = null;
  sheetEl.style.transition = '';
  if (dy > 90) closeSheet(); else sheetEl.style.transform = '';
};
sheetEl.addEventListener('pointerup', endDrag);
sheetEl.addEventListener('pointercancel', endDrag);
$('#scrim').addEventListener('click', closeSheet);

// ---------- swipe to delete ----------
let sw = null, swiped = false;
const THRESH = 110;
document.addEventListener('pointerdown', e => {
  const row = e.target.closest('.swipe .line');
  if (!row || e.target.closest('button,a,input')) return;
  sw = { row, wrap: row.parentElement, x: e.clientX, y: e.clientY, dx: 0, on: false, id: e.pointerId, crossed: false };
});
document.addEventListener('pointermove', e => {
  if (!sw || e.pointerId !== sw.id) return;
  const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
  if (!sw.on) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; }
    if (Math.abs(dx) <= 10) return;
    sw.on = true; sw.row.setPointerCapture(e.pointerId);
    sw.wrap.classList.add('dragging'); sw.row.style.transition = 'none';
  }
  sw.dx = Math.min(0, dx);
  sw.row.style.transform = `translateX(${sw.dx}px)`;
  sw.wrap.style.setProperty('--p', Math.min(1, -sw.dx / THRESH));
  const crossed = -sw.dx > THRESH;
  if (crossed && !sw.crossed) buzz(15);
  sw.crossed = crossed; sw.wrap.classList.toggle('armed', crossed);
});
const endSwipe = e => {
  if (!sw || e.pointerId !== sw.id) return;
  const s = sw; sw = null;
  if (!s.on) return;
  swiped = true; setTimeout(() => { swiped = false; }, 60);
  s.row.style.transition = '';
  if (s.crossed) {
    s.row.style.transform = 'translateX(-110%)';
    setTimeout(() => A[s.wrap.dataset.swipe]({ id: s.wrap.dataset.id }), 200);
  } else {
    s.row.style.transform = ''; s.wrap.classList.remove('dragging', 'armed'); s.wrap.style.setProperty('--p', 0);
  }
};
document.addEventListener('pointerup', endSwipe);
document.addEventListener('pointercancel', endSwipe);
document.addEventListener('click', e => { if (swiped) { e.stopPropagation(); e.preventDefault(); } }, true);

// ---------- actions ----------
const A = {
  tab: d => { closeSheet(); go(() => { view = { tab: d.tab, pid: null, confirmDel: false, focus: null }; }); },
  openSheet: () => openSheet(),
  addTx() {
    const text = $('#q').value;
    if (sh.mode === 'edit') {
      const r = parseOne(text);
      if (!r) return say('Include an amount, for example “Chai 20”.', 'smsg');
      const t = S.tx.find(x => x.id === sh.id); if (!t) return closeSheet();
      const type = sh.typeManual ? sh.type : r.type;
      Object.assign(t, { amt: r.amt, note: r.note, type, cat: type === 'inc' ? 'income' : (sh.catManual ? sh.cat : guessCat(r.note)), ts: tsFor(dateFor(r, sh.date), t.ts) });
      db.put('tx', t); lastAdded = t.id; hv.mo = offsetOf(t.ts);
    } else {
      const list = parseMany(text);
      if (!list.length) return say('Include an amount, for example “Chai 20”.', 'smsg');
      const added = list.map(r => {
        const type = sh.typeManual ? sh.type : r.type;
        const t = { id: uid(), type, cat: type === 'inc' ? 'income' : (sh.catManual ? sh.cat : guessCat(r.note)), amt: r.amt, note: r.note, ts: tsFor(dateFor(r, sh.date)) };
        S.tx.push(t); db.put('tx', t); return t;
      });
      lastAdded = added[0].id; hv.mo = offsetOf(Math.max(...added.map(t => t.ts)));
      if (added.length > 1) showToast(`Added ${added.length} entries`, () => {
        added.forEach(t => { S.tx = S.tx.filter(x => x.id !== t.id); db.del('tx', t.id); }); render();
      });
    }
    buzz(12); hv.cat = 'all'; hv.q = '';
    $('#q').value = ''; closeSheet(); render();
  },
  delTx(d) {
    const t = S.tx.find(x => x.id === d.id); if (!t) return;
    S.tx = S.tx.filter(x => x.id !== d.id); db.del('tx', d.id); render();
    showToast('Entry deleted', () => { S.tx.push(t); db.put('tx', t); render(); });
  },
  editTx(d) {
    const t = S.tx.find(x => x.id === d.id); if (!t) return;
    openSheet({ id: t.id, type: t.type, cat: t.cat || guessCat(t.note), typeManual: true, catManual: true, date: ymd(t.ts), text: `${t.note} ${t.amt}` });
  },
  setType(d) { sh.type = d.type; sh.typeManual = true; renderCtl(); renderPreview(); },
  setCat(d) { sh.cat = d.cat; sh.catManual = true; renderCtl(); renderPreview(); },
  mo(d) { go(() => { hv.mo = Math.min(0, hv.mo + Number(d.d)); }); },
  catJump(d) { hv.cat = d.cat; hv.q = ''; closeSheet(); go(() => { view = { tab: 'home', pid: null, confirmDel: false, focus: null }; }); },
  moJump(d) { go(() => { hv.mo = Number(d.off); }); },
  filt(d) { hv.cat = d.cat; render(); },
  saveBudget() {
    const v = parseFloat($('#bud').value);
    S.budget = v > 0 ? v : 0; db.put('meta', { id: 'budget', total: S.budget });
    showToast(S.budget ? 'Budget saved' : 'Budget turned off');
  },
  editEntry(d) { openEntrySheet(d.id); },
  peDir(d) { pe.dir = d.dir; document.querySelectorAll('#sheet .seg button').forEach(b => b.classList.toggle('on', b.dataset.dir === pe.dir)); },
  peSave() {
    const amt = parseFloat($('#pe-amt').value);
    if (!(amt > 0)) return say('Enter an amount greater than 0.', 'smsg');
    const p = curPerson(), e = p && p.entries.find(x => x.id === pe.id); if (!e) return closeSheet();
    e.dir = pe.dir; e.amt = amt; e.note = $('#pe-note').value.trim(); e.ts = tsFor($('#pe-date').value || today(), e.ts);
    db.put('people', p); buzz(12); lastAdded = e.id; closeSheet(); render();
  },
  editPerson() { openPersonSheet(); },
  ppClearDue() { $('#pp-due').value = ''; },
  ppSave() {
    const name = $('#pp-name').value.trim();
    if (!name) return say('Enter a name.', 'smsg');
    const p = curPerson(); if (!p) return closeSheet();
    p.name = name; p.phone = $('#pp-phone').value.trim(); p.due = $('#pp-due').value || '';
    db.put('people', p); closeSheet(); render();
  },
  statement() { openStatementPanel(); },
  stShareImg() { shareCanvas($('#st-canvas'), 'statement.png'); },
  stShareText() { const p = curPerson(); if (p) shareText(statementText(p)); },
  payQr(d) { openQrPanel(Number(d.amt) || 0); },
  myQr() { openQrPanel(0); },
  qrShare() { shareCanvas($('#qr'), 'payment-qr.png'); },
  saveUpi() {
    const vpa = $('#upi-id').value.trim(), name = $('#upi-name').value.trim();
    if (vpa && !UPI_RE.test(vpa)) return showToast('That UPI ID does not look right');
    S.upi = { vpa, name }; db.put('meta', { id: 'upi', vpa, name });
    showToast(vpa ? 'Payment details saved' : 'Payment details cleared'); render();
  },
  quickLedger() {
    const r = parseLedgerLine($('#lq').value, S.people.map(p => ({ id: p.id, name: p.name })));
    if (r.error === 'person') return say(S.people.length ? 'I could not find that name. Check the spelling, or add the person first.' : 'Add a person first, then use quick entry.', 'lmsg');
    if (r.error === 'amount') return say('Include an amount, for example “Rahul ko 500 diye”.', 'lmsg');
    if (r.error === 'direction') return say('Add “diye” (you gave) or “mile” (you got).', 'lmsg');
    const p = S.people.find(x => x.id === r.id);
    const e = { id: uid(), dir: r.dir, amt: r.amt, note: r.note, ts: tsFor(dateFor(r, today())) };
    p.entries.push(e); db.put('people', p); buzz(12); lastAdded = e.id; $('#lq').value = ''; render();
    showToast(`${r.dir === 'gave' ? 'You gave' : 'You got'} ${inr(r.amt)} ${r.dir === 'gave' ? 'to' : 'from'} ${p.name}`,
      () => { p.entries = p.entries.filter(x => x.id !== e.id); db.put('people', p); render(); });
  },
  addPerson() {
    const name = $('#pname').value.trim();
    if (!name) return say('Enter a name first.');
    const p = { id: uid(), name, phone: $('#pphone').value.trim(), entries: [] };
    S.people.push(p); db.put('people', p); go(() => { view.pid = p.id; view.confirmDel = false; });
  },
  open(d, el) {
    if (el) el.style.viewTransitionName = 'person';
    go(() => { view.pid = d.id; view.confirmDel = false; });
  },
  back: () => go(() => { view.focus = view.pid; view.pid = null; view.confirmDel = false; }),
  entry(d) {
    const amt = parseFloat($('#amt').value);
    if (!amt || amt <= 0) return say('Enter an amount greater than 0.');
    const p = S.people.find(x => x.id === view.pid);
    const e = { id: uid(), dir: d.dir, amt, note: $('#note').value.trim(), ts: tsFor($('#edate').value || today()) };
    p.entries.push(e); db.put('people', p); buzz(12); lastAdded = e.id; render();
  },
  delEntry(d) {
    const p = S.people.find(x => x.id === view.pid);
    const e = p.entries.find(x => x.id === d.id); if (!e) return;
    p.entries = p.entries.filter(x => x.id !== d.id); db.put('people', p); render();
    showToast('Entry deleted', () => { p.entries.push(e); db.put('people', p); render(); });
  },
  askDel: () => { view.confirmDel = true; render(); },
  delPerson() {
    const p = S.people.find(x => x.id === view.pid);
    S.people = S.people.filter(x => x.id !== view.pid); db.del('people', view.pid);
    go(() => { view = { tab: 'ledger', pid: null, confirmDel: false, focus: null }; });
    showToast(`${p.name} deleted`, () => { S.people.push(p); db.put('people', p); render(); });
  },
  lang: () => { lang = lang === 'en-IN' ? 'hi-IN' : 'en-IN'; renderSheet(); $('#q').focus(); },
  mic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) return;
    const r = new SR(); r.lang = lang; r.interimResults = false;
    r.onresult = ev => { $('#q').value = ev.results[0][0].transcript; $('#q').dispatchEvent(new Event('input', { bubbles: true })); say('Check the entry, then tap Add entry.', 'smsg'); };
    r.onerror = () => say('Could not hear that. Check microphone permission and try again.', 'smsg');
    r.onend = () => { listening = false; renderSheet(); };
    listening = true; renderSheet(); r.start();
  },
  export() {
    const data = { app: 'hisaab', version: 1, exportedAt: new Date().toISOString(), tx: S.tx, people: S.people, meta: [{ id: 'budget', total: S.budget }, { id: 'upi', vpa: S.upi.vpa, name: S.upi.name }] };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = `hisaab-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('Backup file saved');
  },
  async install() { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; render(); }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]');
  if (el && A[el.dataset.a]) A[el.dataset.a](el.dataset, el);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') return closeSheet();
  if (e.key !== 'Enter') return;
  if (e.target.dataset && (e.target.dataset.a === 'editTx' || e.target.dataset.a === 'editEntry')) return A[e.target.dataset.a](e.target.dataset);
  if (e.target.id === 'q') A.addTx();
  if (e.target.id === 'pname') A.addPerson();
  if (e.target.id === 'lq') A.quickLedger();
});
document.addEventListener('change', async e => {
  if (e.target.id !== 'imp' || !e.target.files[0]) return;
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (!Array.isArray(data.tx) || !Array.isArray(data.people)) throw new Error('bad file');
    if (!confirm(`Replace everything on this phone with the backup (${data.tx.length} entries, ${data.people.length} people)?`)) return;
    await db.replaceAll(data); const bm = (data.meta || []).find(m => m.id === 'budget'), um = (data.meta || []).find(m => m.id === 'upi');
    S = { tx: data.tx, people: data.people, budget: bm ? bm.total : 0, upi: um ? { vpa: um.vpa || '', name: um.name || '' } : { vpa: '', name: '' } };
    render(); showToast('Backup restored');
  } catch (err) { showToast('That file is not a Hisaab backup'); }
  e.target.value = '';
});
document.addEventListener('input', e => {
  if (e.target.id === 'search') { hv.q = e.target.value; $('#list').innerHTML = listHTML(); }
  else if (e.target.id === 'q') {
    const txt = e.target.value, list = parseMany(txt);
    if (list.length > 1) { renderPreview(); return; }
    const type = list.length ? list[0].type : (INC_RE.test(txt) ? 'inc' : 'exp');
    const g = list.length ? guessCat(list[0].note) : guessCat(txt);
    let changed = false;
    if (!sh.typeManual && sh.type !== type) { sh.type = type; changed = true; }
    if (!sh.catManual && sh.cat !== g) { sh.cat = g; changed = true; }
    if (changed) renderCtl();
    renderPreview();
  }
});
document.addEventListener('change', e => { if (e.target.id === 'qdate') sh.date = e.target.value || today(); });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (view.tab === 'more') render(); });

// ---------- start ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
render();
Promise.all([db.all('tx'), db.all('people'), db.all('meta')]).then(([tx, people, meta]) => {
  const b = meta.find(m => m.id === 'budget'), u = meta.find(m => m.id === 'upi');
  S = { tx, people, budget: b ? b.total : 0, upi: u ? { vpa: u.vpa || '', name: u.name || '' } : { vpa: '', name: '' } }; countUp = true; render();
});
