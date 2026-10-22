// VaPiq intake assistant — one pass: read the mailbox, then send approved replies.
// launchd runs this every 2 minutes (see README.md).
//
// Coordinator emails become cards in the Approvals page:
//   new patient (PDF, file # not in VaPiq)  → "Add to VaPiq?" card; after you add it,
//                                             a reply "I confirm the receipt…" waits for Send
//   prescription (PDF, file # in VaPiq)     → "Apply prescription" card → reply waits for Send
//   close file ("Close file 32604", …)      → "Close file?" card → reply waits for Send
// It never writes to `patients` and never sends anything without your tap.
//
//   node intake.js              uses config.json (mode "test" or "live")
//   node intake.js --offline    fake emails + fixture patients, no network at all
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { classifyEmail, subjectFileNumber, senderAddress } from './lib/classify.js';
import { findExisting, sameNameOtherFile, patientStatus, normFile } from './lib/match.js';
import { buildRecord } from './lib/record.js';
import { parsePdf } from './lib/pdf.js';
import { testFolderSource, imapSource } from './lib/sources.js';
import { supabaseStore, offlineStore } from './lib/store.js';
import { summaryText, macNotification, pushToPhones } from './lib/notify.js';
import { testMailer, liveMailer } from './lib/mailer.js';
import { runOutbox } from './lib/outbox.js';

const require = createRequire(import.meta.url);
const { draftReply, detectLanguage, coordinatorFirstName, subjectReference } = require('../js/reply-templates.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(here, 'state');

export function loadConfig(file = path.join(here, 'config.json')) {
  const base = JSON.parse(fs.readFileSync(path.join(here, 'config.example.json'), 'utf8'));
  const own = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const merged = { ...base, ...own };
  for (const k of ['imap', 'rules', 'supabase', 'push', 'replies']) merged[k] = { ...base[k], ...(own[k] || {}) };
  return merged;
}

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function existingSummary(p) {
  return p ? { id: p.id, file_number: p.file_number, patient_name: p.patient_name, status: patientStatus(p),
               dose_prescribed: p.dose_prescribed ?? null, doses_remaining: p.doses_remaining ?? null } : null;
}

// Core pipeline — exported for tests.
export async function runIntake({ source, store, rules, replies = {}, isTest, log = console.log }) {
  const patients = await store.loadPatients();
  const queuedThisRun = new Set((await store.openPendingFileNumbers()).map(normFile));
  const counts = { emails: 0, skipped: 0, queued: 0, exists: 0, needsReview: 0, already: 0, prescriptions: 0, closes: 0 };

  for await (const email of source.emails()) {
    counts.emails++;
    const { kind } = email.skipped ? { kind: null } : classifyEmail(email, rules);
    if (!kind) { counts.skipped++; continue; }

    const subjectFile = subjectFileNumber(email.subject);
    // What every reply needs — the draft is ready on the card when you get to it.
    const lang = detectLanguage(`${email.subject} ${email.bodyText || ''}`);
    const coordinatorName = coordinatorFirstName(email.from);
    const subjectRef = subjectReference(email.subject);
    const replyBase = {
      is_test: !!isTest, email_message_id: email.messageId, email_folder: email.folder || null,
      email_from: email.from, email_subject: email.subject, email_date: email.date,
      to_address: senderAddress(email.from), to_name: coordinatorName || null, lang, subject_ref: subjectRef || null,
    };
    const draft = (k, fileNumber) => replies.enabled === false ? null
      : draftReply({ kind: k, lang, coordinatorName, fileNumber, subjectRef, signature: replies.signature || '' });

    // ── Close file ───────────────────────────────────────────────────────
    if (kind === 'close_file') {
      const key = sha(`${email.messageId}|close_file`);
      if ((await store.knownTaskKeys([key])).size) { counts.already++; continue; }
      const existing = findExisting(subjectFile, patients);
      const warnings = [];
      if (!subjectFile) warnings.push('No file number in the subject — find the patient yourself.');
      else if (!existing) warnings.push(`File #${subjectFile} is not in VaPiq.`);
      else if (existing.archived) warnings.push('This file is already closed (archived) in VaPiq.');
      const id = await store.insertTask({ ...replyBase, kind: 'close_file', status: 'todo', source_key: key,
        file_number: subjectFile || null, existing_patient: existingSummary(existing), warnings, reply_body: draft('close_file', subjectFile) });
      await store.audit('ASSISTANT_CLOSE_REQUEST', subjectFile, { task_id: id, test: !!isTest });
      counts.closes++;
      log(`  close   card ${id}${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''}`);
      await source.markHandled(email);
      continue;
    }

    // ── Assignment PDFs: new patient or prescription for an existing one ──
    const pdfKeys = email.pdfs.map(p => sha(`${email.messageId}|${p.name}`));
    const knownPending = await store.knownSourceKeys(pdfKeys);
    const knownTasks = await store.knownTaskKeys(pdfKeys);

    for (const [i, pdf] of email.pdfs.entries()) {
      const key = pdfKeys[i];
      if (knownPending.has(key) || knownTasks.has(key)) { counts.already++; continue; }

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

      const existing = findExisting(fileNumber, patients);
      if (existing) {
        // Already a VaPiq patient → a new prescription to apply. Nothing is written to patients.
        const id = await store.insertTask({ ...replyBase, kind: 'prescription', status: 'todo', source_key: key,
          file_number: fileNumber, existing_patient: existingSummary(existing),
          details: { pdf_dose: parsed?.dose || null, pdf_due_date: parsed?.date || null, attachment_name: pdf.name },
          warnings, reply_body: draft('prescription', fileNumber) });
        await store.audit('ASSISTANT_PRESCRIPTION', fileNumber, { task_id: id, test: !!isTest });
        counts.prescriptions++;
        log(`  rx      card ${id}`);
        continue;
      }

      const { record, missing } = buildRecord(parsed, { fileNumber });
      const dupInQueue = fileNumber && queuedThisRun.has(normFile(fileNumber));
      let status = 'pending', existingPatient = null;
      if (dupInQueue) {
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
      if (status === 'pending') {
        // The reply waits until you add the patient ("todo" → "reply_ready").
        await store.insertTask({ ...replyBase, kind: 'new_patient', status: 'todo', source_key: sha(`${key}|reply`),
          pending_id: id, file_number: fileNumber || null, warnings: [], reply_body: draft('new_patient', fileNumber) });
      }
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

  let source, mailer;
  const tMailer = testMailer(path.join(stateDir, 'outbox-test'));
  try {
    const live = !offline && cfg.mode === 'live';
    if (live && cfg.liveConfirmed !== true) {
      throw new Error('mode is "live" but liveConfirmed is not true. Live mode reads real patient email — set liveConfirmed only once the mailbox setup is approved for patient data.');
    }
    const store = offline
      ? offlineStore({ patientsFile: path.join(here, 'test/fixtures/patients.json'), outFile: path.join(stateDir, 'offline-pending.json') })
      : await supabaseStore(cfg.supabase);
    source = live
      ? imapSource(cfg.imap, { wanted: e => !!classifyEmail(e, cfg.rules).kind })
      : testFolderSource(path.resolve(here, cfg.testInbox));

    console.log(`[${new Date().toISOString()}] intake: ${live ? 'LIVE' : 'TEST'} · ${source.name} · ${store.kind}`);
    const counts = await runIntake({ source, store, rules: cfg.rules, replies: cfg.replies, isTest: !live });
    console.log(`  emails ${counts.emails}, ignored ${counts.skipped}, already handled ${counts.already}, ` +
      `new ${counts.queued}, prescriptions ${counts.prescriptions}, close-file ${counts.closes}, ` +
      `duplicates ${counts.exists}, needs reading ${counts.needsReview}`);
    await source.close(); source = null;

    // Replies you approved
    if (live) mailer = liveMailer(cfg.imap, cfg.replies);
    const out = await runOutbox({ store, mailer, testMailer: tMailer, rules: cfg.rules, live, moveToFolder: cfg.replies.moveToFolder });
    if (out.sent || out.failed) console.log(`  replies sent ${out.sent}, failed ${out.failed}`);

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
    await mailer?.close();
    fs.rmSync(lock, { force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('intake failed:', e.message); process.exitCode = 1; });
}
