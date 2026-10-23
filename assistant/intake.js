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
import { classifyEmail, subjectFileNumber, senderAddress, isNewPatientSubject } from './lib/classify.js';
import { documentTypes, summarizeDocuments } from './lib/doctype.js';
import { findExisting, sameNameOtherFile, patientStatus, normFile } from './lib/match.js';
import { buildRecord } from './lib/record.js';
import { parsePdf } from './lib/pdf.js';
import { testFolderSource, imapSource } from './lib/sources.js';
import { supabaseStore, offlineStore } from './lib/store.js';
import { summaryText, macNotification, pushToPhones } from './lib/notify.js';
import { testMailer, liveMailer } from './lib/mailer.js';
import { runOutbox } from './lib/outbox.js';
import { overdueItems, dueForAlert, overdueText, forMode } from './lib/safety.js';

const require = createRequire(import.meta.url);
const { draftReply, detectLanguage, coordinatorFirstName, subjectReference, missingDocs } = require('../js/reply-templates.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(here, 'state');

export function loadConfig(file = path.join(here, 'config.json')) {
  const base = JSON.parse(fs.readFileSync(path.join(here, 'config.example.json'), 'utf8'));
  const own = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const merged = { ...base, ...own };
  for (const k of ['imap', 'rules', 'supabase', 'push', 'replies', 'alerts']) merged[k] = { ...base[k], ...(own[k] || {}) };
  return merged;
}

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function existingSummary(p) {
  return p ? { id: p.id, file_number: p.file_number, patient_name: p.patient_name, status: patientStatus(p),
               dose_prescribed: p.dose_prescribed ?? null, doses_remaining: p.doses_remaining ?? null } : null;
}

const emailRef = e => ({ from: e.from, subject: e.subject, date: e.date, message_id: e.messageId, folder: e.folder || null });

// Core pipeline — exported for tests.
export async function runIntake({ source, store, rules, replies = {}, isTest, log = console.log }) {
  const patients = await store.loadPatients();
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
        file_number: subjectFile || null, existing_patient: existingSummary(existing), warnings, reply_body: draft('close_file', subjectFile),
        details: { signature: replies.signature || '' } });
      await store.audit('ASSISTANT_CLOSE_REQUEST', subjectFile, { task_id: id, test: !!isTest });
      counts.closes++;
      log(`  close   card ${id}${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''}`);
      await source.markHandled(email);
      continue;
    }

    // ── New patient (coordinator email ± reports@ fax) or prescription ────
    // The coordinator's email and the reports@medicum.ca email about the same
    // patient are joined by file number into ONE new-patient item: one card,
    // one reply (to the coordinator, CC reports@) that confirms the documents
    // or politely asks for what's missing.
    if (await store.knownMessage(email.messageId)) { counts.already++; continue; }
    const sender = senderAddress(email.from);
    const fromReports = sender === (replies.reportsAddress || 'reports@medicum.ca');
    const noReply = (rules.noReplySenders || []).map(s => s.toLowerCase()).includes(sender);   // no-reply@ "New Appointment"
    const fromDocs = fromReports || noReply;

    // Read every PDF: document type + parsed form fields
    const files = [], parsedForms = [];
    for (const pdf of email.pdfs) {
      const key = sha(`${email.messageId}|${pdf.name}`);
      const warnings = [];
      let out = { scanned: true, text: '', result: null };
      if (/\.(jpe?g|png|heic|tiff?)$/i.test(pdf.name)) warnings.push(`${pdf.name} is a picture — open it in the email to read it.`);
      else try { out = await parsePdf(pdf.bytes, pdf.name); } catch (e) { warnings.push(`Could not read ${pdf.name} (${e.message}) — open it in the email.`); }
      let types = documentTypes({ text: out.text, scanned: out.scanned, name: pdf.name });
      if (kind === 'enrollment_doc' && !types.length) types = ['enrollment'];   // the subject says what it is
      files.push({ name: pdf.name, types, from: senderAddress(email.from) });
      if (out.scanned && !/\.(jpe?g|png|heic|tiff?)$/i.test(pdf.name) && !warnings.length) warnings.push(`${pdf.name}: scanned/faxed PDF — open it in the Medicum Parser (OCR) to read the fields.`);
      const r = out.result;
      if (r && !r.dose && (types.includes('assignment') || /enrol+ment[\s_-]*form/i.test(pdf.name))) warnings.push(`Dose not clearly marked on the form (${r.doseReason || 'unknown'}) — check the PDF.`);
      parsedForms.push({ key, pdf, parsed: r, types, warnings, scanned: out.scanned });
    }
    // Best form to pre-fill the new-patient card (confirmed Oct 23, 2026): Medicum's
    // "Enrollment_Form_Auto_Generated_12345.pdf" first — a text PDF with every field
    // (the assignment form is usually a scan) — then a parsed assignment form, any
    // parsed PDF, or the first PDF.
    const ENROLLMENT_FORM = /enrol+ment[\s_-]*form/i;
    const hasData = f => f.parsed && (f.parsed.name || f.parsed.file);
    const form = parsedForms.find(f => hasData(f) && ENROLLMENT_FORM.test(f.pdf.name))
      || parsedForms.find(f => f.parsed && f.types.includes('assignment')) || parsedForms.find(f => f.parsed) || parsedForms[0] || null;
    const noReplyAddr = a => (rules.noReplySenders || []).map(s => s.toLowerCase()).includes(String(a || '').toLowerCase());
    const groupKey = normFile(subjectFile || form?.parsed?.file || '') || null;
    const existing = findExisting(groupKey, patients);
    const group = groupKey ? await store.findGroupTask(groupKey, 14) : null;

    // Enrollment emails only complete an open new-patient item
    if (kind === 'enrollment_doc' && !group) {
      counts.skipped++;
      log(`  skip    enrollment email for #${groupKey || '?'} — no open new-patient item (left in your inbox)`);
      continue;
    }

    // Already a VaPiq patient and not part of a recent new-patient item → prescription to apply
    if (existing && !group && kind === 'assignment' && !isNewPatientSubject(email.subject, rules)) {
      for (const f of parsedForms) {
        const id = await store.insertTask({ ...replyBase, kind: 'prescription', status: 'todo', source_key: f.key,
          file_number: groupKey, group_key: groupKey, existing_patient: existingSummary(existing),
          related_emails: [emailRef(email)],
          details: { pdf_dose: f.parsed?.dose || null, pdf_due_date: f.parsed?.date || null, attachment_name: f.pdf.name, signature: replies.signature || '' },
          warnings: f.warnings, reply_body: draft('prescription', groupKey) });
        await store.audit('ASSISTANT_PRESCRIPTION', groupKey, { task_id: id, test: !!isTest });
        counts.prescriptions++;
        log(`  rx      card ${id}`);
      }
      await source.markHandled(email);
      continue;
    }

    // Pre-filled new-patient card from the best form (once per patient)
    let pendingId = group?.pending_id || null;
    const cardWarnings = form ? [...form.warnings] : [];
    if (!pendingId && form && !existing) {
      let fileNumber = form.parsed?.file || '';
      if (!fileNumber && subjectFile) { fileNumber = subjectFile; cardWarnings.push('File # taken from the email subject (not found in the PDF).'); }
      else if (fileNumber && subjectFile && normFile(fileNumber) !== normFile(subjectFile)) cardWarnings.push(`File # in the PDF (${fileNumber}) differs from the email subject (${subjectFile}).`);
      const { record, missing } = buildRecord(form.parsed, { fileNumber });
      for (const p of sameNameOtherFile(record.patient_name, fileNumber, patients)) cardWarnings.push(`Same name as existing patient #${p.file_number} (${patientStatus(p)}) — possible duplicate.`);
      pendingId = await store.insertPending({
        status: 'pending', is_test: !!isTest, source_key: form.key,
        email_from: email.from, email_subject: email.subject, email_date: email.date,
        attachment_name: form.pdf.name, subject_file_number: subjectFile || null,
        record, missing_fields: missing, warnings: cardWarnings, existing_patient: null,
      });
      await store.audit('ASSISTANT_QUEUED', fileNumber, { pending_id: pendingId, test: !!isTest });
      if (!form.parsed || missing.includes('Patient Name') || missing.includes('File Number')) counts.needsReview++; else counts.queued++;
      log(`  pending card ${pendingId}${cardWarnings.length ? ` (${cardWarnings.length} warning${cardWarnings.length > 1 ? 's' : ''})` : ''}`);
    }

    // The new-patient item: create, or join this email to the existing one
    const reports = replies.reportsAddress || 'reports@medicum.ca';
    if (group) {
      const related = [...(group.related_emails || []), emailRef(email)];
      const allFiles = [...((group.documents && group.documents.files) || []), ...files];
      const docs = summarizeDocuments(allFiles.map(f => ({ ...f, types: f.types || [] })));
      const NO_DOCS = /^No documents attached/;
      const warnings = (group.warnings || []).filter(w => !(allFiles.length && NO_DOCS.test(w)));
      const fields = { related_emails: related, documents: docs, pending_id: pendingId, warnings };
      // Reply goes to the coordinator, in the coordinator's thread
      if (!fromDocs && (group.to_address === reports || noReplyAddr(group.to_address))) {
        Object.assign(fields, { to_address: senderAddress(email.from), to_name: coordinatorName || null,
          email_message_id: email.messageId, email_folder: email.folder || null, email_from: email.from,
          email_subject: email.subject, email_date: email.date, lang, subject_ref: subjectRef || group.subject_ref });
      }
      const to = fields.to_address || group.to_address;
      fields.cc_addresses = to === reports ? [] : [reports];
      if (group.status === 'waiting_docs' && !missingDocs(docs).length) fields.status = 'todo';   // documents arrived
      if (['todo', 'waiting_docs', 'reply_ready', 'failed'].includes(fields.status || group.status)) {
        fields.reply_body = replies.enabled === false ? null : draftReply({ kind: 'new_patient', lang: fields.lang || group.lang,
          coordinatorName: (fields.to_name ?? group.to_name) || '', fileNumber: groupKey,
          subjectRef: fields.subject_ref || group.subject_ref, signature: replies.signature || '', docs });
      }
      await store.updateTask(group.id, fields);
      log(`  joined  ${fromReports ? 'reports@' : noReply ? 'no-reply@' : 'coordinator'} email → new-patient item ${group.id}`);
    } else {
      const docs = summarizeDocuments(files);
      const warnings = [];
      if (existing) warnings.push(`File #${existing.file_number} is already in VaPiq as ${existing.patient_name} (${patientStatus(existing)}).`);
      if (!email.pdfs.length) warnings.push('No documents attached — the documents email (no-reply@ or reports@medicum.ca) usually follows.');
      // Documents arrived first from no-reply@: address the reply to reports@ until the coordinator's email joins
      const to = noReply ? reports : sender;
      const id = await store.insertTask({ ...replyBase, kind: 'new_patient', status: 'todo',
        source_key: sha(`${email.messageId}|new_patient`), pending_id: pendingId, group_key: groupKey,
        details: { signature: replies.signature || '' },
        file_number: groupKey, cc_addresses: to === reports ? [] : [reports], to_address: to, to_name: noReply ? null : replyBase.to_name,
        existing_patient: existingSummary(existing), related_emails: [emailRef(email)], documents: docs, warnings,
        reply_body: replies.enabled === false ? null : draftReply({ kind: 'new_patient', lang, coordinatorName: noReply ? '' : coordinatorName, fileNumber: groupKey,
          subjectRef, signature: replies.signature || '', docs }) });
      log(`  new     patient item ${id}${missingDocs(docs).length ? ` (missing: ${missingDocs(docs).join(', ')})` : ''}`);
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
    const sourceName = source.name;
    await source.close(); source = null;

    // Replies you approved
    if (live) mailer = liveMailer(cfg.imap, cfg.replies);
    const out = await runOutbox({ store, mailer, testMailer: tMailer, rules: cfg.rules, live, moveToFolder: cfg.replies.moveToFolder });
    if (out.sent || out.failed) console.log(`  replies sent ${out.sent}, failed ${out.failed}`);

    const title = live ? 'VaPiq' : 'VaPiq (test)';
    const notify = async body => {
      if (offline) return;
      if (cfg.push.mac) macNotification(title, body);
      const r = await pushToPhones(store, { title, body, url: cfg.push.approvalsUrl, subject: cfg.push.subject });
      if (r.skipped) console.log('  push:', r.skipped); else console.log(`  push sent to ${r.sent} device(s)`);
    };
    const body = summaryText(counts);
    if (body) await notify(body);

    // Safety net: anything waiting too long → one reminder per item per day
    const overdue = dueForAlert(overdueItems(forMode(await store.snapshot(), live), cfg.alerts));
    if (overdue.length) {
      console.log(`  overdue ${overdue.length}: ${[...new Set(overdue.map(o => o.why))].join(', ')}`);
      await notify(overdueText(overdue));
      await store.markAlerted(overdue);
      await store.log('overdue_alert', { count: overdue.length, reasons: overdue.map(o => o.why) });
    }
    await store.purgeDecided(cfg.retentionDays);
    await store.heartbeat({ mode: live ? 'live' : 'test', source: sourceName });
  } finally {
    await source?.close();
    await mailer?.close();
    fs.rmSync(lock, { force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('intake failed:', e.message); process.exitCode = 1; });
}
