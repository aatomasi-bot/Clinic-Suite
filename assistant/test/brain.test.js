// Dubbi's brain: what Claude sees (no names, no streets), and checks on what comes back.
// Claude is replaced by a scripted function — no network, no subscription use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanQuestion, buildContext, parseBrain, withNames, cityOf } from '../lib/brain.js';
import { answerOne } from '../brain.js';

const patients = [
  { file_number: '35037', patient_name: 'Hélène TESTCASE', address: '325 Boul Deguire, Montreal, QC H4N 1N4', archived: false, pending: false, assignment_type: 'Permanent', dose_prescribed: '22.5', doses_remaining: 3, due_date: '2026-10-29', appointment_date_time: '2026-10-28T10:00', appointment_confirmed: true, phone1: '514-555-0100' },
  { file_number: '34451', patient_name: 'Kim Demopatient', address: '10 rue Test, Laval, QC', archived: true, due_date: '2026-11-20' },
  { file_number: '30001', patient_name: 'Jean Sample', address: '', archived: false, due_date: '2026-11-02' },
  { file_number: '30002', patient_name: 'Marc Sample', address: '', archived: false, due_date: '2026-11-03' },
];

test('names in the question become file numbers; nothing else identifying is sent', () => {
  assert.equal(cleanQuestion('When is Helene Testcase due?', patients), 'When is #35037 due?');
  assert.equal(cleanQuestion('when is hélène testcase due', patients), 'when is #35037 due');
  assert.equal(cleanQuestion('Is Demopatient on hold?', patients), 'Is #34451 on hold?');
  assert.match(cleanQuestion('What about Sample?', patients), /\(#30001 or #30002\)/, 'ambiguous name → both files');
  const q = cleanQuestion('Call Kim Demopatient at 514-555-0199, 10 rue Test', patients);
  assert.ok(!/Kim|Demopatient|555-0199|rue Test/.test(q), q);
  assert.equal(cleanQuestion('Who needs an appointment this week?', patients), 'Who needs an appointment this week?', 'ordinary questions untouched');
});

test('the data Claude sees: file numbers, dates, city — no names, streets or phones', () => {
  const ctx = buildContext({ patients, tasks: [{ kind: 'close_file', status: 'todo', file_number: '30001', created_at: '2026-10-25T10:00:00Z' }, { kind: 'new_patient', status: 'todo', file_number: '99999', is_test: true, created_at: '2026-10-25' }], now: new Date(2026, 9, 26) });
  for (const bad of ['Hélène', 'TESTCASE', 'Kim', 'Deguire', '325', '514-555', 'H4N']) assert.ok(!ctx.includes(bad), bad);
  assert.match(ctx, /#35037 \| active \| permanent \| 22\.5 mg \| 3 \| 2026-10-29 \| 2026-10-28 10:00 \| yes \| no \| Montreal/);
  assert.match(ctx, /#34451 \| on hold/);
  assert.match(ctx, /#30001 \| file to close/);
  assert.ok(!ctx.includes('99999'), 'test cards are left out');
  assert.equal(cityOf('325 Boul Deguire, Apt 4, Montreal, QC H4N 1N4'), 'Montreal');
});

test('answers: strict JSON, known files only, allowed actions only, names put back for you', () => {
  const files = patients.map(p => p.file_number);
  const ok = parseBrain('```json\n{"say":"#35037 is due Thursday.","show":["35037","11111"],"action":{"type":"close_file","file":"30001"}}\n```', files);
  assert.deepEqual(ok.show, ['35037'], 'unknown file dropped');
  assert.deepEqual(ok.action, { type: 'close_file', file: '30001' });
  assert.equal(parseBrain('{"say":"Done","action":{"type":"delete_everything","file":"1"}}', files).action, null, 'unknown action dropped');
  assert.equal(parseBrain('not json', files), null);
  assert.equal(parseBrain('{"say":"Call 514-555-0000"}', files), null, 'no contact details');
  assert.equal(withNames('File #35037 is due; #35037 again.', patients), 'File #35037 (Hélène TESTCASE) is due; #35037 again.');
});

test('one question end to end (fake Claude)', async () => {
  let sent = '';
  const run = async p => { sent = p; return '{"say":"#35037 is due October 29 and is booked October 28, confirmed.","show":["35037"],"action":null}'; };
  const r = await answerOne({ ask: { question: 'When is Hélène Testcase due?' }, data: { patients, tasks: [], pending: [] }, run, now: new Date(2026, 9, 26) });
  assert.equal(r.status, 'answered');
  assert.match(r.answer.say, /^#35037 \(Hélène TESTCASE\) is due/);
  assert.ok(!/Hélène|TESTCASE|Deguire/i.test(sent), 'nothing identifying went to Claude');
  const bad = await answerOne({ ask: { question: 'x' }, data: { patients, tasks: [], pending: [] }, run: async () => { throw new Error('You have hit your usage limit'); } });
  assert.deepEqual(bad, { status: 'failed', answer: { error: 'Claude usage limit reached' } });
});

test('natural voice (Kokoro, on this Mac): reads names, not "number sign"', async () => {
  const { speakable } = await import('../lib/voice.js');
  assert.equal(speakable('#35037 (Hélène TESTCASE) is due Thursday 👍', false), 'Hélène TESTCASE is due Thursday');
  assert.equal(speakable('Le #35037 est dû jeudi — rien d’autre.', true), 'Le dossier 35037 est dû jeudi, rien d’autre.');
  const said = [];
  const tts = async (t, fr) => { said.push([t, fr]); return 'QUFD'; };
  const run = async () => '{"say":"#35037 is due Thursday.","show":[],"action":null}';
  const r = await answerOne({ ask: { question: 'When is Hélène Testcase due?', lang: 'fr' }, data: { patients, tasks: [], pending: [] }, run, tts });
  assert.equal(r.answer.audio, 'QUFD');
  assert.deepEqual(said, [['#35037 (Hélène TESTCASE) is due Thursday.', true]]);
  const act = await answerOne({ ask: { question: 'close 30001' }, data: { patients, tasks: [], pending: [] }, run: async () => '{"say":"Closing #30001.","show":[],"action":{"type":"close_file","file":"30001"}}', tts });
  assert.equal(act.answer.audio, undefined, 'Confirm cards are read separately');
});

test('the real Kokoro voice makes an iPhone-playable recording (skipped if not installed)', async t => {
  const { kokoroVoice, voiceInstalled } = await import('../lib/voice.js');
  if (!voiceInstalled()) return t.skip('voice not installed');
  const tts = kokoroVoice();
  const b64 = await tts('File 98001 is due Thursday.', false);
  const buf = Buffer.from(b64 || '', 'base64');
  assert.ok(buf.length > 5000, 'audio made');
  assert.equal(buf.subarray(4, 8).toString(), 'ftyp', 'an .m4a (AAC) file');
  const fr = await tts('Le dossier 98003 est en attente.', true);
  tts.close();
  assert.ok(fr && fr.length > 5000, 'French too');
});
