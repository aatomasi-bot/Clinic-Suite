import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CASES, writeFakeInbox } from '../make-fake-pdfs.js';
import { parsePdf } from '../lib/pdf.js';
import { isAssignment, subjectFileNumber } from '../lib/classify.js';
import { findExisting, sameNameOtherFile } from '../lib/match.js';
import { buildRecord, toIsoDate } from '../lib/record.js';
import { runIntake, loadConfig } from '../intake.js';
import { testFolderSource } from '../lib/sources.js';
import { offlineStore } from '../lib/store.js';

const require = createRequire(import.meta.url);
const { parseMedicum } = require('../../js/medicum-parse.js');
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

test('classify: sender, subject and PDF rules', () => {
  const pdfs = [{ name: 'a.pdf' }];
  assert.ok(isAssignment({ from: 'Giulia <giuliar@medicum.ca>', subject: 'New Patient JGC 35290', pdfs }, rules).ok);
  assert.ok(isAssignment({ from: 'Medicum Reports <reports@medicum.ca>', subject: 'fax - SS #33816', pdfs }, rules).ok);
  assert.ok(!isAssignment({ from: 'x <x@gmail.com>', subject: 'New patient 1234', pdfs }, rules).ok);
  assert.ok(!isAssignment({ from: 'Medicum <no-reply@medicum.ca>', subject: 'New Appointment', pdfs }, rules).ok);
  assert.ok(!isAssignment({ from: 'a <a@medicum.ca>', subject: 'Close file 32604', pdfs }, rules).ok);
  assert.ok(!isAssignment({ from: 'a <a@medicum.ca>', subject: 'New patient 11594', pdfs: [] }, rules).ok);
  assert.equal(subjectFileNumber('Patient\'s RC 23226 and AC 14092'), '14092');
  assert.equal(subjectFileNumber('fax - SS #33816'), '33816');
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

test('intake end to end (offline): new → pending, existing → exists, re-run adds nothing', async () => {
  const outFile = path.join(tmp, 'pending.json');
  const store = offlineStore({ patientsFile: fixtures, outFile });
  const counts = await runIntake({ source: testFolderSource(inbox), store, rules, isTest: true, log: () => {} });
  assert.equal(counts.emails, CASES.length);
  const byFile = Object.fromEntries(store.rows.map(r => [r.record.file_number, r]));
  assert.equal(byFile['30001'].status, 'exists');
  assert.equal(byFile['30001'].existing_patient.patient_name, 'Existing Testperson');
  assert.equal(byFile['39001'].status, 'pending');
  assert.ok(store.rows.every(r => r.is_test));
  assert.ok(byFile['39002'].warnings.some(w => /Same name as existing patient #30002/.test(w)));
  assert.ok(byFile['39007'].missing_fields.includes('Dose Prescribed'));
  assert.ok(byFile['39009'].warnings.some(w => /Scanned/.test(w)), 'scan flagged');
  assert.equal(byFile['39009'].record.file_number, '39009', 'file # from subject');

  const again = await runIntake({ source: testFolderSource(inbox), store, rules, isTest: true, log: () => {} });
  assert.equal(again.already, CASES.length);
  assert.equal(store.rows.length, CASES.length);
});
