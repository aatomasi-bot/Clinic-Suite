// Dubbi's case brain: a patient's emails read together (lib/cases.js, case-brain.js).
// Claude is a scripted function — no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileNumbersIn, pdfPattern, learnedType, nameType, messageText, buildCase, parseCase } from '../lib/cases.js';
import { casePass } from '../case-brain.js';
import { patientUpdate } from '../lib/emailinfo.js';
import { emailLogRow } from '../intake.js';

const patient = { file_number: '98062', patient_name: 'Jean TESTOUX', archived: true, pending: false, assignment_type: 'Permanent', dose_prescribed: '45', doses_remaining: 4, due_date: '2026-10-29', appointment_date_time: '2026-10-31T13:30:00', appointment_confirmed: true };
const E = (id, date, from, subject, body, attachments = []) => ({ message_id: id, email_date: date, from_addr: from, from_name: from.startsWith('amelia') ? 'Amelia Gareau' : 'Medicum', subject, body, attachments, file_numbers: ['98062'] });
const emails = [
  E('<a>', '2026-10-21T19:57:54Z', 'ameliag@medicum.ca', 'Close File - CT 98062', 'Hello Abdul,\nPlease close the file of Mr. Jean TESTOUX (98062).'),
  E('<b>', '2026-10-30T13:57:35Z', 'no-reply@medicum.ca', 'New Appointment', 'Please find attached the enrollment form for new patient; Jean TESTOUX #98062.', [{ name: 'IMG_20220826_0001.pdf' }, { name: 'Jean TESTOUX 98062.pdf' }, { name: 'Enrollment_Form_Auto_Generated_14805.pdf' }]),
  E('<c>', '2026-10-30T13:58:13Z', 'ameliag@medicum.ca', 'ASAP - CT 98062', "Hello Abdul,\nThe doctor says he is to continue injections (file 98062). Please call him at 514-555-0101 to schedule him ASAP.\nHe was due October 29th 2026.\nThank you\nAmelia Gareau\nCoordonnatrice aux patients"),
  E('<d>', '2026-10-30T15:45:25Z', 'ameliag@medicum.ca', 'Re: ASAP - CT 98062', 'Hello Abdul,\nMr. Jean TESTOUX (98062) may not be reachable, he is to travel in Morocco for one month.\n\nFrom: Abdul\nSent: today\nold quoted text 12345'),
  E('<e>', '2026-10-30T16:17:39Z', 'reports@medicum.ca', 'fax - CT #98062', 'Please find attached a copy of the prescription. Next injection scheduled for: 31st October 2026', [{ name: 'FAX_20261030_1793373663_895.pdf' }]),
];

test('file numbers: never a year, a phone part or a fax id', () => {
  assert.deepEqual(fileNumbersIn('He was due October 29th 2026. Call 514-667-9987. File 34335 and #20062'), ['34335', '20062']);
  assert.deepEqual(fileNumbersIn('FAX_20261030_1793373663_895.pdf on 2026-10-30'), []);
  assert.deepEqual(fileNumbersIn('Patient LB 34335'), ['34335']);
});

test('PDFs: known by name, learned from you, generalised past the patient name', () => {
  assert.equal(nameType('FAX_20261030_1.pdf'), 'prescription');
  assert.equal(nameType('Enrollment_Form_Auto_Generated_14805.pdf'), 'enrollment');
  assert.equal(nameType('IMG_20220826_0001.pdf'), '');
  assert.equal(pdfPattern('Jean TESTOUX 98062.pdf', ['Jean TESTOUX']), 'name name #.pdf');
  const memory = [{ key: 'pdfp:' + pdfPattern('Jean TESTOUX 98062.pdf', ['Jean TESTOUX']), value: 'prescription' }, { key: 'pdf:img_20220826_0001.pdf', value: 'old_copy' }];
  assert.equal(learnedType('Marc TREMBLAY 30001.pdf', memory, ['Marc Tremblay']), 'prescription', 'another patient, same kind of file');
  assert.equal(learnedType('IMG_20220826_0001.pdf', memory), 'old_copy');
});

test('the coordinator\'s own words only (no quoted email, no signature)', () => {
  const m = messageText(emails[3].body);
  assert.ok(m.includes('Morocco') && !m.includes('old quoted'));
  assert.ok(!messageText(emails[2].body).includes('Coordonnatrice'));
});

test('a case for Claude: emails in order, no names or phones; unknown PDFs asked by the Mac', () => {
  const c = buildCase({ file: '98062', emails: emails.slice().reverse(), patient, tasks: [{ id: 't1', kind: 'close_file', status: 'todo', email_date: '2026-10-21T19:57:54Z', email_subject: 'Close File - CT 98062' }], memory: [], now: new Date('2026-10-30T17:00:00Z') });
  assert.ok(c.text.indexOf('E1 |') < c.text.indexOf('Close File') && c.text.indexOf('Close File') < c.text.indexOf('Morocco'), 'oldest first');
  for (const bad of ['Jean', 'TESTOUX', '514-555']) assert.ok(!c.text.includes(bad), bad);
  assert.match(c.text, /status: ON HOLD/);
  assert.match(c.text, /C:t1 \| close_file \| todo/);
  assert.deepEqual(c.questions.map(q => q.pdf), ['IMG_20220826_0001.pdf', 'Jean TESTOUX 98062.pdf'], 'real names on your phone');
  const c2 = buildCase({ file: '98062', emails, patient, memory: [{ key: 'pdf:img_20220826_0001.pdf', value: 'old_copy' }], now: new Date('2026-10-30T17:00:00Z') });
  assert.notEqual(c2.basis, c.basis, 'what you teach Dubbi makes it read the case again');
  assert.equal(c2.questions.length, 1);
});

test("Claude's answer is checked: known actions, real cards and emails, no contact details", () => {
  const raw = JSON.stringify({ headline: 'Continue injections — but patient travelling', summary: 'E3 overrides E1.', urgent: true, cards: { 'C:t1': 'obsolete', zz: 'obsolete' },
    actions: [{ type: 'dismiss_card', card: 'C:t1', why: 'superseded' }, { type: 'back', due: '2026-10-29' }, { type: 'set_dose', dose: '45 mg' }, { type: 'delete_all' },
      { type: 'reply', email: 'E4', text: 'Hello Amelia,\n\nThank you, I will try to reach the patient.\n\nThank you!\n\nNurse' }, { type: 'reply', email: 'E5', text: 'Hello,\n\nThis goes to reports.\n\nThank you!' },
      { type: 'call_patient', text: 'Ask if he is still in Montreal before Oct 31' }, { type: 'reply', email: 'E3', text: 'Hello Amelia, call me at 514-555-0000. Thank you!' }] });
  const a = parseCase(raw, { cardIds: ['t1'], emails, replyAllowed: addr => !/^(reports|no-?reply)@/.test(addr) });
  assert.deepEqual(a.cards, { t1: 'obsolete' });
  assert.deepEqual(a.actions.map(x => x.type), ['dismiss_card', 'back', 'set_dose', 'reply', 'call_patient']);
  assert.equal(a.actions[3].email, '<d>', 'the reply answers E4 (in its thread)');
  assert.equal(parseCase('nope'), null);
});

test('case pass: reads a case once, again only when something new arrives', async () => {
  const saved = [];
  const store = { caseEmails: async () => emails, brainData: async () => ({ patients: [patient], tasks: [] }), memory: async () => [],
    cases: async () => saved.map(s => ({ file_number: s.file_number, basis: s.basis, status: s.status, updated_at: new Date().toISOString() })), saveCase: async r => saved.push(r) };
  let sent = '';
  const run = async p => { sent = p; return JSON.stringify({ headline: 'x', summary: 'Patient travelling; keep on hold until he is back.', actions: [{ type: 'call_patient', text: 'Confirm travel dates' }], cards: {} }); };
  const now = new Date('2026-10-30T17:00:00Z');
  assert.equal(await casePass({ store, run, rules: {}, now, log: () => {} }), 1);
  assert.equal(saved[0].status, 'ready');
  assert.ok(!/TESTOUX|514-555/.test(sent));
  assert.equal(await casePass({ store, run, rules: {}, now, log: () => {} }), 0, 'nothing new → not read again');
});

test('a reply in a thread can carry a hold instruction; the old subject alone cannot', () => {
  assert.equal(patientUpdate({ subject: 'Re: Unconfirmed Patient - PB 98626', body: 'Hello Abdul,\nPlease place his file on hold until further notice.\n' }).kind, 'on_hold');
  assert.equal(patientUpdate({ subject: 'Re: File on Hold - PB 98626', body: 'Thanks Abdul!' }), null);
});

test('every Medicum email is kept with the file numbers it mentions', () => {
  const r = emailLogRow({ messageId: '<x>', from: '"Amelia Gareau" <ameliag@medicum.ca>', subject: 'Re: ASAP - CH 20062', date: '2026-10-30T15:45:25Z', bodyText: 'He was due October 29th 2026 (20062).', pdfs: [] });
  assert.deepEqual(r.file_numbers, ['20062']);
  assert.equal(r.from_name, 'Amelia Gareau');
  assert.deepEqual(emailLogRow({ messageId: '<y>', from: 'Medicum <no-reply@medicum.ca>', subject: 'New Appointment', bodyText: 'Please confirm reception', pdfs: [{ name: 'Generated_20062.pdf' }] }).file_numbers, ['20062']);
});
