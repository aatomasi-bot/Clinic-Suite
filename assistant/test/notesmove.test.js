// Notes mover (lib/notesmove.js): made-up patients only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notePeriod, newNoteTitle, parseNote, planMoves, whereIn, blocks, kindOf } from '../lib/notesmove.js';
import fs from 'node:fs';

const B = '<div><br></div>';
const rec = (name, file, dates, extra = '') => `<div><b>${name} ${file}, 30 mg x 2, </b>1 Rue Test, Montréal, QC, H1H 1H1, 514-555-0101, <b>left side, ${dates}${extra}</b></div>`;
const october = `<h1>Medicum, October 2026</h1>${B}<h2>1 October to 31 October</h2>${B}<div>3 October</div>${B}`
  + rec('Test ALPHA', '30001', '10 July 2026, 3 October 2026, 26 December 2026') + B
  + `<ul><li>${'<b>Test BETA 30002, 45 mg x 1, </b>2 Rue Test, right side, 21 Avril 2026, 3 October 2026, 20 March 2027'}</li></ul>` + B
  + rec('Test GAMMA', '30003', '3 October 2026') + B
  + rec('Test DELTA', '30004', '3 October 2026, 20 March 2027', ', no more repeats') + B
  + rec('Test EPSILON', '30005', '3 October 2026, 15 May 2027') + B
  + rec('Test ZETA', '30006', '20 March 2027, 3 October 2026') + B
  + `<div>154 km, 290 minutes</div>`;
const marApr = `<h1>Medicum, March 2027 - April 2027</h1>${B}<h2>01 March to 31 March 2027</h2>${B}${B}`
  + rec('Test ETA', '30007', '1 October 2026, 13 March 2027') + B
  + rec('Test THETA', '30008', '2 October 2026, 26 March 2027') + B;
const novDec = `<h1>Medicum, November - December 2026</h1>${B}<div>1 November- 30 November</div>${B}<div>2 November</div>`
  + rec('Test IOTA', '30009', '2 November 2026, 22 February 2027') + B + `<div>26 December</div>${B}`;
const notes = () => [parseNote('Medicum, October 2026', october), parseNote('Medicum, March 2027 - April 2027', marApr), parseNote('Medicum, November - December 2026', novDec)];

test('note titles → months; new notes two months at a time', () => {
  assert.deepEqual(notePeriod('Medicum, November - December 2026'), [{ m: 10, y: 2026 }, { m: 11, y: 2026 }]);
  assert.deepEqual(notePeriod('Medicum, January  2027 - February 2027'), [{ m: 0, y: 2027 }, { m: 1, y: 2027 }]);
  assert.deepEqual(notePeriod('Medicum, October 2026'), [{ m: 9, y: 2026 }]);
  assert.equal(notePeriod('On Hold Medicum'), null);
  assert.equal(newNoteTitle(2027, 4), 'Medicum, May 2027 - June 2027');
  assert.equal(newNoteTitle(2027, 5), 'Medicum, May 2027 - June 2027');
});

test('headings, records and other lines are told apart', () => {
  const k = h => kindOf(blocks(h)[0]);
  assert.equal(k('<h2>01 March to 31 March 2027</h2>'), 'month');
  assert.equal(k('<div>1 November- 30 November</div>'), 'month');
  assert.equal(k('<div>3 October</div>'), 'day');
  assert.equal(k(rec('Test A', '30001', '3 October 2026')), 'record');
  assert.equal(k('<div>154 km, 290 minutes</div>'), 'other');
});

test('waits until 10 days after the month; then plans moves and leaves doubtful records', () => {
  assert.equal(planMoves(notes(), { now: new Date(2026, 10, 9) }).moves.length, 0, 'before 10 November: nothing');
  const p = planMoves(notes(), { now: new Date(2026, 10, 19) });
  assert.deepEqual(p.months, ['2026-10']);
  assert.deepEqual(p.moves.map(m => [m.file, m.to, m.create]), [
    ['30001', 'Medicum, November - December 2026', false],
    ['30002', 'Medicum, March 2027 - April 2027', false],      // French "Avril" read; list item
    ['30004', 'Medicum, March 2027 - April 2027', false],      // "no more repeats" still moves
    ['30005', 'Medicum, May 2027 - June 2027', true],          // new note
  ]);
  assert.deepEqual(p.left.map(l => [l.file, l.why]), [['30003', 'no projected date after October'], ['30006', "last date isn't the latest"]]);
  assert.equal(planMoves(notes(), { now: new Date(2026, 10, 19), skip: mk => mk === '2026-10' }).moves.length, 0, 'held month');
});

test('the checklist says where each record goes (nothing is written to Notes)', () => {
  const ns = notes();
  const p = planMoves(ns, { now: new Date(2026, 10, 19) });
  const at = f => { const m = p.moves.find(x => x.file === f); return whereIn(ns.find(n => n.title === m.to), m.date); };
  assert.equal(at('30001'), 'under "26 December"');
  assert.equal(at('30002'), 'under "01 March to 31 March 2027", after #30007 TE');
  assert.match(at('30005'), /^new note/);
  assert.equal(whereIn(ns[1], { d: 13, m: 2, y: 2027 }), 'under "01 March to 31 March 2027", with the 13 March group (after #30007 TE)');
  assert.match(whereIn(ns[1], { d: 5, m: 3, y: 2027 }), /no "April" heading yet/);
});

test('the mover has no way to write to Notes', () => {
  const src = fs.readFileSync(new URL('../notes-mover.js', import.meta.url), 'utf8');
  assert.ok(!/set body|make new note|delete note|\bmove\b.*\bnote\b.*\bto\b/i.test(src.replace(/^\s*\/\/.*$/gm, '')), 'no Notes write commands');
});
