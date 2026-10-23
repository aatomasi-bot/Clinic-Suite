import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CASES, CLOSE_CASES, PAIR_CASES, writeFakeInbox, makeForm } from '../make-fake-pdfs.js';
import { parsePdf } from '../lib/pdf.js';
import { isAssignment, classifyEmail, subjectFileNumber } from '../lib/classify.js';
import { documentTypes } from '../lib/doctype.js';
import { findExisting, sameNameOtherFile } from '../lib/match.js';
import { buildRecord, toIsoDate } from '../lib/record.js';
import { runIntake, loadConfig, needsSignature } from '../intake.js';
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
  assert.equal(k('Medicum <no-reply@medicum.ca>', 'New Appointment'), 'assignment', 'no-reply@ New Appointment carries the forms');
  assert.equal(k('Medicum <no-reply@medicum.ca>', 'New Appointment', []), 'new_patient_notice');
  assert.equal(k('Giulia <giuliar@medicum.ca>', 'Re: New patient JS 35290'), 'assignment', 'reply carrying the documents joins the item');
  assert.equal(k('Giulia <giuliar@medicum.ca>', 'Re: New patient JS 35290', []), null);
  assert.equal(k('x <nsd@medicum.ca>', 'New Appointment'), null, 'monthly list sender stays excluded');
  assert.equal(k('a <a@medicum.ca>', 'Re: Fermeture de dossier S.S-G # 13623', []), null, 'replies are not new requests');
  assert.equal(k('a <a@medicum.ca>', 'File on Hold - MK 34451', []), null);
  assert.equal(k('a <a@medicum.ca>', 'Temporary Transfer - AG 35251', []), null);
  assert.equal(k('a <a@medicum.ca>', 'New patient 11594', []), 'new_patient_notice', 'kept so it pairs with the reports@ fax');
  assert.equal(k('a <a@medicum.ca>', 'Patient LPC 21403', []), null, 'other notes without PDF are left alone');
  assert.equal(k('Kavya <kavyas@medicum.ca>', 'Enrollment signed by patient - SR 27740'), 'enrollment_doc');
  assert.equal(k('Kavya <kavyas@medicum.ca>', 'Enrollment signed by patient - SR 27740', []), null);
  assert.ok(isAssignment({ from: 'Giulia <giuliar@medicum.ca>', subject: 'New Patient JGC 35290', pdfs }, rules).ok);
  assert.equal(subjectFileNumber('Patient\'s RC 23226 and AC 14092'), '14092');
  assert.equal(subjectFileNumber('fax - SS #33816'), '33816');
});

test('document types: Medicum file names', () => {
  const t = (name, text = '', scanned = !text) => documentTypes({ name, text, scanned });
  assert.deepEqual(t('JS12345New.pdf'), ['assignment']);
  assert.deepEqual(t('DP 12345 New.pdf'), ['assignment']);
  assert.deepEqual(t('KS12345NewReopen.pdf'), ['assignment']);
  assert.deepEqual(t('RM12345NewCPP.jpg'), ['assignment']);
  assert.deepEqual(t('Enrollment_Form_Auto_Generated_12345.pdf', 'PATIENT NAME / NOM DU PATIENT ... ENROLLMENT'), ['enrollment'], 'named enrollment form is only the enrollment form');
  assert.deepEqual(t('RX-PC12345.pdf'), ['copy'], 'prescription copy — never parsed');
  assert.deepEqual(t('Nurse_Report_123456.pdf'), ['copy']);
  assert.deepEqual(t('FAX_20261023_1792782821_345.pdf', 'PATIENT NAME / NOM DU PATIENT MEDICUM #: 20261023'), ['copy'], 'fax copy even with patient text');
  assert.deepEqual(t('RA35037.pdf'), ['assignment']);
  assert.deepEqual(t('scan0001.pdf'), []);
});

test('reply drafts: coordinator name, language, file reference, gender-neutral', () => {
  assert.equal(coordinatorFirstName('Amelia Gareau <ameliag@medicum.ca>'), 'Amelia');
  assert.equal(coordinatorFirstName('Medicum Reports <reports@medicum.ca>'), '');
  assert.equal(detectLanguage('Fermeture de dossier M.S # 13328'), 'fr');
  assert.equal(detectLanguage('Close file 32604'), 'en');
  assert.equal(subjectReference('Close File #33837 AA'), 'AA 33837');
  const en = draftReply({ kind: 'close_file', lang: 'en', coordinatorName: 'Annie', subjectRef: '32604', signature: 'Sig' });
  assert.equal(en, 'Hello Annie,\n\nI have closed the file #32604.\n\nThank you!\n\nSig');
  const fr = draftReply({ kind: 'new_patient', lang: 'fr', coordinatorName: '', subjectRef: 'JGC 35290' });
  assert.match(fr, /^Bonjour,\n\nJe confirme la réception de ce courriel pour le dossier #35290\. /, "no patient initials next to the file number");
  for (const kind of ['new_patient', 'prescription', 'close_file']) for (const lang of ['en', 'fr']) {
    assert.doesNotMatch(draftReply({ kind, lang, coordinatorName: 'A', subjectRef: '1234' }), /\b(his|her|il|elle)\b/i);
  }
});

test('match: file number is identity (trim + case), name match is only a warning', () => {
  const pts = JSON.parse(fs.readFileSync(fixtures, 'utf8'));
  assert.equal(findExisting('98003', pts).id, 3);
  assert.equal(findExisting('99999', pts), null);
  assert.equal(sameNameOtherFile('Marié Exemple', '99002', pts).length, 1);
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
  const relatedStateFile = path.join(tmp, 'related.json');
  const counts = await runIntake({ source: testFolderSource(inbox), store, rules, replies: { signature: 'Sig' }, isTest: true, log: () => {}, relatedStateFile });
  assert.equal(counts.emails, CASES.length + CLOSE_CASES.length + PAIR_CASES.length);
  assert.equal(counts.prescriptions, 1);
  assert.equal(counts.closes, 3);
  const byFile = Object.fromEntries(store.rows.map(r => [r.record.file_number, r]));
  assert.equal(byFile['98001'], undefined, 'existing patient → prescription task, not a new-patient card');
  assert.equal(byFile['99001'].status, 'pending');
  assert.ok(store.rows.every(r => r.is_test) && store.tasks.every(t => t.is_test));
  assert.ok(byFile['99002'].warnings.some(w => /Same name as existing patient #98002/.test(w)));
  assert.ok(byFile['99007'].missing_fields.includes('Dose Prescribed'));
  assert.ok(byFile['99009'].warnings.some(w => /scanned/i.test(w)), 'scan flagged');
  assert.equal(byFile['99009'].record.file_number, '99009', 'file # from subject');

  const task = (kind, file) => store.tasks.find(t => t.kind === kind && t.file_number === file);
  const rx = task('prescription', '98001');
  assert.equal(rx.existing_patient.patient_name, 'Existing Testperson');
  assert.equal(rx.details.pdf_dose, '30');
  assert.match(rx.reply_body, /^Hello Julie,/);
  // Coordinator note + reports@ fax → ONE item, to the coordinator, CC reports@, documents complete
  const pair = store.tasks.filter(t => t.kind === 'new_patient' && t.group_key === '99011');
  assert.equal(pair.length, 1);
  assert.equal(pair[0].to_address, 'julie.exemple@medicum.ca');
  assert.deepEqual(pair[0].cc_addresses, ['reports@medicum.ca']);
  assert.equal(pair[0].related_emails.length, 2);
  assert.ok(pair[0].documents.assignment && pair[0].documents.enrollment);
  assert.ok(pair[0].pending_id, 'card pre-filled from the fax');
  assert.match(pair[0].reply_body, /along with the documents \(assignment form and enrollment form\)/);
  assert.deepEqual(pair[0].warnings, []);
  // no-reply@ "New Appointment" first, coordinator note second → ONE item, reply to the coordinator (never no-reply@)
  const nr = store.tasks.filter(t => t.kind === 'new_patient' && t.group_key === '99015');
  assert.equal(nr.length, 1);
  assert.equal(nr[0].to_address, 'julie.exemple@medicum.ca');
  assert.deepEqual(nr[0].cc_addresses, ['reports@medicum.ca']);
  assert.ok(nr[0].documents.assignment && nr[0].documents.enrollment, 'NR99015New.pdf = assignment, Enrollment_Form_Auto_Generated = enrollment');
  assert.match(nr[0].reply_body, /^Hello Julie,/);
  assert.ok(nr[0].pending_id);
  // Forms first, coordinator email second → the existing card is updated
  const nrCard = store.rows.find(r => r.id === nr[0].pending_id).record;
  assert.equal(nrCard.special_instructions, 'Signature required! | Coordinator: Bone scan schedule October 28th 2026 and need the injection after');
  assert.equal(nrCard.due_date, '2026-10-29', 'due date from the coordinator email');
  // Coordinator email first, forms second → the card is created with the email's date
  assert.equal(byFile['99011'].record.due_date, '2026-11-21');
  assert.equal(byFile['99011'].record.special_instructions, '', 'no signature line, no note → nothing');
  assert.ok(byFile['99011'].warnings.some(w => /replaces the form/.test(w)), 'form date differs → said so on the card');
  // Kavya (reports@, FAX copy only) + the filed no-reply@ email found by file number
  const kav = store.tasks.filter(t => t.kind === 'new_patient' && t.group_key === '99031');
  assert.equal(kav.length, 1, 'one item');
  assert.equal(kav[0].to_address, 'kavyaf@medicum.ca', 'reply to the coordinator who signed');
  assert.equal(kav[0].to_name, 'Kavya');
  assert.deepEqual(kav[0].cc_addresses, ['reports@medicum.ca']);
  assert.match(kav[0].reply_body, /^Hello Kavya,/);
  assert.ok(kav[0].documents.assignment && kav[0].documents.enrollment);
  assert.ok(kav[0].documents.files.some(f => f.name.startsWith('FAX_') && f.types[0] === 'copy'));
  const kc = store.rows.find(r => r.id === kav[0].pending_id);
  assert.equal(kc.attachment_name, 'Enrollment_Form_Auto_Generated_30182.pdf', 'card from the enrollment form');
  assert.equal(kc.record.patient_name, 'Rene Testabel');
  assert.equal(kc.record.file_number, '99031', 'never the fax number');
  assert.equal(kc.record.due_date, '2027-03-09', '"Next injection scheduled for" → due date');
  assert.ok(!store.rows.some(r => r.record.patient_name === 'Wrong Fax Person'), 'FAX never read');
  // Weaker card rebuilt when the enrollment form arrives
  const rb = store.tasks.find(t => t.kind === 'new_patient' && t.group_key === '99032');
  assert.equal(store.rows.find(r => r.id === rb.pending_id).record.patient_name, 'From Enrollment');
  assert.equal(store.rows.filter(r => r.record.file_number === '99032').length, 1, 'rebuilt, not duplicated');
  // Note with no documents → polite request for both, in French
  assert.match(task('new_patient', '99013').reply_body, /je n'ai pas reçu le formulaire d'assignation ni le formulaire d'inscription/);
  // Form only → asks for the enrollment form
  assert.match(task('new_patient', '99001').reply_body, /did not receive the enrollment form/);
  // Scanned fax from reports@ alone: document unknown → you tick it on the card
  assert.equal(task('new_patient', '99009').documents.unknown, 1);
  const np = task('new_patient', '99006');
  assert.equal(np.status, 'todo');
  assert.equal(np.lang, 'fr');
  assert.equal(np.pending_id, byFile['99006'].id);
  assert.equal(task('new_patient', '99009').to_name, null, 'reports@ → no first name');
  assert.deepEqual(task('new_patient', '99009').cc_addresses, [], 'no CC to reports@ when replying to reports@');
  assert.equal(task('close_file', '98004').existing_patient.status, 'Active');
  assert.ok(task('close_file', '98002').warnings.some(w => /already closed/.test(w)));
  assert.ok(task('close_file', '99999').warnings.some(w => /not in VaPiq/.test(w)));
  assert.equal(task('close_file', '98002').lang, 'fr');

  const before = { rows: store.rows.length, tasks: store.tasks.length };
  const again = await runIntake({ source: testFolderSource(inbox), store, rules, isTest: true, log: () => {}, relatedStateFile });
  assert.equal(again.already, CASES.length + CLOSE_CASES.length + PAIR_CASES.filter(c => !c.filed).length);
  assert.deepEqual({ rows: store.rows.length, tasks: store.tasks.length }, before);
});

test('outbox: only approved replies go, once, test replies are saved not sent, strangers blocked', async () => {
  const store = offlineStore({ patientsFile: fixtures, outFile: path.join(tmp, 'outbox.json') });
  const base = { is_test: true, kind: 'close_file', file_number: '1', email_subject: 'Close file 1', email_message_id: '<m@x>', email_folder: 'Inbox' };
  const ok = await store.insertTask({ ...base, status: 'send_approved', to_address: 'julie.exemple@medicum.ca', reply_body: 'Hello Julie' });
  const draft = await store.insertTask({ ...base, status: 'reply_ready', to_address: 'julie.exemple@medicum.ca', reply_body: 'not approved' });
  const stranger = await store.insertTask({ ...base, status: 'send_approved', to_address: 'someone@gmail.com', reply_body: 'x' });
  const noreply = await store.insertTask({ ...base, status: 'send_approved', to_address: 'no-reply@medicum.ca', reply_body: 'x' });
  const real = await store.insertTask({ ...base, is_test: false, status: 'send_approved', to_address: 'julie.exemple@medicum.ca', reply_body: 'real' });
  const tm = testMailer(path.join(tmp, 'outbox-test'));
  const live = { send: async () => { throw new Error('live mailer must not be used in test mode'); } };
  const c = await runOutbox({ store, mailer: live, testMailer: tm, rules, live: false, moveToFolder: 'Medicum', log: () => {} });
  const st = id => store.tasks.find(t => t.id === id).status;
  assert.equal(st(ok), 'sent');
  assert.equal(st(draft), 'reply_ready');
  assert.equal(st(stranger), 'failed');
  assert.equal(st(noreply), 'failed', 'never reply to no-reply@');
  assert.equal(st(real), 'send_approved', 'real reply waits for live mode');
  assert.equal(c.sent, 1);
  const eml = fs.readFileSync(path.join(tmp, 'outbox-test', `${ok}.eml`), 'utf8');
  assert.match(eml, /Subject: Re: Close file 1/);
  assert.match(eml, /In-Reply-To: <m@x>/);
  assert.deepEqual(tm.moves, [{ id: ok, toFolder: 'Medicum', emails: 1 }]);
  const again = await runOutbox({ store, mailer: live, testMailer: tm, rules, live: false, moveToFolder: 'Medicum', log: () => {} });
  assert.equal(again.sent, 0, 'never sent twice');
});

test('address: street, city, prov, postal, then the unit with its own label', () => {
  const { splitUnit, formatAddress } = require('../../js/medicum-parse.js');
  const cases = [
    ['1 Boulevard De Maisonneuve Ouest Appartement 703', '1 Boulevard De Maisonneuve Ouest', 'Apt. 703'],
    ['45 Graham Boulevard, Unit C', '45 Graham Boulevard', 'Unit C'],
    ['45 Graham Boulevard Unité c', '45 Graham Boulevard', 'Unit C'],
    ['12 Rue Fictive #5', '12 Rue Fictive', 'Apt. 5'],
    ['3-123 Boulevard Deguire', '123 Boulevard Deguire', 'Apt. 3'],
    ['100 Rue Y Suite 200', '100 Rue Y', 'Suite 200'],
    ['290 54e Avenue', '290 54e Avenue', ''],
    ['1234 Rue Unitaire', '1234 Rue Unitaire', ''],
  ];
  for (const [raw, street, unit] of cases) assert.deepEqual(splitUnit(raw), { street, unit }, raw);
  assert.equal(formatAddress({ street: '123 Boulevard Deguire', city: 'Montreal', prov: 'QC', postal: 'H4M 0A4', apt: 'Apt. 3' }),
    '123 Boulevard Deguire, Montreal, QC, H4M 0A4, Apt. 3');
  assert.equal(formatAddress({ street: '45 Graham Boulevard', city: 'Laval', prov: 'QC', postal: 'H7G 3A4', apt: 'Unit C' }),
    '45 Graham Boulevard, Laval, QC, H7G 3A4, Unit C');
  assert.equal(formatAddress({ street: '9 Rue Z', city: 'Laval', prov: 'QC', postal: 'H7G 3A4', apt: '3' }), '9 Rue Z, Laval, QC, H7G 3A4, Apt. 3');
});

test('safety net: overdue items, scheduling gaps, morning text (counts only)', async () => {
  const { overdueItems, dueForAlert, schedulingGaps, openCounts, morningText, forMode } = await import('../lib/safety.js');
  const now = Date.parse('2026-10-22T12:00:00Z'), hAgo = h => new Date(now - h * 36e5).toISOString();
  const alerts = { newPatientHours: 24, replyHours: 48, waitingDocsHours: 24 };
  const snap = {
    pending: [{ id: 'p1', status: 'pending', created_at: hAgo(30) }, { id: 'p2', status: 'pending', created_at: hAgo(2) }],
    tasks: [
      { id: 't1', kind: 'new_patient', status: 'reply_ready', decided_at: hAgo(50), created_at: hAgo(60) },
      { id: 't2', kind: 'new_patient', status: 'todo', created_at: hAgo(30), documents: { assignment: true, enrollment: false } },
      { id: 't3', kind: 'close_file', status: 'todo', created_at: hAgo(26), alerted_at: hAgo(3) },
      { id: 't4', kind: 'close_file', status: 'todo', created_at: hAgo(1) },
      { id: 't5', kind: 'prescription', status: 'todo', created_at: hAgo(40), is_test: true },
    ],
    patients: [
      { id: 1, archived: false, due_date: '2026-10-20', appointment_date_time: null },
      { id: 2, archived: false, due_date: '2026-10-30', appointment_date_time: null },
      { id: 3, archived: false, due_date: '2026-10-25', appointment_date_time: '2026-10-22T10:00', appointment_confirmed: true },
      { id: 4, archived: false, due_date: '2026-10-26', appointment_date_time: '2026-10-24T09:00', appointment_confirmed: false },
      { id: 5, archived: true, due_date: '2026-10-01', appointment_date_time: null },
    ],
  };
  const all = overdueItems(snap, alerts, now).map(i => i.id + ':' + i.why);
  assert.deepEqual(all.sort(), ['p1:new_patient_not_added', 't1:reply_not_sent', 't2:documents_missing', 't3:file_not_closed', 't5:prescription_not_applied']);
  assert.deepEqual(dueForAlert(overdueItems(snap, alerts, now), now).map(i => i.id).sort(), ['p1', 't1', 't2', 't5'], 't3 was alerted 3 h ago');
  assert.ok(!overdueItems(forMode(snap, true), alerts, now).some(i => i.id === 't5'), 'live mode ignores TEST cards');
  const g = schedulingGaps(snap.patients, 14, new Date('2026-10-22T12:00:00'));
  assert.deepEqual(g, { noAppointment: 2, overdueNoAppointment: 1, unconfirmed: 1, visitsToday: 1 });
  const text = morningText(openCounts(snap), g, 4);
  assert.match(text, /to do · ⚠️ 4 overdue · 1 waiting for documents · 2 patients to schedule \(1 past due\) · 1 to confirm · 1 visit today/);
  assert.doesNotMatch(text, /\d{5}/, 'no file numbers in notifications');
});

test('total doses: number of injections, else months ÷ the dose months, else the default', async () => {
  const { repeatsFor, parseMedicum } = require('../../js/medicum-parse.js');
  assert.equal(repeatsFor('22.5', '', '18').total, '6');
  assert.equal(repeatsFor('45', '', '6').total, '1');
  assert.equal(repeatsFor('45', '', '12').total, '2');
  assert.equal(repeatsFor('30', '', '12').total, '3');
  assert.equal(repeatsFor('7.5', '', '6').total, '6');
  assert.equal(repeatsFor('30', '', '18').total, '', '18 is not a multiple of 4 → leave the default and warn');
  assert.match(repeatsFor('30', '', '18').why, /does not divide/);
  assert.equal(repeatsFor('22.5', '5', '18').total, '5', 'number of injections wins');
  // Medicum's enrollment form: the label is there, the number usually is not
  const empty = parseMedicum("1-m (7.5 mg) 3-m (22.5mg) 4-m (30mg) 6-m (45mg) MEDICUM #: 98100 Number of injections/Nombre d'injection a recevoir: Language: English", ['22.5 mg'], 'x.pdf');
  assert.equal(empty.injections, undefined);
  const filled = parseMedicum("MEDICUM #: 98100 Number of injections/Nombre d'injection a recevoir: 6 Language: English", [], 'x.pdf');
  assert.equal(filled.injections, '6');
  // OCR text: months right after the chosen option
  assert.equal(parseMedicum('1-m (7.5 mg) [X] 3-m (22.5mg) 18 4-m (30mg) 6-m (45mg)', [], 'x.pdf').months, '18');
  // Text PDF: months drawn next to the ticked box
  const pdf = async c => (await parsePdf(await makeForm({ file: '98100', name: 'Mona Mois', mark: 'x', ...c }), 'f.pdf')).result;
  const a = await pdf({ dose: '22.5', months: '18' });
  assert.equal(a.dose, '22.5'); assert.equal(a.months, '18'); assert.equal(a.totalDoses, '6');
  assert.deepEqual([buildRecord(a, { fileNumber: '98100' }).record.total_doses, buildRecord(a, { fileNumber: '98100' }).record.doses_remaining], ['6', '6']);
  const b = await pdf({ dose: '45', months: '6' });
  assert.equal(b.totalDoses, '1');
  const c = await pdf({ dose: '30' });
  assert.equal(c.totalDoses, '');
  assert.equal(buildRecord(c, { fileNumber: '98100' }).record.total_doses, '4', 'nothing marked → default');
});

test('signature line in the email → "Signature required!"', () => {
  assert.ok(needsSignature('*** Please have the patient sign the enrollment form at your visit and return to Medicum reports***'));
  assert.ok(needsSignature('Please have the patient sign the enrolment form'));
  assert.ok(!needsSignature('*** This form is considered a valid prescription with Medicum****'));
});

test('scanned assignment form: "for a period of _N_ months" on the chosen dose line', () => {
  const { parseMedicum } = require('../../js/medicum-parse.js');
  const p = (t, bold = []) => { const r = parseMedicum(t, bold, 'scan.pdf'); return [r.dose, r.months || '', r.periodDose || '']; };
  const EN = ['7.5 mg, (1 month) for a period of_ months', '22.5 mg, (3 months) for a period of_18_months', '30.0 mg, (4 months) for a period of_ _months Date: 2026/10/21', '45.0 mg, (6 months) for a period of_ months'].join('\n');
  assert.deepEqual(p(EN), ['22.5', '18', '22.5']);
  assert.deepEqual(p('7,5 mg, (1 mois) pour une durée de mois\nX 45,0 mg, (6 mois) pour une durée de_|2_mois 2026/01/15'), ['45', '12', '45'], '| read as 1');
  assert.deepEqual(p('22,5 mg, (3 mois) pour une durée de_ mois\n45,0 mg, (6 mois) pour une durée de _ 6_mois'), ['45', '6', '45']);
  assert.deepEqual(p('22.5 mg, (3 menths) for a peried of_12_months'), ['22.5', '12', '22.5'], 'OCR misspellings');
  assert.deepEqual(p('X 30.0 mg, (4 months) for a period of months\n45.0 mg, (6 months) for a period of_ months'), ['', '', ''], 'no months → nothing');
  assert.deepEqual(p(EN, ['45 mg']), ['45', '', '22.5'], 'dose disagrees → months not used');
});

test('coordinator email: due date and the reason in brackets', async () => {
  const { emailDueDate, readDate } = await import('../lib/emailinfo.js');
  const d = s => emailDueDate(s, new Date('2026-10-22'));
  assert.deepEqual(d('…assigned for the following date: October 29th 2026 (Bone scan schedule October 28th 2026 and need the injection after).'), { due: '2026-10-29', note: 'Bone scan schedule October 28th 2026 and need the injection after' });
  assert.deepEqual(d('…assigned for the following date:  November 2 2026'), { due: '2026-11-02', note: '' });
  assert.deepEqual(d('…pour la date suivante : 21 septembre 2026.'), { due: '2026-09-21', note: '' });
  assert.deepEqual(d('…pour la date suivante : 1er octobre 2026 (Casodex débuté le 15 septembre)'), { due: '2026-10-01', note: 'Casodex débuté le 15 septembre' });
  assert.deepEqual(d('…assigned for the following date: ASAP'), { due: '', note: '' });
  assert.equal(readDate('February 30 2026'), '', 'impossible dates are ignored');
  assert.equal(readDate('Jan 5', new Date('2026-12-20')), '2027-01-05', 'no year → next one when long past');
});
