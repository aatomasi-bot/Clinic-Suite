// Notes mover (lib/notesmove.js): made-up patients only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notePeriod, newNoteTitle, parseNote, planMoves, removeRecords, insertRecords, newNoteBody, textOf, blocks, kindOf } from '../lib/notesmove.js';

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

test('cut and paste: grouped with the same date, in date order, under the right heading', () => {
  const p = planMoves(notes(), { now: new Date(2026, 10, 19) });
  const files = new Set(p.moves.map(m => m.file));
  const src = removeRecords(october, files);
  assert.ok(!/3000[1245] /.test(textOf(src)) && /30003/.test(textOf(src)) && /30006/.test(textOf(src)) && /154 km/.test(textOf(src)), 'only moved lines cut');
  assert.ok(!src.includes(B + B + B), 'no piled-up gaps');

  const toMar = insertRecords(marApr, 'Medicum, March 2027 - April 2027', p.moves.filter(m => m.to.includes('March')));
  const order = textOf(toMar).match(/3000\d/g);
  assert.deepEqual(order, ['30007', '30002', '30004', '30008'], '20 March between 13 and 26 March, together');
  assert.ok(toMar.includes('<div><b>Test BETA 30002'), 'list item became a plain line, formatting kept');

  const toDec = insertRecords(novDec, 'Medicum, November - December 2026', p.moves.filter(m => m.to.includes('December')));
  assert.ok(textOf(toDec).indexOf('26 December') < textOf(toDec).indexOf('30001'), 'under the "26 December" day heading');

  const may = insertRecords(newNoteBody('Medicum, May 2027 - June 2027'), 'Medicum, May 2027 - June 2027', p.moves.filter(m => m.create));
  assert.match(textOf(may), /^Medicum, May 2027 - June 2027 01 May to 31 May 2027 Test EPSILON 30005.* 01 June to 30 June 2027$/);
});
