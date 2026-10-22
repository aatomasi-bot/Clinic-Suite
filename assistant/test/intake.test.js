import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CASES, CLOSE_CASES, writeFakeInbox } from '../make-fake-pdfs.js';
import { parsePdf } from '../lib/pdf.js';
import { isAssignment, classifyEmail, subjectFileNumber } from '../lib/classify.js';
import { findExisting, sameNameOtherFile } from '../lib/match.js';
import { buildRecord, toIsoDate } from '../lib/record.js';
import { runIntake, loadConfig } from '../intake.js';
import { testFolderSource } from '../lib/sources.js';
import { offlineStore } from '../lib/store.js';
import { runOutbox } from '../lib/outbox.js';
import { testMailer } from '../lib/mailer.js';

const require = createRequire(import.meta.url);
const { parseMedicum } = require('../../js/medicum-parse.js');
const { draftReply, detectLanguage, coordinatorFirstName, subjectReference } = require('../../js/reply-templates.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vapiq-intake-'));
const inbox = await writeFakeInbox(path.join(tmp, 'inbox'));
const rules = loadConfig(path.join(tmp, 'none.json')).rules;
const fixtures = new URL('./fixtures/patients.json', import.meta.url).pathname;

for (const c of CASES) {
  test(`dose: ${c.id} → ${c.dose || 'blank'}`, async () => {
    const { scanned, result } = await parsePdf(fs.readFileSync(path.join(inbox, `${c.id}.pdf`)), `${c.id}.pdf`);
    if (c.mark === 'scan') { assert.equal(scanned, true); return; }
    assert.equal(result.dose, c.dose, result.doseReason);
    assert.equal(result.file, c.file);
    assert.equal(result.name, c.name);
  });
}

test('OCR text fallback: mark in front of one option, French decimals', () => {
  assert.equal(parseMedicum('DOSE [X] 3-m (22,5 mg) [ ] 6-m (45 mg)', [], 'a.pdf').dose, '22.5');
  assert.equal(parseMedicum('POSOLOGIE ☒ 6 mois (45 mg) ☐ 1 mois (7,5 mg)', [], 'a.pdf').dose, '45');
  assert.equal(parseMedicum('DOSE X 4-m (30mg) X 6-m (45mg)', [], 'a.pdf').dose, '', 'two marks → not guessed');
});

test('classify: assignments, prescriptions and close-file requests', () => {
  const pdfs = [{ name: 'a.pdf' }];
  const k = (from, subject, p = pdfs) => classifyEmail({ from, subject, pdfs: p }, rules).kind;
  assert.equal(k('Giulia <giuliar@medicum.ca>', 'New Patient JGC 35290'), 'assignment');
  assert.equal(k('Medicum Reports <reports@medicum.ca>', 'fax - SS #33816'), 'assignment');
  assert.equal(k('Sophie <sophiec@medicum.ca>', 'Ordonnance # 7308'), 'assignment');
  assert.equal(k('Annie <anniela@medicum.ca>', 'Close file 32604', []), 'close_file');
  assert.equal(k('Sophie <sophiec@medicum.ca>', 'Fermeture de dossier M.S # 13328', []), 'close_file');
  assert.equal(k('Amelia <ameliag@medicum.ca>', 'Close File - KD 32542', []), 'close_file');
  assert.equal(k('x <x@gmail.com>', 'Close file 1234', []), null, 'other domains never');
  assert.equal(k('Medicum <no-reply@medicum.ca>', 'New Appointment'), null);
  assert.equal(k('a <a@medicum.ca>', 'Re: Fermeture de dossier S.S-G # 13623', []), null, 'replies are not new requests');
  assert.equal(k('a <a@medicum.ca>', 'File on Hold - MK 34451', []), null);
  assert.equal(k('a <a@medicum.ca>', 'Temporary Transfer - AG 35251', []), null);
  assert.equal(k('a <a@medicum.ca>', 'New patient 11594', []), null, 'assignment needs a PDF');
  assert.ok(isAssignment({ from: 'Giulia <giuliar@medicum.ca>', subject: 'New Patient JGC 35290', pdfs }, rules).ok);
  assert.equal(subjectFileNumber('Patient\'s RC 23226 and AC 14092'), '14092');
  assert.equal(subjectFileNumber('fax - SS #33816'), '33816');
});

test('reply drafts: coordinator name, language, file reference, gender-neutral', () => {
  assert.equal(coordinatorFirstName('Amelia Gareau <ameliag@medicum.ca>'), 'Amelia');
  assert.equal(coordinatorFirstName('Medicum Reports <reports@medicum.ca>'), '');
  assert.equal(detectLanguage('Fermeture de dossier M.S # 13328'), 'fr');
  assert.equal(detectLanguage('Close file 32604'), 'en');
  assert.equal(subjectReference('Close File #33837 AA'), 'AA 33837');
  const en = draftReply({ kind: 'close_file', lang: 'en', coordinatorName: 'Annie', subjectRef: '32604', signature: 'Sig' });
  assert.equal(en, 'Hello Annie,\n\nThank you for letting me know. I have closed the file #32604.\n\nThank you,\nSig');
  const fr = draftReply({ kind: 'new_patient', lang: 'fr', coordinatorName: '', subjectRef: 'JGC 35290' });
  assert.match(fr, /^Bonjour,\n\nJe confirme la réception de ce courriel pour le dossier #35290 \(JGC\)/);
  for (const kind of ['new_patient', 'prescription', 'close_file']) for (const lang of ['en', 'fr']) {
    assert.doesNotMatch(draftReply({ kind, lang, coordinatorName: 'A', subjectRef: '1234' }), /\b(his|her|il|elle)\b/i);
  }
});

test('match: file number is identity (trim + case), name match is only a warning', () => {
  const pts = JSON.parse(fs.readFileSync(fixtures, 'utf8'));
  assert.equal(findExisting('30003', pts).id, 3);
  assert.equal(findExisting('99999', pts), null);
  assert.equal(sameNameOtherFile('Marié Exemple', '39002', pts).length, 1);
});

test('record: VaPiq defaults, missing fields flagged, dose never defaulted', () => {
  assert.equal(toIsoDate('15 November 2026'), '2026-11-15');
  const { record, missing } = buildRecord({ name: 'A B', dose: '', street: '1 Rue', city: 'Montreal', prov: 'QC', postal: 'H0H 0H0', apt: '4', ph1: '555-010-0001', date: '' }, { fileNumber: '1' });
  assert.equal(record.address, '1 Rue, Montreal, QC, H0H 0H0, Apt. 4');
  assert.equal(record.dose_prescribed, '');
  assert.deepEqual(missing.sort(), ['Dose Prescribed', 'Due Date']);
});

test('intake end to end (offline): new, prescription, close-file; re-run adds nothing', async () => {
  const outFile = path.join(tmp, 'pending.json');
  const store = offlineStore({ patientsFile: fixtures, outFile });
  const counts = await runIntake({ source: testFolderSource(inbox), store, rules, replies: { signature: 'Sig' }, isTest: true, log: () => {} });
  assert.equal(counts.emails, CASES.length + CLOSE_CASES.length);
  assert.equal(counts.prescriptions, 1);
  assert.equal(counts.closes, 3);
  const byFile = Object.fromEntries(store.rows.map(r => [r.record.file_number, r]));
  assert.equal(byFile['30001'], undefined, 'existing patient → prescription task, not a new-patient card');
  assert.equal(byFile['39001'].status, 'pending');
  assert.ok(store.rows.every(r => r.is_test) && store.tasks.every(t => t.is_test));
  assert.ok(byFile['39002'].warnings.some(w => /Same name as existing patient #30002/.test(w)));
  assert.ok(byFile['39007'].missing_fields.includes('Dose Prescribed'));
  assert.ok(byFile['39009'].warnings.some(w => /Scanned/.test(w)), 'scan flagged');
  assert.equal(byFile['39009'].record.file_number, '39009', 'file # from subject');

  const task = (kind, file) => store.tasks.find(t => t.kind === kind && t.file_number === file);
  const rx = task('prescription', '30001');
  assert.equal(rx.existing_patient.patient_name, 'Existing Testperson');
  assert.equal(rx.details.pdf_dose, '30');
  assert.match(rx.reply_body, /^Hello Julie,/);
  const np = task('new_patient', '39006');
  assert.equal(np.status, 'todo');
  assert.equal(np.lang, 'fr');
  assert.equal(np.pending_id, byFile['39006'].id);
  assert.equal(task('new_patient', '39009').to_name, null, 'reports@ → no first name');
  assert.equal(task('close_file', '30004').existing_patient.status, 'Active');
  assert.ok(task('close_file', '30002').warnings.some(w => /already closed/.test(w)));
  assert.ok(task('close_file', '39999').warnings.some(w => /not in VaPiq/.test(w)));
  assert.equal(task('close_file', '30002').lang, 'fr');

  const before = { rows: store.rows.length, tasks: store.tasks.length };
  const again = await runIntake({ source: testFolderSource(inbox), store, rules, isTest: true, log: () => {} });
  assert.equal(again.already, CASES.length + CLOSE_CASES.length);
  assert.deepEqual({ rows: store.rows.length, tasks: store.tasks.length }, before);
});

test('outbox: only approved replies go, once, test replies are saved not sent, strangers blocked', async () => {
  const store = offlineStore({ patientsFile: fixtures, outFile: path.join(tmp, 'outbox.json') });
  const base = { is_test: true, kind: 'close_file', file_number: '1', email_subject: 'Close file 1', email_message_id: '<m@x>', email_folder: 'Inbox' };
  const ok = await store.insertTask({ ...base, status: 'send_approved', to_address: 'julie.exemple@medicum.ca', reply_body: 'Hello Julie' });
  const draft = await store.insertTask({ ...base, status: 'reply_ready', to_address: 'julie.exemple@medicum.ca', reply_body: 'not approved' });
  const stranger = await store.insertTask({ ...base, status: 'send_approved', to_address: 'someone@gmail.com', reply_body: 'x' });
  const real = await store.insertTask({ ...base, is_test: false, status: 'send_approved', to_address: 'julie.exemple@medicum.ca', reply_body: 'real' });
  const tm = testMailer(path.join(tmp, 'outbox-test'));
  const live = { send: async () => { throw new Error('live mailer must not be used in test mode'); } };
  const c = await runOutbox({ store, mailer: live, testMailer: tm, rules, live: false, moveToFolder: 'Medicum', log: () => {} });
  const st = id => store.tasks.find(t => t.id === id).status;
  assert.equal(st(ok), 'sent');
  assert.equal(st(draft), 'reply_ready');
  assert.equal(st(stranger), 'failed');
  assert.equal(st(real), 'send_approved', 'real reply waits for live mode');
  assert.equal(c.sent, 1);
  const eml = fs.readFileSync(path.join(tmp, 'outbox-test', `${ok}.eml`), 'utf8');
  assert.match(eml, /Subject: Re: Close file 1/);
  assert.match(eml, /In-Reply-To: <m@x>/);
  assert.deepEqual(tm.moves, [{ id: ok, toFolder: 'Medicum' }]);
  const again = await runOutbox({ store, mailer: live, testMailer: tm, rules, live: false, moveToFolder: 'Medicum', log: () => {} });
  assert.equal(again.sent, 0, 'never sent twice');
});
