// VaPiq intake assistant — one pass over the mailbox.
// launchd runs this every few minutes (see README.md). Each assignment PDF is:
//   parsed → checked against VaPiq by file number →
//     exists  : "already in VaPiq" card, nothing written to patients
//     new     : "awaiting approval" card; YOU approve in approvals/ before any insert
// It never sends email, never deletes anything, and never writes to `patients`.
//
//   node intake.js              uses config.json (mode "test" or "live")
//   node intake.js --offline    fake PDFs + fixture patients, no network at all
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isAssignment, subjectFileNumber } from './lib/classify.js';
import { findExisting, sameNameOtherFile, patientStatus, normFile } from './lib/match.js';
import { buildRecord } from './lib/record.js';
import { parsePdf } from './lib/pdf.js';
import { testFolderSource, imapSource } from './lib/sources.js';
import { supabaseStore, offlineStore } from './lib/store.js';
import { summaryText, macNotification, pushToPhones } from './lib/notify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(here, 'state');

export function loadConfig(file = path.join(here, 'config.json')) {
  const base = JSON.parse(fs.readFileSync(path.join(here, 'config.example.json'), 'utf8'));
  const own = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const merged = { ...base, ...own };
  for (const k of ['imap', 'rules', 'supabase', 'push']) merged[k] = { ...base[k], ...(own[k] || {}) };
  return merged;
}

const sourceKey = (email, pdf) => crypto.createHash('sha256').update(`${email.messageId}|${pdf.name}`).digest('hex');

// Core pipeline — exported for tests.
export async function runIntake({ source, store, rules, isTest, log = console.log }) {
  const patients = await store.loadPatients();
  const queuedThisRun = new Set((await store.openPendingFileNumbers()).map(normFile));
  const counts = { emails: 0, skipped: 0, queued: 0, exists: 0, needsReview: 0, already: 0 };

  for await (const email of source.emails()) {
    counts.emails++;
    if (email.skipped || !isAssignment(email, rules).ok) { counts.skipped++; continue; }
    const keys = email.pdfs.map(p => sourceKey(email, p));
    const known = await store.knownSourceKeys(keys);
    const subjectFile = subjectFileNumber(email.subject);

    for (const [i, pdf] of email.pdfs.entries()) {
      const key = keys[i];
      if (known.has(key)) { counts.already++; continue; }

      const warnings = [];
      let parsed = null;
      try {
        const out = await parsePdf(pdf.bytes, pdf.name);
        if (out.scanned) warnings.push('Scanned/faxed PDF — no text layer. Open it in the Medicum Parser (OCR) to read the fields.');
        parsed = out.result;
        if (parsed && !parsed.dose) warnings.push(`Dose not clearly marked on the form (${parsed.doseReason || 'unknown'}) — check the PDF.`);
      } catch (e) {
        warnings.push('Could not read this PDF: ' + e.message);
      }

      let fileNumber = parsed?.file || '';
      if (!fileNumber && subjectFile) { fileNumber = subjectFile; warnings.push('File # taken from the email subject (not found in the PDF).'); }
      else if (fileNumber && subjectFile && normFile(fileNumber) !== normFile(subjectFile)) {
        warnings.push(`File # in the PDF (${fileNumber}) differs from the email subject (${subjectFile}).`);
      }

      const { record, missing } = buildRecord(parsed, { fileNumber });
      const existing = findExisting(fileNumber, patients);
      const dupInQueue = !existing && fileNumber && queuedThisRun.has(normFile(fileNumber));
      let status = 'pending', existingPatient = null;
      if (existing) {
        status = 'exists';
        existingPatient = { file_number: existing.file_number, patient_name: existing.patient_name, status: patientStatus(existing) };
      } else if (dupInQueue) {
        status = 'exists';
        existingPatient = { file_number: fileNumber, patient_name: record.patient_name, status: 'Already awaiting your approval' };
      } else {
        for (const p of sameNameOtherFile(record.patient_name, fileNumber, patients)) {
          warnings.push(`Same name as existing patient #${p.file_number} (${patientStatus(p)}) — possible duplicate.`);
        }
        if (fileNumber) queuedThisRun.add(normFile(fileNumber));
      }

      const id = await store.insertPending({
        status, is_test: !!isTest, source_key: key,
        email_from: email.from, email_subject: email.subject, email_date: email.date,
        attachment_name: pdf.name, subject_file_number: subjectFile || null,
        record, missing_fields: missing, warnings, existing_patient: existingPatient,
      });
      await store.audit(status === 'exists' ? 'ASSISTANT_EXISTS' : 'ASSISTANT_QUEUED', fileNumber, { pending_id: id, test: !!isTest });

      if (status === 'exists') counts.exists++;
      else if (!parsed || missing.includes('Patient Name') || missing.includes('File Number')) counts.needsReview++;
      else counts.queued++;
      log(`  ${status.padEnd(7)} card ${id}${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''}`);
    }
    await source.markHandled(email);
  }
  return counts;
}

async function main() {
  const offline = process.argv.includes('--offline');
  const cfg = loadConfig();
  fs.mkdirSync(stateDir, { recursive: true });

  // One run at a time (launchd can overlap a slow run).
  const lock = path.join(stateDir, 'intake.lock');
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs < 10 * 60e3) { console.log('Another run is in progress — skipping.'); return; }
  } catch {}
  fs.writeFileSync(lock, String(process.pid));

  let source;
  try {
    const live = !offline && cfg.mode === 'live';
    if (live && cfg.liveConfirmed !== true) {
      throw new Error('mode is "live" but liveConfirmed is not true. Live mode reads real patient email — set liveConfirmed only once the mailbox setup is approved for patient data.');
    }
    const store = offline
      ? offlineStore({ patientsFile: path.join(here, 'test/fixtures/patients.json'), outFile: path.join(stateDir, 'offline-pending.json') })
      : await supabaseStore(cfg.supabase);
    source = live
      ? imapSource(cfg.imap, { isAssignmentHeaders: e => isAssignment(e, cfg.rules).ok })
      : testFolderSource(path.resolve(here, cfg.testInbox));

    console.log(`[${new Date().toISOString()}] intake: ${live ? 'LIVE' : 'TEST'} · ${source.name} · ${store.kind}`);
    const counts = await runIntake({ source, store, rules: cfg.rules, isTest: !live });
    console.log(`  emails ${counts.emails}, not assignments ${counts.skipped}, already handled ${counts.already}, ` +
      `new ${counts.queued}, exists ${counts.exists}, needs reading ${counts.needsReview}`);

    const body = summaryText(counts);
    if (body && !offline) {
      const title = live ? 'VaPiq' : 'VaPiq (test)';
      if (cfg.push.mac) macNotification(title, body);
      const r = await pushToPhones(store, { title, body, url: cfg.push.approvalsUrl, subject: cfg.push.subject });
      if (r.skipped) console.log('  push:', r.skipped); else console.log(`  push sent to ${r.sent} device(s)`);
    }
    await store.purgeDecided(cfg.retentionDays);
  } finally {
    await source?.close();
    fs.rmSync(lock, { force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('intake failed:', e.message); process.exitCode = 1; });
}
