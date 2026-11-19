// Apple Notes "Medicum, …" notes: records whose projected (last) date belongs in a later
// month are cut from their month and pasted under that month, next to the patients with the
// same projected date. Pure functions on the notes' HTML (notes-mover.js reads and writes Notes).
//
// A note:   title (h1) · month headings ("01 March to 31 March 2027") · day headings
//           ("3 October") · record lines ("Name 12345, 30 mg x 2, …, 3 October 2026, 20 March 2027")
// Notes are grouped two months per note: January - February, March - April, … (October 2026
// is a one-month note; existing notes are always used first).

const MONTHS = { january: 0, janvier: 0, jan: 0, february: 1, fevrier: 1, février: 1, feb: 1, march: 2, mars: 2, mar: 2,
  april: 3, avril: 3, apr: 3, may: 4, mai: 4, june: 5, juin: 5, jun: 5, july: 6, juillet: 6, jul: 6,
  august: 7, aout: 7, août: 7, aug: 7, september: 8, septembre: 8, sep: 8, sept: 8, october: 9, octobre: 9, oct: 9,
  november: 10, novembre: 10, nov: 10, december: 11, decembre: 11, décembre: 11, dec: 11 };
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const month = s => MONTHS[String(s || '').toLowerCase()];
const ym = (y, m) => y * 12 + m;
const DATE_RE = /(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\.?\s+(\d{4})/g;

export function textOf(html) {
  return String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

// "Medicum, November - December 2026" → [{y:2026,m:10},{y:2026,m:11}]
export function notePeriod(title) {
  if (!/^\s*medicum\b/i.test(title)) return null;
  const parts = [...String(title).matchAll(/([A-Za-zÀ-ÿ]+)\s*(\d{4})?/g)].map(x => ({ m: month(x[1]), y: x[2] ? +x[2] : null })).filter(x => x.m !== undefined);
  if (!parts.length) return null;
  const year = [...parts].reverse().find(x => x.y)?.y;
  if (!year) return null;
  const out = parts.map(x => ({ m: x.m, y: x.y || year }));
  // "November - December 2026" fine; "December - January 2027" → December 2026
  for (let i = out.length - 2; i >= 0; i--) if (!parts[i].y && ym(out[i].y, out[i].m) > ym(out[i + 1].y, out[i + 1].m)) out[i].y--;
  return out;
}

// The note a month belongs in when none exists yet: two months per note
export function newNoteTitle(y, m) {
  const a = m - (m % 2);
  return `Medicum, ${MONTH_NAMES[a]} ${y} - ${MONTH_NAMES[a + 1]} ${y}`;
}
const lastDay = (y, m) => new Date(y, m + 1, 0).getDate();
export const monthHeading = (y, m) => `01 ${MONTH_NAMES[m]} to ${lastDay(y, m)} ${MONTH_NAMES[m]} ${y}`;

// Top-level blocks of a note's HTML (Notes writes flat <h1>/<h2>/<div>/<ul> elements)
export function blocks(html) {
  const out = [], re = /<(\/?)(h1|h2|h3|div|ul|ol|p|table)\b[^>]*>/gi;
  let depth = 0, start = 0, m, open = null;
  while ((m = re.exec(html))) {
    if (!m[1]) { if (depth === 0) { if (m.index > start && html.slice(start, m.index).trim()) out.push(html.slice(start, m.index)); start = m.index; open = m[2].toLowerCase(); } depth++; }
    else { depth--; if (depth === 0) { out.push(html.slice(start, re.lastIndex)); start = re.lastIndex; open = null; } }
  }
  if (html.slice(start).trim()) out.push(html.slice(start));
  return out.map(h => ({ html: h, tag: (h.match(/^<(\w+)/) || [])[1]?.toLowerCase() || '', text: textOf(h) }));
}

// What a block is
export function kindOf(b) {
  const t = b.text;
  if (!t) return 'blank';
  if (b.tag === 'h1') return 'title';
  // "01 March to 31 March 2027", "1 November- 30 November", "1 December to 31 December 2026"
  const mh = t.match(/^(\d{1,2})\s*([A-Za-zÀ-ÿ]+)\s*(?:to|-|–|au|à)\s*(\d{1,2})\s*([A-Za-zÀ-ÿ]+)\s*(\d{4})?$/i);
  if (mh && month(mh[2]) !== undefined && month(mh[4]) === month(mh[2])) return 'month';
  const dh = t.match(/^(\d{1,2})\s+([A-Za-zÀ-ÿ]+)(\s+\d{4})?$/);
  if (dh && month(dh[2]) !== undefined) return 'day';
  if (/^.+?\s\d{3,6}\s*,/.test(t)) return 'record';
  return 'other';
}

// A record line: file number, initials, its dates in the order written, the projected (last) one
export function readRecord(text) {
  const r = text.match(/^(.+?)\s+(\d{3,6})\s*,/);
  if (!r) return null;
  const dates = [...text.matchAll(DATE_RE)].map(x => ({ y: +x[3], m: month(x[2]), d: +x[1] })).filter(x => x.m !== undefined && x.d >= 1 && x.d <= 31);
  const initials = r[1].split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join('');
  return { file: r[2], initials, dates };
}
const dkey = x => x.y * 10000 + (x.m + 1) * 100 + x.d;
export const fmtDate = x => `${x.d} ${MONTH_NAMES[x.m]} ${x.y}`;

// One note → sections: each record with the month it sits in (from the month or day heading above it)
export function parseNote(title, html) {
  const period = notePeriod(title) || [];
  const bs = blocks(html).map(b => ({ ...b, kind: kindOf(b) }));
  let cur = period.length === 1 ? period[0] : null;   // a one-month note: everything is that month
  const yearFor = m => (period.find(p => p.m === m) || {}).y ?? (period[period.length - 1] || {}).y;
  for (const b of bs) {
    if (b.kind === 'month' || b.kind === 'day') {
      const mm = b.text.match(/^\d{1,2}\s*([A-Za-zÀ-ÿ]+)/);
      const m = month(mm[1]), yy = b.text.match(/(\d{4})\s*$/);
      cur = { m, y: yy ? +yy[1] : yearFor(m) };
      b.month = cur;
    } else if (b.kind === 'record') {
      b.rec = readRecord(b.text);
      b.month = cur;
    }
  }
  return { title, period, blocks: bs };
}

// Which note a month goes into: an existing note covering it, else the new two-month note
export function noteFor(notes, y, m) {
  return notes.find(n => n.period.some(p => p.y === y && p.m === m)) || null;
}

// The plan: moves (record → target note/month) and records left for you, for every month that
// ended at least `waitDays` ago and isn't done/held. Nothing is changed here.
export function planMoves(notes, { now = new Date(), waitDays = 10, skip = () => false, from = null } = {}) {
  const moves = [], left = [], months = new Set();
  const nowKey = ym(now.getFullYear(), now.getMonth());
  for (const n of notes) {
    for (const b of n.blocks) {
      if (b.kind !== 'record' || !b.month) continue;
      const { y, m } = b.month;
      const end = new Date(y, m + 1, 0); end.setDate(end.getDate() + waitDays);
      if (now < end) continue;                                  // month not over (+10 days) yet
      if (from && ym(y, m) < from) continue;                    // before the mover was set up
      const mk = `${y}-${String(m + 1).padStart(2, '0')}`;
      if (skip(mk)) continue;
      months.add(mk);
      const r = b.rec, id = r ? `#${r.file} ${r.initials}` : b.text.slice(0, 20);
      const why = reason => left.push({ month: mk, note: n.title, id, file: r?.file, why: reason });
      if (!r || !r.dates.length) { why('no dates'); continue; }
      const last = r.dates[r.dates.length - 1];
      if (r.dates.some(d => dkey(d) > dkey(last))) { why("last date isn't the latest"); continue; }
      if (ym(last.y, last.m) <= ym(y, m)) { why(`no projected date after ${MONTH_NAMES[m]}`); continue; }
      if (ym(last.y, last.m) < nowKey) { why(`projected date ${fmtDate(last)} already passed`); continue; }
      const target = noteFor(notes, last.y, last.m);
      const tTitle = target ? target.title : newNoteTitle(last.y, last.m);
      if (target && target.blocks.some(t => t.kind === 'record' && t.rec?.file === r.file && t !== b)) { why(`already in ${tTitle}`); continue; }
      moves.push({ month: mk, from: n.title, to: tTitle, create: !target, id, file: r.file, date: last, block: b });
    }
  }
  return { moves, left, months: [...months].sort() };
}

// A record as its own line (a one-line list item becomes a plain line, as you agreed)
function asLine(b) {
  if (b.tag === 'div') return b.html;
  const inner = b.html.replace(/^<ul[^>]*>\s*<li[^>]*>/i, '').replace(/<\/li>\s*<\/ul>\s*$/i, '');
  return `<div>${inner}</div>`;
}
const BLANK = '<div><br></div>';

// Cut: the record's block and one blank line next to it (so gaps don't pile up)
export function removeRecords(html, files) {
  const bs = blocks(html).map(b => ({ ...b, kind: kindOf(b) }));
  const drop = new Set();
  bs.forEach((b, i) => {
    if (b.kind !== 'record' || !files.has(readRecord(b.text)?.file)) return;
    drop.add(i);
    if (bs[i - 1]?.kind === 'blank' && bs[i + 1]?.kind === 'blank' && !drop.has(i - 1)) drop.add(i + 1);
  });
  return bs.filter((_, i) => !drop.has(i)).map(b => b.html).join('');
}

// Paste: under the month heading, after the patients with the same projected date (in date order);
// the heading is added if the note doesn't have it yet
export function insertRecords(html, title, items) {
  let bs = blocks(html).map(b => ({ ...b, kind: kindOf(b) }));
  const period = notePeriod(title) || [];
  for (const it of [...items].sort((a, b) => dkey(a.date) - dkey(b.date))) {
    const { y, m } = it.date;
    // a day heading for that date ("20 March"): under it, after its patients
    const dh = bs.findIndex(b => b.kind === 'day' && (() => { const x = b.text.match(/^(\d{1,2})\s+([A-Za-zÀ-ÿ]+)/); return +x[1] === it.date.d && month(x[2]) === m; })());
    if (dh >= 0) {
      let at = dh + 1;
      for (let i = dh + 1; i < bs.length && !['day', 'month'].includes(bs[i].kind); i++) if (bs[i].kind === 'record') at = i + 1;
      if (at === dh + 1) while (at < bs.length && bs[at].kind === 'blank') at++;
      bs.splice(at, 0, { html: asLine(it.block), tag: 'div', text: it.block.text, kind: 'record' });
      continue;
    }
    // the month's section: its heading … up to the next month heading
    let h = bs.findIndex(b => b.kind === 'month' && month(b.text.match(/^\d{1,2}\s*([A-Za-zÀ-ÿ]+)/)[1]) === m);
    if (h < 0) {
      // add the heading after the earlier months' sections (or after the title)
      let at = bs.length;
      const later = bs.findIndex(b => b.kind === 'month' && ym(...yOf(b, period)) > ym(y, m));
      if (later >= 0) at = later;
      const add = [{ html: `<h2>${monthHeading(y, m)}</h2>`, tag: 'h2', text: monthHeading(y, m), kind: 'month' }, { html: BLANK, tag: 'div', text: '', kind: 'blank' }];
      if (at === bs.length && bs.length && bs[bs.length - 1].kind !== 'blank') add.unshift({ html: BLANK, tag: 'div', text: '', kind: 'blank' });
      bs.splice(at, 0, ...add);
      h = bs.findIndex(b => b.kind === 'month' && b.text === monthHeading(y, m));
    }
    let end = bs.findIndex((b, i) => i > h && b.kind === 'month');
    if (end < 0) end = bs.length;
    const line = { html: asLine(it.block), tag: 'div', text: it.block.text, kind: 'record' };
    const k = dkey(it.date);
    const recs = [];
    for (let i = h + 1; i < end; i++) if (bs[i].kind === 'record') { const r = readRecord(bs[i].text); const d = r?.dates[r.dates.length - 1]; recs.push({ i, k: d ? dkey(d) : 0 }); }
    const same = recs.filter(r => r.k === k);
    if (same.length) { bs.splice(same[same.length - 1].i + 1, 0, line); continue; }        // with its group
    const before = recs.filter(r => r.k < k);
    if (before.length) { bs.splice(before[before.length - 1].i + 1, 0, { html: BLANK, tag: 'div', text: '', kind: 'blank' }, line); continue; }
    const after = recs[0];
    if (after) { bs.splice(after.i, 0, line, { html: BLANK, tag: 'div', text: '', kind: 'blank' }); continue; }
    let at = h + 1;
    while (at < end && bs[at].kind === 'blank') at++;
    bs.splice(at, 0, line, { html: BLANK, tag: 'div', text: '', kind: 'blank' });
  }
  return bs.map(b => b.html).join('');
}
function yOf(b, period) {
  const m = month(b.text.match(/^\d{1,2}\s*([A-Za-zÀ-ÿ]+)/)[1]);
  const yy = b.text.match(/(\d{4})\s*$/);
  return [yy ? +yy[1] : ((period.find(p => p.m === m) || {}).y ?? (period[period.length - 1] || {}).y), m];
}

// A new note's body: title + its two month headings
export function newNoteBody(title) {
  const p = notePeriod(title) || [];
  return `<h1>${title}</h1>${BLANK}${BLANK}` + p.map(x => `<h2>${monthHeading(x.y, x.m)}</h2>${BLANK}${BLANK}`).join('');
}
