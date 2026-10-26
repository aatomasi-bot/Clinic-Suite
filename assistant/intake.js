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
import { classifyEmail, subjectFileNumber, senderAddress, isNewPatientSubject, senderAllowed, replyAllowed } from './lib/classify.js';
import { documentTypes, summarizeDocuments, isCopyDocument } from './lib/doctype.js';
import { findExisting, sameNameOtherFile, patientStatus, normFile } from './lib/match.js';
import { buildRecord, toIsoDate } from './lib/record.js';
import { parsePdf, parseScan, repeatsFor } from './lib/pdf.js';
import { needsSignature, emailDueDate, cardNotes, signedBy, openingText, patientUpdate } from './lib/emailinfo.js';
import { excerptOf, redact } from './lib/ai.js';
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
  for (const k of ['imap', 'rules', 'supabase', 'push', 'replies', 'alerts', 'ai']) merged[k] = { ...base[k], ...(own[k] || {}) };
  return merged;
}

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// Which source fills the new-patient card (confirmed Oct 23, 2026):
//   3 Enrollment_Form_Auto_Generated (text PDF, every field)
//   2 the assignment form ("RA35037.pdf", "JS35335New.pdf"), text or scan
//   1 any other readable form · 0 nothing usable. FAX/RX copies are never read.
export const DEFAULT_TOTAL_NOTE = 'Total doses: default';   // the Dubbi card highlights the field when it sees this
const ENROLLMENT_FORM = /enrol+ment[\s_-]*form/i;
const hasData = f => !!(f && f.parsed && (f.parsed.name || f.parsed.file));
const formRank = f => !hasData(f) ? 0 : ENROLLMENT_FORM.test(f.pdf.name) ? 3 : f.types.includes('assignment') ? 2 : 1;
const nameRank = n => ENROLLMENT_FORM.test(n || '') ? 3 : isCopyDocument(n) ? 0 : documentTypes({ name: n || '', scanned: true }).includes('assignment') ? 2 : 1;
const stateFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'state', 'related-search.json');   // when each item was last searched
// Kept on the patient's item, for a card created by a later email
const remember = said => ({ ...(said.signature ? { signature_required: true } : {}), ...(said.due ? { email_due: said.due, email_note: said.note || '' } : {}),
  ...(said.transfer ? { transfer: said.transfer } : {}) });

export { needsSignature } from './lib/emailinfo.js';

function existingSummary(p) {
  return p ? { id: p.id, file_number: p.file_number, patient_name: p.patient_name, status: patientStatus(p),
               dose_prescribed: p.dose_prescribed ?? null, doses_remaining: p.doses_remaining ?? null } : null;
}

const emailRef = e => ({ from: e.from, subject: e.subject, date: e.date, message_id: e.messageId, folder: e.folder || null });

// Core pipeline — exported for tests.
export async function runIntake({ source, store, rules, replies = {}, isTest, log = console.log, relatedStateFile = stateFile }) {
  const patients = await store.loadPatients();
  const counts = { emails: 0, skipped: 0, queued: 0, exists: 0, needsReview: 0, already: 0, prescriptions: 0, closes: 0 };

  const touched = new Set();   // file numbers of new-patient items seen this run
  const handle = async email => {
    counts.emails++;
    let { kind } = email.skipped ? { kind: null } : classifyEmail(email, rules);
    // Patient updates (on hold / back / permanent / temporary transfer) — often only
    // recognisable from the coordinator's message, the subject being just the name
    const update = !email.skipped && senderAllowed(email.from, rules) && (!kind || kind === 'new_patient_notice' || kind === 'assignment')
      ? patientUpdate({ subject: email.subject, body: email.bodyText, date: email.date }) : null;
    const transfer = update && update.kind === 'transfer' ? update : null;
    if (transfer && !kind) kind = email.pdfs && email.pdfs.length ? 'assignment' : 'new_patient_notice';
    if (update && !transfer && kind) kind = null;   // an update about an existing patient, not a new one
    // Anything else a coordinator writes (a question, "has the patient been contacted?") → a reply card
    const question = !kind && !update && !email.skipped && replyAllowed(email.from, rules)
      && !/^\s*(re|tr|fw|fwd)\s*:/i.test(email.subject || '');
    if (!kind && !(update && !transfer) && !question) { counts.skipped++; return; }

    const subjectFile = subjectFileNumber(email.subject);
    // What every reply needs — the draft is ready on the card when you get to it.
    const lang = detectLanguage(`${email.subject} ${openingText(email.bodyText)}`);
    const coordinatorName = coordinatorFirstName(email.from);
    const subjectRef = subjectReference(email.subject);
    // The coordinator's message, contact details removed — what the reply AI may read (lib/ai.js)
    const excerpt = excerptOf(email.bodyText);
    const replyBase = {
      is_test: !!isTest, email_message_id: email.messageId, email_folder: email.folder || null,
      email_from: email.from, email_subject: email.subject, email_date: email.date,
      to_address: senderAddress(email.from), to_name: coordinatorName || null, lang, subject_ref: subjectRef || null,
    };
    const draft = (k, fileNumber) => replies.enabled === false ? null
      : draftReply({ kind: k, lang, coordinatorName, fileNumber, subjectRef, signature: replies.signature || '' });

    // ── Coordinator question ─────────────────────────────────────────────
    if (question) {
      const key = sha(`${email.messageId}|question`);
      if ((await store.knownTaskKeys([key])).size) { counts.already++; return; }
      // Every file number in the subject and her message (phone numbers removed first) — a follow-up often lists several
      const nums = [...new Set(`${email.subject} ${redact(openingText(email.bodyText))}`.match(/\b\d{4,6}\b/g) || [])];
      const known = nums.filter(n => findExisting(n, patients));
      const fileList = known.length ? known : nums.slice(0, 1);
      const fileNo = fileList[0] || '';
      const factOf = n => { const p = findExisting(n, patients);
        return { file: n, found: !!p, onHold: !!(p && p.archived), appointment: (p && p.appointment_date_time) || null, confirmed: !!(p && p.appointment_confirmed) }; };
      const facts = fileList.length > 1 ? { files: fileList.map(factOf) } : factOf(fileNo);
      const existing = fileNo ? findExisting(fileNo, patients) : null;
      const names = fileList.map(n => (findExisting(n, patients) || {}).patient_name);
      let id;
      try { id = await store.insertTask({ ...replyBase, kind: 'question', status: 'reply_ready', source_key: key,
        file_number: fileNo || null, existing_patient: existingSummary(existing),
        warnings: nums.filter(n => !findExisting(n, patients)).slice(0, 3).map(n => `File #${n} is not in VaPiq.`),
        reply_body: replies.enabled === false ? null : draftReply({ kind: 'question', lang, coordinatorName, fileNumber: fileNo, subjectRef, signature: replies.signature || '', facts }),
        // the patient's name is removed too: Claude only sees "[patient]"
        details: { excerpt: excerptOf(email.bodyText, names), signature: replies.signature || '', facts, files: fileList } }); }
      catch (e) {
        if (/check constraint|violates/i.test(e.message)) { log('  wait    question email — run supabase/2026-10-26_coordinator_questions.sql'); counts.skipped++; return; }
        throw e;
      }
      await store.audit('ASSISTANT_QUESTION', fileNo || null, { task_id: id, test: !!isTest });
      counts.questions = (counts.questions || 0) + 1;
      log(`  question card ${id}${fileList.length ? ` for ${fileList.length} file${fileList.length > 1 ? 's' : ''}` : ''}`);
      await source.markHandled(email);
      return;
    }

    // ── On hold / back / permanent ───────────────────────────────────────
    if (update && !transfer) {
      const key = sha(`${email.messageId}|${update.kind}`);
      if ((await store.knownTaskKeys([key])).size) { counts.already++; return; }
      const fileNo = subjectFile || ((openingText(email.bodyText).match(/\b\d{4,6}\b/) || [])[0]) || '';
      const existing = findExisting(fileNo, patients);
      const warnings = [];
      if (!fileNo) warnings.push('No file number found — find the patient yourself.');
      else if (!existing) warnings.push(`File #${fileNo} is not in VaPiq.`);
      else if (update.kind === 'on_hold' && existing.archived) warnings.push('This file is already on hold in VaPiq.');
      else if (update.kind === 'back' && !existing.archived) warnings.push('This file is not on hold in VaPiq (already active).');
      let id;
      try {
        id = await store.insertTask({ ...replyBase, kind: update.kind, status: 'todo', source_key: key,
          file_number: fileNo || null, existing_patient: existingSummary(existing), warnings, reply_body: draft(update.kind, fileNo),
          details: { excerpt, signature: replies.signature || '', reason: update.reason, due: update.due || null } });
      } catch (e) {
        // Database not updated yet for these cards (supabase/2026-10-25_patient_updates.sql):
        // leave the email for the next run instead of failing the whole check
        if (/check constraint|violates/i.test(e.message)) { log(`  wait    ${update.kind} email for #${fileNo} — run supabase/2026-10-25_patient_updates.sql`); counts.skipped++; return; }
        throw e;
      }
      await store.audit('ASSISTANT_UPDATE_REQUEST', fileNo, { task_id: id, kind: update.kind, test: !!isTest });
      counts.updates = (counts.updates || 0) + 1;
      log(`  ${update.kind.padEnd(7)} card ${id}${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''}`);
      await source.markHandled(email);
      return;
    }

    // ── Close file ───────────────────────────────────────────────────────
    if (kind === 'close_file') {
      const key = sha(`${email.messageId}|close_file`);
      if ((await store.knownTaskKeys([key])).size) { counts.already++; return; }
      const existing = findExisting(subjectFile, patients);
      const warnings = [];
      if (!subjectFile) warnings.push('No file number in the subject — find the patient yourself.');
      else if (!existing) warnings.push(`File #${subjectFile} is not in VaPiq.`);
      else if (existing.archived) warnings.push('This file is on hold in VaPiq — closing it deletes the record.');
      const id = await store.insertTask({ ...replyBase, kind: 'close_file', status: 'todo', source_key: key,
        file_number: subjectFile || null, existing_patient: existingSummary(existing), warnings, reply_body: draft('close_file', subjectFile),
        details: { excerpt, signature: replies.signature || '' } });
      await store.audit('ASSISTANT_CLOSE_REQUEST', subjectFile, { task_id: id, test: !!isTest });
      counts.closes++;
      log(`  close   card ${id}${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''}`);
      await source.markHandled(email);
      return;
    }

    // ── New patient (coordinator email ± reports@ fax) or prescription ────
    // The coordinator's email and the reports@medicum.ca email about the same
    // patient are joined by file number into ONE new-patient item: one card,
    // one reply (to the coordinator, CC reports@) that confirms the documents
    // or politely asks for what's missing.
    if (await store.knownMessage(email.messageId)) { counts.already++; return; }
    const sender = senderAddress(email.from);
    // What the coordinator's email says: signature needed, due date (+ the reason in brackets)
    const said = { signature: needsSignature(email.bodyText), ...emailDueDate(email.bodyText, email.date),
                   ...(transfer ? { transfer: transfer.reason || 'Temporary transfer' } : {}) };
    if (transfer && transfer.due && !said.due) said.due = transfer.due;
    const saysSomething = said.signature || said.due;
    const fromReports = sender === (replies.reportsAddress || 'reports@medicum.ca');
    const noReply = (rules.noReplySenders || []).map(s => s.toLowerCase()).includes(sender);   // no-reply@ "New Appointment"
    const fromDocs = fromReports || noReply;
    // Coordinator writing from reports@ and signing it → reply to her (CC reports@)
    const signer = fromReports ? signedBy(email.bodyText) : null;
    const coordAddress = signer ? signer.address : sender, coordName = signer ? (signer.firstName || null) : (coordinatorName || null);

    // Read every PDF: document type + parsed form fields
    const files = [], parsedForms = [];
    for (const pdf of email.pdfs) {
      // FAX_…, fax-sip…, RX…, Nurse_Report…: copies, never a source of patient data
      if (isCopyDocument(pdf.name)) { files.push({ name: pdf.name, types: ['copy'], from: senderAddress(email.from) }); continue; }
      const key = sha(`${email.messageId}|${pdf.name}`);
      const warnings = [];
      let out = { scanned: true, text: '', result: null };
      if (/\.(jpe?g|png|heic|tiff?)$/i.test(pdf.name)) out = parseScan(pdf.bytes, pdf.name);
      else try { out = await parsePdf(pdf.bytes, pdf.name); } catch (e) { warnings.push(`Could not read ${pdf.name} (${e.message}) — open it in the email.`); }
      let types = documentTypes({ text: out.text, scanned: out.scanned && !out.ocr, name: pdf.name });
      if (kind === 'enrollment_doc' && !types.length) types = ['enrollment'];   // the subject says what it is
      files.push({ name: pdf.name, types, from: senderAddress(email.from) });
      if (out.scanned && !out.ocr && !warnings.length) warnings.push(`${pdf.name}: scanned/faxed PDF — open it in the Medicum Parser (OCR) to read the fields.`);
      const r = out.result;
      if (r && !r.dose && (types.includes('assignment') || /enrol+ment[\s_-]*form/i.test(pdf.name))) warnings.push(`Dose not clearly marked on the form (${r.doseReason || 'unknown'}) — check the PDF.`);
      parsedForms.push({ key, pdf, parsed: r, types, warnings, scanned: out.scanned });
    }
    // Best form to pre-fill the new-patient card (confirmed Oct 23, 2026): Medicum's
    // "Enrollment_Form_Auto_Generated_12345.pdf" first — a text PDF with every field
    // (the assignment form is usually a scan) — then a parsed assignment form, any
    // parsed PDF, or the first PDF.
    const form = parsedForms.slice().sort((x, y) => formRank(y) - formRank(x))[0] || null;
    const noReplyAddr = a => (rules.noReplySenders || []).map(s => s.toLowerCase()).includes(String(a || '').toLowerCase());
    const groupKey = normFile(subjectFile || (formRank(form) >= 2 ? form.parsed.file : '') || '') || null;
    if (groupKey) touched.add(groupKey);
    const existing = findExisting(groupKey, patients);
    const group = groupKey ? await store.findGroupTask(groupKey, 14) : null;

    // Enrollment emails only complete an open new-patient item
    if (kind === 'enrollment_doc' && !group) {
      counts.skipped++;
      log(`  skip    enrollment email for #${groupKey || '?'} — no open new-patient item (left in your inbox)`);
      return;
    }

    // Already a VaPiq patient and not part of a recent new-patient item → prescription to apply
    if (existing && !group && kind === 'assignment' && !isNewPatientSubject(email.subject, rules) && !transfer) {
      const rxForms = parsedForms.length ? parsedForms
        : [{ key: sha(`${email.messageId}|prescription`), pdf: { name: files[0] ? files[0].name : '' }, parsed: null, warnings: [] }];
      for (const f of rxForms) {
        const id = await store.insertTask({ ...replyBase, kind: 'prescription', status: 'todo', source_key: f.key,
          file_number: groupKey, group_key: groupKey, existing_patient: existingSummary(existing),
          related_emails: [emailRef(email)],
          details: { excerpt, pdf_dose: f.parsed?.dose || null, pdf_due_date: f.parsed?.date || null, attachment_name: f.pdf.name, signature: replies.signature || '' },
          warnings: f.warnings, reply_body: draft('prescription', groupKey) });
        await store.audit('ASSISTANT_PRESCRIPTION', groupKey, { task_id: id, test: !!isTest });
        counts.prescriptions++;
        log(`  rx      card ${id}`);
      }
      await source.markHandled(email);
      return;
    }

    // Pre-filled new-patient card from the best form (once per patient)
    let pendingId = group?.pending_id || null;
    const cardWarnings = form ? [...form.warnings] : [];
    const current = pendingId && form && !existing ? await store.getCard(pendingId) : null;
    const better = current && current.status === 'pending' && formRank(form) > nameRank(current.attachment_name);
    if (((!pendingId && form) || better) && !existing) {
      let fileNumber = form.parsed?.file || '';
      if (!fileNumber && subjectFile) { fileNumber = subjectFile; cardWarnings.push('File # taken from the email subject (not found in the PDF).'); }
      else if (fileNumber && subjectFile && normFile(fileNumber) !== normFile(subjectFile)) cardWarnings.push(`File # in the PDF (${fileNumber}) differs from the email subject (${subjectFile}).`);
      // Months from the (scanned) assignment form → total doses on the card made from the enrollment form
      const period = parsedForms.map(f => f.parsed).find(p => p && p.months && p !== form.parsed);
      if (form.parsed && !form.parsed.totalDoses && period) {
        if (form.parsed.dose && period.periodDose && form.parsed.dose !== period.periodDose)
          cardWarnings.push(`The assignment form marks ${period.periodDose} mg but the enrollment form says ${form.parsed.dose} mg — check the dose and total doses.`);
        else {
          const rp = repeatsFor(form.parsed.dose || period.periodDose, form.parsed.injections, period.months);
          Object.assign(form.parsed, { totalDoses: rp.total, totalWhy: rp.why });
        }
      }
      const earlier = (group && group.details) || {};
      const signature = said.signature || !!earlier.signature_required;
      const due = said.due || earlier.email_due || '';
      const note = said.due ? said.note : (earlier.email_note || '');
      const formDue = form.parsed && toIsoDate(form.parsed.date);
      if (due && formDue && formDue !== due) cardWarnings.push(`Due date from the coordinator's email (${due}) replaces the form's (${formDue}).`);
      const moved = said.transfer || earlier.transfer || '';
      const { record, missing } = buildRecord(form.parsed, { fileNumber, dueDate: due,
        specialInstructions: [cardNotes({ signature, note }), moved ? `Temporary transfer: ${moved}` : ''].filter(Boolean).join(' | ') });
      if (moved) record.assignment_type = 'Temporary';   // temporarily transferred to this nurse
      if (form.parsed && !form.parsed.totalDoses && form.parsed.totalWhy) cardWarnings.push(form.parsed.totalWhy);
      // Nothing on the forms → the default is used: say so, so it is checked (Oct 25, 2026)
      else if (!(form.parsed && form.parsed.totalDoses)) cardWarnings.push(`${DEFAULT_TOTAL_NOTE} ${record.total_doses} — not marked on the forms. Please check.`);
      for (const p of sameNameOtherFile(record.patient_name, fileNumber, patients)) cardWarnings.push(`Same name as existing patient #${p.file_number} (${patientStatus(p)}) — possible duplicate.`);
      const card = {
        email_from: email.from, email_subject: email.subject, email_date: email.date,
        attachment_name: form.pdf.name, subject_file_number: subjectFile || null,
        record, missing_fields: missing, warnings: cardWarnings, existing_patient: null,
      };
      if (better) {
        // A better source arrived (e.g. the enrollment form after a scan): rebuild the waiting card
        await store.replaceCard(pendingId, card);
        log(`  rebuilt card ${pendingId} from ${form.pdf.name.replace(/\d/g, '#')}`);
      } else {
        pendingId = await store.insertPending({ status: 'pending', is_test: !!isTest, source_key: form.key, ...card });
      }
      await store.audit(better ? 'ASSISTANT_CARD_REBUILT' : 'ASSISTANT_QUEUED', fileNumber, { pending_id: pendingId, test: !!isTest });
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
      if (saysSomething) {
        fields.details = { ...(group.details || {}), ...remember(said) };
        if (pendingId) await store.patchCard(pendingId, { due: said.due, notes: cardNotes({ signature: said.signature, note: said.note }) });
      }
      // Reply goes to the coordinator, in the coordinator's thread
      if ((!fromDocs || signer) && (group.to_address === reports || noReplyAddr(group.to_address))) {
        fields.details = { ...(fields.details || group.details || {}), ...(excerpt ? { excerpt } : {}) };   // reply to her message
        Object.assign(fields, { to_address: coordAddress, to_name: coordName,
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
      const to = noReply ? reports : coordAddress;
      const id = await store.insertTask({ ...replyBase, kind: 'new_patient', status: 'todo',
        source_key: sha(`${email.messageId}|new_patient`), pending_id: pendingId, group_key: groupKey,
        details: { excerpt, signature: replies.signature || '', ...remember(said) },
        file_number: groupKey, cc_addresses: to === reports ? [] : [reports], to_address: to, to_name: noReply ? null : coordName,
        existing_patient: existingSummary(existing), related_emails: [emailRef(email)], documents: docs, warnings,
        reply_body: replies.enabled === false ? null : draftReply({ kind: 'new_patient', lang, coordinatorName: noReply ? '' : (coordName || ''), fileNumber: groupKey,
          subjectRef, signature: replies.signature || '', docs }) });
      log(`  new     patient item ${id}${missingDocs(docs).length ? ` (missing: ${missingDocs(docs).join(', ')})` : ''}`);
    }
    await source.markHandled(email);
  };
  for await (const email of source.emails()) await handle(email);

  // Medicum sends one patient's documents in separate emails (coordinator note,
  // no-reply@ "New Appointment" with the forms, reports@ copies). When an item is
  // still missing a form, look for the other emails with the same file number —
  // in the Inbox and the Medicum folder — and read them too (Oct 23, 2026).
  if (source.findRelated) {
    for (const key of await relatedToLookFor(store, touched, relatedStateFile)) {
      const known = id => store.knownMessage(id);
      for await (const email of source.findRelated(key, { known })) await handle(email);
    }
  }
  return counts;
}

// Items worth a search: touched this run, or open and incomplete (at most every 30 min each).
async function relatedToLookFor(store, touched, file) {
  let last = {}; try { last = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const now = Date.now(), keys = new Set(touched);
  for (const t of await store.openNewPatientItems(14)) {
    const incomplete = !t.pending_id || missingDocs(t.documents || {}).length;
    if (incomplete && now - (last[t.group_key] || 0) > 30 * 6e4) keys.add(t.group_key);
  }
  const out = [];
  for (const k of keys) {
    const t = await store.findGroupTask(k, 14);
    if (!t || !['todo', 'waiting_docs', 'reply_ready'].includes(t.status)) continue;
    if (t.pending_id && !missingDocs(t.documents || {}).length && !(await weakCard(store, t.pending_id))) continue;
    out.push(k); last[k] = now;
  }
  try { fs.writeFileSync(file, JSON.stringify(last)); } catch {}
  return out;
}
async function weakCard(store, pendingId) {
  const c = await store.getCard(pendingId);
  return !!c && c.status === 'pending' && nameRank(c.attachment_name) < 3;
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
      ? imapSource(cfg.imap, { wanted: e => !!classifyEmail(e, cfg.rules).kind
          || ((replyAllowed(e.from, cfg.rules) || (senderAllowed(e.from, cfg.rules) && !!subjectFileNumber(e.subject))) && !/^\s*(re|tr|fw|fwd)\s*:/i.test(e.subject)) })
      : testFolderSource(path.resolve(here, cfg.testInbox));

    console.log(`[${new Date().toISOString()}] intake: ${live ? 'LIVE' : 'TEST'} · ${source.name} · ${store.kind}`);
    const counts = await runIntake({ source, store, rules: cfg.rules, replies: cfg.replies, isTest: !live });
    console.log(`  emails ${counts.emails}, ignored ${counts.skipped}, already handled ${counts.already}, ` +
      `new ${counts.queued}, prescriptions ${counts.prescriptions}, close-file ${counts.closes}, ` +
      `duplicates ${counts.exists}, needs reading ${counts.needsReview}, questions ${counts.questions || 0}`);
    const sourceName = source.name;
    await source.close(); source = null;

    // Replies you approved
    if (live) mailer = liveMailer(cfg.imap, cfg.replies);
    const out = await runOutbox({ store, mailer, testMailer: tMailer, rules: cfg.rules, live, moveToFolder: cfg.replies.moveToFolder });
    if (out.sent || out.failed) console.log(`  replies sent ${out.sent}, failed ${out.failed}`);
    // "Leave it" in Dubbi: take the ★ off those emails so they look untouched
    for (const t of await store.tasksToLeave()) {
      const m = t.is_test ? tMailer : (live ? mailer : null);
      if (!m) continue;
      try { await m.unflag(t); await store.updateTask(t.id, { details: { ...t.details, left: new Date().toISOString() } }); console.log(`  left    ${t.id} in the Inbox`); }
      catch (e) { console.warn('  leave-it failed:', e.message); }
    }

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
