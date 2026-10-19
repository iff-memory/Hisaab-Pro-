// Smart text understanding for Hisaab. Pure functions, no DOM, easy to test.
// Understands English and Hinglish: "chai 20", "kal petrol 500", "paanch sau rent", "2k salary",
// several entries in one line, pasted bank SMS, and ledger lines like "Rahul ko 500 diye".

const DEV = '०१२३४५६७८९';
const norm = t => String(t).replace(/[०-९]/g, d => DEV.indexOf(d)).replace(/[\u200c\u200d]/g, '');

export const INC_RE = /\b(aaye|aaya|aya|mila|mile|mili|got|received|salary|income|credited|refund|cashback|bonus|interest|deposited)\b|मिले|मिला|मिली|आए|आया|सैलरी|वेतन/i;

const CUR_RE = /\b(?:rs|inr)\.?(?=\d)|\b(?:rs|inr|rupees?|rupaye|rupay|rupiye|rupya)\b\.?|₹|\/-/gi;
const DATE_RE = /(^|\s)(kal|yesterday|parso|aaj|today|कल|परसों|आज)(?=\s|$|[.,;])/gi;

const NUM = new Map(Object.entries({
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chhah: 6, che: 6, saat: 7, aath: 8, nau: 9,
  das: 10, gyarah: 11, barah: 12, terah: 13, chaudah: 14, pandrah: 15, solah: 16, satrah: 17, atharah: 18, unnees: 19,
  bees: 20, pachees: 25, pacchis: 25, tees: 30, paintees: 35, chalis: 40, paintalis: 45, pachas: 50, pachpan: 55,
  saath: 60, painsath: 65, sattar: 70, pachattar: 75, assi: 80, pachasi: 85, nabbe: 90, pachanve: 95,
  dedh: 1.5, dhai: 2.5, dhaai: 2.5, sava: 1.25,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10,
  'बीस': 20, 'पच्चीस': 25, 'तीस': 30, 'चालीस': 40, 'पचास': 50, 'साठ': 60, 'सत्तर': 70, 'अस्सी': 80, 'नब्बे': 90,
  'डेढ़': 1.5, 'ढाई': 2.5, 'सवा': 1.25
}));
const MULT = new Map(Object.entries({
  sau: 100, hundred: 100, hazaar: 1000, hazar: 1000, hajar: 1000, thousand: 1000, lakh: 100000, lakhs: 100000, lac: 100000,
  'सौ': 100, 'हज़ार': 1000, 'हजार': 1000, 'लाख': 100000
}));

const prep = raw => norm(raw)
  .replace(/(\d)\s*(?:rs|inr)\b\.?/gi, '$1 ')
  .replace(CUR_RE, ' ');

function classify(tok) {
  const c = tok.toLowerCase().replace(/[.,:;!?]+$/g, '');
  if (/^\d[\d,]*(\.\d+)?k?$/.test(c)) return { k: 'D', v: parseFloat(c.replace(/,/g, '')) * (c.endsWith('k') ? 1000 : 1) };
  if (NUM.has(c)) return { k: 'W', v: NUM.get(c) };
  if (MULT.has(c)) return { k: 'M', v: MULT.get(c) };
  return null;
}

// Runs of number-ish tokens such as "5 hazaar", "do sau pachas", "12,500", "1.5k".
function findRuns(tokens) {
  const runs = []; let cur = null;
  tokens.forEach((t, i) => {
    const c = classify(t);
    if (!c) { cur = null; return; }
    const prev = cur && cur.items[cur.items.length - 1].k;
    const joins = cur && ((prev === 'D' && c.k === 'M') || (prev === 'W' && (c.k === 'W' || c.k === 'M')) || (prev === 'M' && (c.k === 'W' || c.k === 'D')));
    if (joins) { cur.end = i; cur.items.push(c); }
    else { cur = { start: i, end: i, items: [c] }; runs.push(cur); }
  });
  runs.forEach(r => {
    let total = 0, part = 0;
    r.items.forEach(({ k, v }) => {
      if (k === 'M') { if (v === 100) part = (part || 1) * 100; else { total += (part || 1) * v; part = 0; } }
      else part += v;
    });
    r.value = Math.round((total + part) * 100) / 100;
    r.valid = r.value > 0 && !(r.items.every(x => x.k === 'W') && r.value < 10);
  });
  return runs;
}

const clean = s => s.replace(/\s+/g, ' ').replace(/^[\s,;:\-]+|[\s,;:\-]+$/g, '');

/** One entry from text. Returns { amt, note, type, off } or null. off: day offset from a date word (kal = -1). */
export function parseOne(raw) {
  let text = prep(raw), off = null;
  text = text.replace(DATE_RE, (m, pre, w) => {
    const l = w.toLowerCase();
    off = (l === 'kal' || l === 'yesterday' || l === 'कल') ? -1 : (l === 'parso' || l === 'परसों') ? -2 : 0;
    return ' ';
  });
  const tokens = text.split(/\s+/).filter(Boolean);
  const run = findRuns(tokens).filter(r => r.valid).pop();
  if (!run) return null;
  const note = clean(tokens.filter((_, i) => i < run.start || i > run.end).join(' '));
  const income = INC_RE.test(text);
  return { amt: run.value, note: note || (income ? 'Money in' : 'Expense'), type: income ? 'inc' : 'exp', off };
}

/** A pasted bank SMS such as "Rs 250 debited ... to VPA zomato@icici". Returns an entry or null. */
export function parseSms(raw) {
  const t = norm(raw).replace(/\s+/g, ' ').trim();
  if (t.length < 30) return null;
  const m = t.match(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!m) return null;
  const di = t.search(/\b(debited|debit|spent|paid|purchase|withdrawn|sent)\b/i);
  const ci = t.search(/\b(credited|credit|received|deposited|refund)\b/i);
  if (di < 0 && ci < 0) return null;
  const type = ci >= 0 && (di < 0 || ci < di) ? 'inc' : 'exp';
  const amt = parseFloat(m[1].replace(/,/g, ''));
  if (!(amt > 0)) return null;
  let note = '';
  const vpa = t.match(/\b([A-Za-z0-9._\-]{2,})@[A-Za-z]+(?![A-Za-z]|\.[A-Za-z])/);
  if (vpa) note = vpa[1];
  else {
    const mm = t.match(/\b(?:at|to|from|by|info:?)\s+(?!a\/c|ac\b|account|your|you\b|the\b)([A-Za-z0-9&.' \-]{2,30}?)(?=\s+(?:on|ref|upi|avl|bal|via|using|txn|call|not|if|is|was|for|a\/c)\b|[.,;(]|$)/i);
    if (mm) note = mm[1];
  }
  note = clean(note.replace(/\b(pvt|ltd|limited)\b/gi, '').replace(/[._]+/g, ' '));
  return { amt, note: note || 'Bank SMS', type, off: null };
}

// "chai 20 samosa 30" (what voice typing produces): split after each amount.
function chunksByAmount(raw) {
  const tokens = prep(raw).split(/\s+/).filter(Boolean);
  const runs = findRuns(tokens).filter(r => r.valid);
  if (runs.length < 2 || runs.some(r => r.value < 5)) return null;
  const out = []; let start = 0;
  runs.forEach((r, i) => {
    const end = i === runs.length - 1 ? tokens.length - 1 : r.end;
    out.push(tokens.slice(start, end + 1).join(' ')); start = end + 1;
  });
  return out;
}

/** Everything typed in the add sheet: one or several entries. Returns an array (empty if no amount found). */
export function parseMany(raw) {
  const sms = parseSms(raw);
  if (sms) return [sms];
  const parts = String(raw).split(/\s*(?:[;\n]|,(?=\D))\s*/).filter(s => s.trim());
  if (parts.length > 1) {
    const items = parts.map(parseOne);
    if (items.every(Boolean)) return items;
  }
  const chunks = chunksByAmount(raw);
  if (chunks) {
    const items = chunks.map(parseOne);
    if (items.every(x => x && x.note !== 'Expense' && x.note !== 'Money in')) return items;
  }
  const one = parseOne(raw);
  return one ? [one] : [];
}

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const GOT_RE = /\b(mile|mila|mili|got|received|returned|return|wapas|vapas|lautaye|lauta|repaid)\b|मिले|मिला|वापस/i;
const GAVE_RE = /\b(diye|diya|diyo|gave|lent|bheje|bhej|ko)\b|दिए|दिया|(?:^|\s)को(?=\s|$)/i;
const FILLER_RE = /\b(ko|se|ne|diye|diya|diyo|mile|mila|mili|got|gave|received|returned|return|wapas|vapas|lent|lautaye|lauta|repaid|bheje|bhej)\b|दिए|दिया|मिले|मिला|वापस/gi;

/** "Rahul ko 500 diye" (you gave) or "Rahul se 300 mile" (you got). people: [{ id, name }]. */
export function parseLedgerLine(raw, people) {
  const t = norm(raw);
  const hay = ' ' + t.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ') + ' ';
  let best = null;
  people.forEach(p => {
    const nm = ' ' + p.name.toLowerCase().trim().replace(/\s+/g, ' ') + ' ';
    if (nm.trim() && hay.includes(nm) && (!best || nm.length > best.nm.length)) best = { ...p, nm };
  });
  if (!best) return { error: 'person' };
  const rest = t.replace(new RegExp(escRe(best.name.trim()), 'i'), ' ');
  const one = parseOne(rest);
  if (!one) return { error: 'amount' };
  const got = GOT_RE.test(rest), gave = GAVE_RE.test(rest);
  if (!got && !gave) return { error: 'direction' };
  const note = one.note === 'Expense' || one.note === 'Money in' ? '' : clean(one.note.replace(FILLER_RE, ' ').replace(/(^|\s)(को|से|ने)(?=\s|$)/g, ' '));
  return { id: best.id, name: best.name, amt: one.amt, dir: got ? 'got' : 'gave', note, off: one.off };
}
