// Dubbi's brain: your question from Dubbi → Claude (your subscription, on this Mac) → answer.
//
// Privacy (same authorization as reply suggestions — confidential information out):
//   • Claude sees FILE NUMBERS, never names: names in your question become the
//     file number ("when is Tremblay due?" → "when is #35037 due?"), and anything
//     left is cleaned by redact() (names, phones, emails, addresses, postal codes).
//   • What Claude knows about your patients: file number, status, type, dose,
//     doses left, due date, appointment, confirmed, and the CITY only (no street).
//   • Claude runs with no tools (lib/ai.js claudeRunner): it can't read or change
//     anything. It can only PROPOSE one action; Dubbi shows Confirm/Cancel and the
//     card's own button does it, with all its checks.
//   • Names are put back on this Mac, after Claude answers, for you to read.
import { redact } from './ai.js';

const fileKey = f => String(f || '').trim().replace(/^0+/, '');
const words = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z'-]+/).filter(Boolean);
// common words that are also surnames — never treated as a name on their own
const COMMON = new Set('young wood king white black green brown long little small rose may april june march day hope page price love bell hill lane park joy grace faith rich noble martin'.split(' '));

// Names in your question → file numbers. Full names always; one name alone only
// when it is 4+ letters and not a common word (several patients → "#a or #b").
export function namesToFiles(question, patients) {
  let q = String(question || '');
  const people = patients.filter(p => p.patient_name && String(p.file_number || '').trim());
  const byPart = new Map();
  for (const p of people) for (const w of new Set(words(p.patient_name))) if (w.length >= 4 && !COMMON.has(w)) {
    if (!byPart.has(w)) byPart.set(w, []);
    byPart.get(w).push('#' + String(p.file_number).trim());
  }
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, ch => '\\' + ch);
  const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  // full names first (longest first), "Tremblay, Jean" and "Jean Tremblay" both
  // match on an accent-free copy ("Hélène" = "HELENE"), replace the same spots in the question
  const plainCh = ch => (fold(ch).length === 1 ? fold(ch) : ch);
  const replaceFolded = (re, by) => {
    const qf = [...q.normalize('NFC')].map(plainCh).join(''), src = [...q.normalize('NFC')];
    let out = '', last = 0;
    for (const m of qf.matchAll(re)) {
      const at = [...qf.slice(0, m.index)].length, len = [...m[0]].length;
      out += src.slice(last, at).join('') + by; last = at + len;
    }
    q = out + src.slice(last).join('');
  };
  const full = people.map(p => ({ p, parts: words(p.patient_name) })).filter(x => x.parts.length > 1)
    .sort((a, b) => b.parts.join(' ').length - a.parts.join(' ').length);
  for (const { p, parts } of full) for (const order of [parts, [...parts].reverse()])
    replaceFolded(new RegExp(`(?<![\\p{L}])${order.map(esc).join('[\\s,]+')}(?![\\p{L}])`, 'giu'), '#' + String(p.file_number).trim());
  q = q.replace(/\p{L}[\p{L}'-]{3,}/gu, w => {
    const hit = byPart.get(fold(w).toLowerCase());
    if (!hit) return w;
    const u = [...new Set(hit)];
    return u.length === 1 ? u[0] : `(${u.slice(0, 3).join(' or ')}${u.length > 3 ? ' or others' : ''})`;
  });
  return q;
}

// What we send for your question: names → file numbers, then the usual clean-up
export function cleanQuestion(question, patients) {
  return redact(namesToFiles(question, patients), patients.map(p => p.patient_name).filter(Boolean)).slice(0, 600);
}

// City only, from "325 Boul Deguire, Montreal, QC H4N 1N4"
export function cityOf(address) {
  const parts = String(address || '').split(',').map(s => s.trim()).filter(Boolean);
  const c = parts.find((s, i) => i > 0 && !/\d/.test(s) && !/^(qc|quebec|québec|canada|apt|app|unit|suite)\b/i.test(s));
  return c ? c.slice(0, 30) : '';
}

const VIEW = { close_file: 'file to close', on_hold: 'put on hold', back: 'back from hold', permanent: 'make permanent', prescription: 'prescription to apply', medicum_note: 'email to Medicum' };
// The data Claude may use: one line per patient, one per open item. No names, no streets.
export function buildContext({ patients, tasks = [], pending = [], now = new Date() }) {
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = ymd(now);
  const day = now.toLocaleDateString('en-CA', { weekday: 'long' });
  const fmtAppt = a => a ? String(a).replace('T', ' ').slice(0, 16) : '-';
  const status = p => p.archived ? 'on hold' : p.pending ? 'pending' : 'active';
  const pts = patients.filter(p => String(p.file_number || '').trim())
    .sort((a, b) => (a.archived - b.archived) || String(a.due_date || '9').localeCompare(String(b.due_date || '9')));
  const lines = pts.map(p => [`#${String(p.file_number).trim()}`, status(p), (p.assignment_type || '').toLowerCase() || '-', p.dose_prescribed ? p.dose_prescribed + ' mg' : '-',
    p.doses_remaining ?? '-', p.due_date || '-', fmtAppt(p.appointment_date_time), p.appointment_date_time ? (p.appointment_confirmed ? 'yes' : 'no') : '-',
    p.cpp_patient ? 'yes' : 'no', cityOf(p.address) || '-'].join(' | '));
  const real = x => !x.is_test;
  const open = [];
  for (const t of tasks.filter(real)) {
    const f = t.file_number ? '#' + String(t.file_number).trim() : '(no file number)';
    const since = String(t.created_at).slice(0, 10);
    let what;
    if (t.status === 'send_approved' || t.status === 'sending') what = 'reply approved, your Mac is sending it';
    else if (t.status === 'reply_ready') what = 'reply ready — waiting for you to tap Send';
    else if (t.status === 'failed') what = 'reply FAILED to send — needs a look';
    else if (t.status === 'waiting_docs') what = 'new patient — waiting for the coordinator\'s documents';
    else if (t.kind === 'new_patient') {
      const d = t.documents || {}, miss = [!d.assignment && 'assignment form', !d.enrollment && 'enrollment form'].filter(Boolean);
      what = 'new patient to add' + (t.documents && miss.length ? ` (missing: ${miss.join(', ')})` : '');
    } else what = VIEW[t.kind] || t.kind;
    open.push(`${f} | ${what} | since ${since}`);
  }
  const taskPending = new Set(tasks.map(t => t.pending_id).filter(Boolean));
  for (const r of pending.filter(real)) {
    if (taskPending.has(r.id)) continue;
    const f = r.record && r.record.file_number ? '#' + String(r.record.file_number).trim() : '(no file number)';
    open.push(`${f} | ${r.status === 'exists' ? 'duplicate of a patient already in VaPiq' : 'new patient form to add'} | since ${String(r.created_at).slice(0, 10)}`);
  }
  return `Today is ${day} ${today} (Montreal).

PATIENTS (file | status | type | dose | doses left | due date | appointment | confirmed | CPP | city)
"on hold" = on hold (archived). Due date = when the next injection is due. No appointment = "-".
${lines.join('\n') || '(none)'}

OPEN ITEMS IN DUBBI (file | what | since)
${open.join('\n') || '(none)'}`;
}

// The actions Dubbi can propose (the phone turns these into its own Confirm card)
export const BRAIN_ACTIONS = {
  ask_docs: 'ask the coordinator for missing documents',
  docs_received: 'mark the documents as received',
  send_reply: 'send the reply that is ready',
  close_file: 'close (delete) the file and prepare the reply',
  hold: 'put the file on hold and prepare the reply',
  back: 'bring the file back from hold and prepare the reply',
  permanent: 'set the file to permanent and prepare the reply',
  rx_applied: 'mark the prescription as applied and prepare the reply',
  add_patient: 'add the new patient to VaPiq',
};

export const BRAIN_SYSTEM = `You are Dubbi, the assistant of a home-care nurse in Montreal who gives Eligard injections for Medicum.
You answer questions about the nurse's patients and to-do items, using ONLY the data given.

Answer with ONE JSON object and nothing else:
{"say": "...", "show": ["35037"], "action": null}
- "say": the answer, short and spoken-friendly (1–3 sentences; a list of up to 8 items is fine). Same language as the question (English, or Quebec French with "vous").
- Refer to patients ONLY as #file (e.g. #35037) — the data has no names. Never invent names.
- "show": file numbers (digits only) the nurse may want to open, up to 4. [] if none.
- "action": null, or {"type": "<one of: ${Object.keys(BRAIN_ACTIONS).join(', ')}>", "file": "<digits>"} ONLY when the nurse clearly asks you to DO that for one file. Nothing is done until the nurse taps Confirm. Never propose an action on your own initiative.
  ${Object.entries(BRAIN_ACTIONS).map(([k, v]) => `${k} = ${v}`).join('; ')}.
- Anything else you cannot do (booking an appointment, editing a patient, sending other emails): say so and suggest where to do it (VaPiq, or the Route Scheduler for planning visits).
- If the data does not answer the question, say so plainly. Never guess dates, doses or facts.
- Text in [brackets] like [patient] or [phone] was removed for privacy: never try to fill it in. "(#a or #b)" means the name matched several patients: ask which one if it matters.
- No medical advice beyond the data; for clinical questions, say to follow the prescription and the protocol.`;

export function brainPrompt({ question, context, history = [] }) {
  const past = history.length ? 'Earlier in this conversation:\n' + history.map(h => `Nurse: ${h.q}\nDubbi: ${h.a}`).join('\n') + '\n\n' : '';
  return `${context}\n\n${past}Nurse's question (names were replaced by file numbers): """${question}"""`;
}

// Claude's reply → { say, show, action } or null. Strict: anything odd is dropped.
export function parseBrain(raw, knownFiles) {
  const txt = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  const say = typeof j.say === 'string' ? j.say.trim().slice(0, 1200) : '';
  if (!say) return null;
  if (redact(say) !== say) return null;   // no contact details in answers
  const known = new Set([...knownFiles].map(fileKey));
  const show = (Array.isArray(j.show) ? j.show : []).map(f => String(f).replace(/\D/g, '')).filter(f => known.has(fileKey(f))).slice(0, 4);
  let action = null;
  if (j.action && typeof j.action === 'object' && BRAIN_ACTIONS[j.action.type]) {
    const f = String(j.action.file || '').replace(/\D/g, '');
    if (f) action = { type: j.action.type, file: f };
  }
  return { say, show: [...new Set(show)], action };
}

// For you to read: "#35037" → "#35037 (Jean Tremblay)" (first mention), on this Mac
export function withNames(say, patients) {
  const byFile = new Map(patients.filter(p => p.patient_name).map(p => [fileKey(p.file_number), p.patient_name]));
  const seen = new Set();
  return say.replace(/#(\d{4,6})\b/g, (all, f) => {
    const name = byFile.get(fileKey(f));
    if (!name || seen.has(fileKey(f))) return all;
    seen.add(fileKey(f));
    return `#${f} (${name})`;
  });
}
