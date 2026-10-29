// Dubbi speed (Oct 29 2026): the text answer goes out before the voice is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerOne } from '../brain.js';

test('voiceLater: answer without waiting for the voice, marked so the phone waits for it', async () => {
  let made = 0;
  const tts = async () => { made++; return 'QUFD'; };
  const run = async () => '{"say":"#30001 is due Monday.","show":["30001"],"action":null}';
  const patients = [{ file_number: '30001', patient_name: 'Ann Test', due_date: '2026-11-02' }];
  const r = await answerOne({ ask: { question: 'when is 30001 due' }, data: { patients, tasks: [], pending: [] }, run, tts, voiceLater: true });
  assert.equal(r.status, 'answered');
  assert.equal(made, 0, 'no voice made before the text went out');
  assert.equal(r.answer.voice, 'pending');
  assert.equal(typeof r.answer.ms, 'number');
  const act = await answerOne({ ask: { question: 'close 30001' }, data: { patients, tasks: [], pending: [] }, run: async () => '{"say":"Closing #30001.","show":[],"action":{"type":"close_file","file":"30001"}}', tts, voiceLater: true });
  assert.equal(act.answer.voice, undefined, 'Confirm cards are read separately');
});
