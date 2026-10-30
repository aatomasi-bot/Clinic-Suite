// Dubbi's case brain: everything about ONE patient file, read together.
// Medicum writes about a patient in several emails (coordinator, reports@ fax, no-reply@
// forms, replies in the thread) and a newer email can change what an older one said
// ("close the file" → "continue injections" → "he is travelling for a month").
// The Mac puts the emails in date order with VaPiq's record and the open cards, Claude
// works out what is true NOW and proposes the actions; you confirm in Dubbi.
//
// Privacy: the same rules as the rest of the brain — names, phones, emails, addresses
// are removed before anything goes to Claude (redact), Claude runs with no tools, and
// it only PROPOSES. Unknown PDFs are asked about by the Mac (real file name, on your
// phone), never by Claude.
import crypto from 'node:crypto';
import { redact } from './ai.js';

const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);

// ── File numbers in a text: 4–6 digits, but never a year, a phone part or a fax id ──
export function fileNumbersIn(text) {
  const s = redact(String(text || ''))                        // phones, postal codes, emails out first
    .replace(/\b(?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g, ' ') // 2026-10-30
    .replace(/\b(?:FAX|IMG|scan)[_\w-]*\.pdf\b/gi, ' ')        // FAX_20261030_179… file names
    .replace(/_/g, ' ');                                       // "Generated_20062.pdf" → a word boundary
  const out = [];
  for (const m of s.matchAll(/(?<![\d#-])#?\b(\d{4,6})\b(?![-/]\d)/g)) {
    const n = m[1];
    if (n.length === 4 && /^(19|20)\d{2}$/.test(n)) continue;  // a year ("October 29th 2026")
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// ── What a PDF is: learned from you (memory), else from its name ─────────────────
export const PDF_TYPES = {
  prescription: { en: 'Prescription', fr: 'Ordonnance', doc: 'copy' },
  enrollment:   { en: 'Enrollment form', fr: "Formulaire d'inscription", doc: 'enrollment' },
  assignment:   { en: 'Assignment form', fr: "Formulaire d'assignation", doc: 'assignment' },
  nurse_report: { en: 'Nurse report', fr: 'Rapport infirmier', doc: 'copy' },
  lab:          { en: 'Lab / blood test', fr: 'Analyse de sang', doc: 'copy' },
  old_copy:     { en: 'Old copy (ignore)', fr: 'Ancienne copie (ignorer)', doc: 'copy' },
};
// "IMG_20220826_0001.pdf" → "img_#_#.pdf"; the patient's own name → "name"
export function pdfPattern(name, personNames = []) {
  let s = String(name || '').trim().toLowerCase();
  for (const n of personNames) for (const part of String(n || '').toLowerCase().split(/[\s,]+/).filter(p => p.length > 1))
    s = s.split(part).join('name');
  return s.replace(/\d+/g, '#').replace(/\s+/g, ' ');
}
// memory: [{ key: 'pdf:<exact>' | 'pdfp:<pattern>', value }] → the type word or ''
export function learnedType(name, memory = [], personNames = []) {
  const m = new Map(memory.map(x => [x.key, x.value]));
  return m.get('pdf:' + String(name || '').trim().toLowerCase()) || m.get('pdfp:' + pdfPattern(name, personNames)) || '';
}
// Known from its name alone (Medicum's usual files)
export function nameType(name) {
  const n = String(name || '');
  if (/^(fax|rx)|ordonnance|prescription/i.test(n)) return 'prescription';
  if (/nurse[\s_-]*report/i.test(n)) return 'nurse_report';
  if (/enrol|inscri|consent|generated/i.test(n)) return 'enrollment';
  if (/^[A-Z]{0,4}\s*[1-9]\d{3,5}(?:\s*_?new\w*)?\.(pdf|jpe?g|png)$/i.test(n)) return 'assignment';
  return '';
}

// The coordinator's own words: no quoted history, no signature block or disclaimer
export function messageText(body) {
  let s = String(body || '').replace(/\r/g, '').split(/\n\s*(?:From|De|Envoyé|Sent)\s*:|\n-{2,}\s*Original|\nOn .{5,80}wrote:|\nLe .{5,80}a écrit/i)[0];
  s = s.split(/\n.*(?:Le présent message|This email and any|Programme d.assistance aux patients|Coordonnat|Patient Coordinator|^T\.\s*1-8)/im)[0];
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2500);
}

const role = addr => /^reports@/i.test(addr) ? 'Medicum fax (reports@)' : /^no-?reply@/i.test(addr) ? 'Medicum portal (no-reply@)' : 'coordinator';
const ymdhm = d => d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '?';

// One case → { text for Claude (no names), basis, questions for you (real names), emails }
// emails: rows of dubbi_emails for this file, any order. tasks: open email_tasks for this file.
export function buildCase({ file, emails, patient, tasks = [], memory = [], now = new Date() }) {
  const names = [patient && patient.patient_name].filter(Boolean);
  const list = emails.slice().sort((a, b) => new Date(a.email_date) - new Date(b.email_date));
  const known = new Map();   // PDF types already ticked on a card
  for (const t of tasks) for (const f of (t.documents && t.documents.files) || []) if ((f.types || []).length) known.set(f.name, f.types[0] === 'copy' ? 'prescription' : f.types[0]);
  const questions = [], lines = [];
  list.forEach((e, i) => {
    const pdfs = (e.attachments || []).map(a => {
      const type = learnedType(a.name, memory, names) || known.get(a.name) || nameType(a.name);
      if (!type && !questions.some(q => q.pdf === a.name) && now - new Date(e.email_date) < 21 * 864e5)
        questions.push({ pdf: a.name, email: i + 1, pattern: pdfPattern(a.name, names) });
      return `${redact(a.name, names).replace(/\[patient\]/g, 'NAME')} = ${type ? (PDF_TYPES[type] ? PDF_TYPES[type].en : type) : 'UNKNOWN (asking the nurse)'}`;
    });
    lines.push(`E${i + 1} | ${ymdhm(e.email_date)} | from ${role(e.from_addr)}${role(e.from_addr) === 'coordinator' ? ' ' + (e.from_name || '').split(/\s+/)[0] : ''} | subject: ${redact(e.subject, names)}`
      + (pdfs.length ? `\n   PDFs: ${pdfs.join('; ')}` : '')
      + `\n   """${redact(messageText(e.body), names).replace(/\n+/g, ' ⏎ ')}"""`);
  });
  const p = patient;
  const vapiq = p ? [
    `status: ${p.archived ? 'ON HOLD' : p.pending ? 'pending' : 'active'}`,
    `type: ${p.assignment_type || '?'}`, `dose: ${p.dose_prescribed || '?'} mg`, `doses left: ${p.doses_remaining ?? '?'}`,
    `due: ${p.due_date || '?'}`, `appointment: ${p.appointment_date_time ? String(p.appointment_date_time).slice(0, 16).replace('T', ' ') + (p.appointment_confirmed ? ' (confirmed)' : ' (not confirmed)') : 'none'}`,
    p.special_instructions ? `notes: ${redact(String(p.special_instructions), names).slice(0, 300)}` : '',
  ].filter(Boolean).join(' | ') : 'NOT IN VaPiq';
  const cards = tasks.map(t => `C:${t.id} | ${t.kind} | ${t.status} | from email dated ${ymdhm(t.email_date)} | subject: ${redact(t.email_subject || '', names)}`);
  const text = `Today: ${ymdhm(now).slice(0, 10)} (${now.toLocaleDateString('en-CA', { weekday: 'long' })})\nFile #${file}\n\nVaPiq record: ${vapiq}\n\nEmails, oldest first:\n${lines.join('\n') || '(none)'}\n\nOpen cards in Dubbi:\n${cards.join('\n') || '(none)'}`;
  // Re-read the case only when the emails or what you taught it change (not when VaPiq changes
  // because you acted on it)
  const basis = sha([file, ...list.map(e => e.message_id + (e.attachments || []).map(a => learnedType(a.name, memory, names)).join(','))].join('|'));
  return { text, basis, questions: questions.slice(0, 4), emails: list };
}

// ── What we ask Claude ───────────────────────────────────────────────────────────
export const CASE_ACTIONS = {
  back:         'take the file off hold in VaPiq (fields: due "YYYY-MM-DD" optional)',
  on_hold:      'put the file on hold in VaPiq (fields: reason)',
  set_due:      'change the due date (fields: due "YYYY-MM-DD")',
  set_dose:     'change the prescribed dose (fields: dose one of 7.5, 22.5, 30, 45; doses_left optional number)',
  add_note:     'add a short note to the patient\'s special instructions (fields: text, max 150 chars; no date — Dubbi adds it)',
  clear_appointment: 'remove the booked appointment (fields: none) — only if an email clearly says it cannot happen',
  close_file:   'DELETE the file from VaPiq (only if the LATEST relevant email asks to close it and nothing newer contradicts it)',
  dismiss_card: 'dismiss an open card that a newer email made obsolete (fields: card = the card id after "C:")',
  reply:        'reply to a coordinator (fields: email = "E<n>" of the coordinator email to answer, text = the full reply)',
  call_patient: 'remind the nurse to phone the patient (fields: text = what to ask or arrange, max 150 chars)',
};
export const CASE_SYSTEM = `You are Dubbi, the assistant of a home-care nurse in Montreal who gives injections (Eligard) for Medicum, an injection program. You read everything about ONE patient file and work out what is true NOW.
Rules:
- Emails are numbered E1… oldest first. A NEWER email overrides an older one when they disagree (e.g. "close the file" then later "continue injections" → do not close). Replies in a thread ("Re: …") count — they are often the latest word.
- reports@ sends faxed copies (usually a prescription). no-reply@ sends Medicum's portal forms. Coordinators write the instructions.
- "New prescription" or "continue injections" for a file that is ON HOLD in VaPiq usually means: take it off hold (back), with the due date from the emails.
- Compare with the VaPiq record: only propose what would actually change something. Never propose what is already true.
- If an open card already does the right thing, say "keep" — and still list its action in your plan (doing your plan completes that card). If a newer email made a card wrong, say "obsolete" and propose dismiss_card for it.
- A new_patient card for a file that is ALREADY in VaPiq is obsolete (the patient exists; propose back / set_dose / set_due instead). Forms re-sent for an existing patient are just paperwork.
- At most ONE reply per coordinator: answer her LATEST email in one message covering everything. Other open reply/question cards for the same patient become obsolete.
- Text in [brackets] was removed for privacy; never guess it. Never write a patient's name. Refer to the patient as "the patient" or by file number.
- Never invent dates, doses or facts. If something is unclear, say so in the summary and propose call_patient or a reply asking the coordinator.
- Replies: short, warm, professional, in the language of the coordinator's email; start "Hello <first name>," (or "Bonjour <prénom>,"), then a blank line, the message, a blank line, "Thank you!" (or "Merci!"), a blank line, and the signature line given below. Only state what is true or what the nurse will do through your proposed actions.
- Action types allowed:
${Object.entries(CASE_ACTIONS).map(([k, v]) => `  ${k}: ${v}`).join('\n')}
Answer with ONLY a JSON object, no markdown:
{"headline":"max 70 chars, what's happening now","summary":"2–4 short sentences: the current situation and why, mentioning which email changed what","urgent":true|false,"cards":{"<card id>":"keep"|"obsolete"},"actions":[{"type":"…", "why":"max 100 chars", …fields}]}
Put actions in the order they should be done. Use an empty actions list when nothing needs doing.`;

export const casePrompt = ({ text, signature }) => `${text}\n\nThe nurse's signature line for replies: ${signature || '(none)'}\n\nWhat is true now, and what should the nurse do?`;

const DOSES = ['7.5', '22.5', '30', '45'];
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s));
const short = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Strict check of Claude's answer → { headline, summary, urgent, cards, actions } or null
export function parseCase(raw, { cardIds = [], emails = [], replyAllowed = () => true } = {}) {
  let o;
  try { o = JSON.parse(String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return null; }
  if (!o || typeof o !== 'object' || !o.summary) return null;
  const cards = {};
  for (const [id, v] of Object.entries(o.cards || {})) { const cid = id.replace(/^C:/, ''); if (cardIds.includes(cid) && ['keep', 'obsolete'].includes(v)) cards[cid] = v; }
  const actions = [];
  for (const a of Array.isArray(o.actions) ? o.actions.slice(0, 8) : []) {
    if (!a || !CASE_ACTIONS[a.type]) continue;
    const why = short(a.why, 120), x = { type: a.type, why };
    if (a.type === 'back') { if (a.due && isDay(a.due)) x.due = a.due; }
    else if (a.type === 'on_hold') x.reason = short(a.reason, 150) || 'see coordinator email';
    else if (a.type === 'set_due') { if (!isDay(a.due)) continue; x.due = a.due; }
    else if (a.type === 'set_dose') { const d = String(a.dose).replace(/\s*mg$/i, ''); if (!DOSES.includes(d)) continue; x.dose = d; if (Number.isInteger(+a.doses_left) && +a.doses_left >= 0 && +a.doses_left < 30) x.doses_left = +a.doses_left; }
    else if (a.type === 'add_note' || a.type === 'call_patient') { x.text = short(a.text, 160); if (!x.text) continue; }
    else if (a.type === 'dismiss_card') { const c = String(a.card || '').replace(/^C:/, ''); if (!cardIds.includes(c)) continue; x.card = c; }
    else if (a.type === 'reply') {
      const n = Number(String(a.email || '').replace(/^E/i, '')), e = emails[n - 1];
      if (!e || !replyAllowed(e.from_addr)) continue;
      const text = String(a.text || '').trim();
      if (text.length < 15 || text.length > 2000 || redact(text) !== text) continue;   // no contact details in a reply
      x.email = e.message_id; x.text = text;
      // what Dubbi needs to answer in that email's thread
      Object.assign(x, { to: e.from_addr, to_name: String(e.from_name || '').split(/\s+/)[0] || null, subject: e.subject || '', folder: e.folder || null,
        date: e.email_date || null, lang: /^\s*(bonjour|allo)\b/i.test(text) ? 'fr' : 'en' });
    }
    // no two of the same change (a model sometimes repeats itself)
    if (!['dismiss_card', 'add_note', 'call_patient'].includes(x.type) && actions.some(y => y.type === x.type)) continue;
    actions.push(x);
  }
  return { headline: short(o.headline, 90) || short(o.summary, 90), summary: short(o.summary, 700), urgent: o.urgent === true, cards, actions };
}
