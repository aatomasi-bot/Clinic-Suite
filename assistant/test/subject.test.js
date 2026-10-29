// Manager's rule (Oct 29 2026): subject = patient initials + file number only; full name allowed in the body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { testMailer, replySubject } from '../lib/mailer.js';
import { runOutbox } from '../lib/outbox.js';
const { safeSubject, initialsOf } = createRequire(import.meta.url)('../../js/reply-templates.js');

test('full names in subjects become initials; file numbers and subject words stay', () => {
  assert.equal(initialsOf('Jean-Guy Côté'), 'JGC');
  assert.equal(safeSubject('Re: New patient Jean Tremblay 35037', ['Jean Tremblay']), 'Re: New patient JT 35037');
  assert.equal(safeSubject('Fermeture de dossier - TREMBLAY, Jean #35037', []), 'Fermeture de dossier - JT #35037');
  assert.equal(safeSubject('Re: Close file Hélène Côté 98004', ['Helene Cote']), 'Re: Close file HC 98004');
  assert.equal(safeSubject('Re: Fax for Tremblay', ['Jean Tremblay']), 'Re: Fax for T');
  assert.equal(safeSubject('Update — Mme Tremblay 35037', []), 'Update — Mme T 35037');
  for (const keep of ['Patient JGC 35290', 'New Appointment', 'Re: Transfer CONFIRMED file 35037', 'RA35037 New Patient', 'Re: Patient on hold 35037 Medicum NMR'])
    assert.equal(safeSubject(keep, []), keep);
  assert.equal(replySubject('New patient Jean Tremblay 35037', ['Jean Tremblay']), 'Re: New patient JT 35037');
});

test('a sent reply: initials in the subject, full name kept in the body', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subj-'));
  const task = { id: 't1', is_test: true, status: 'send_approved', kind: 'close_file', file_number: '35037',
    to_address: 'julie@medicum.ca', to_name: 'Julie', cc_addresses: [], email_subject: 'Close file Jean Tremblay 35037',
    reply_body: 'Hello Julie,\n\nI have closed the file of Jean Tremblay #35037.\n\nThank you!' };
  const store = { failStuckSending: async () => {}, tasksToSend: async () => [task], claimTask: async () => true,
    updateTask: async () => {}, audit: async () => {}, patientNames: async files => files.includes('35037') ? ['Jean Tremblay'] : [] };
  const m = testMailer(dir);
  await runOutbox({ store, mailer: null, testMailer: m, rules: { senderDomains: ['medicum.ca'], excludeSenders: [], noReplySenders: [] }, live: false, log: () => {} });
  const eml = fs.readFileSync(path.join(dir, 't1.eml'), 'utf8');
  assert.match(eml, /^Subject: Re: Close file JT 35037$/m);
  assert.match(eml, /Jean Tremblay #35037/, 'full name stays in the body');
});
