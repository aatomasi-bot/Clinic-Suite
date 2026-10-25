// What the coordinator's email says about a new patient (confirmed Oct 23, 2026):
//   "…assigned for the following date: October 29th 2026 (Bone scan schedule
//    October 28th 2026 and need the injection after…)"
//   "…figure dans votre portail pour la date suivante : 21 septembre 2026."
// → due date 2026-10-29, and the note in brackets for Special Instructions.
// Signature: "*** Please have the patient sign the enrollment form …" → "Signature required!"

const MONTHS = {
  jan: 1, janv: 1, janvier: 1, january: 1, feb: 2, february: 2, fev: 2, fevr: 2, fevrier: 2,
  mar: 3, march: 3, mars: 3, apr: 4, april: 4, avr: 4, avril: 4, may: 5, mai: 5,
  jun: 6, june: 6, juin: 6, jul: 7, july: 7, juil: 7, juillet: 7, aug: 8, august: 8, aout: 8,
  sep: 9, sept: 9, september: 9, septembre: 9, oct: 10, october: 10, octobre: 10,
  nov: 11, november: 11, novembre: 11, dec: 12, december: 12, decembre: 12,
};
const plain = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const pad = n => String(n).padStart(2, '0');

// "October 29th 2026", "Nov. 2, 2026", "21 septembre 2026", "1er octobre 2026", "2026-10-29"
// (no year → the year of the email, or the next one if that would be long past)
export function readDate(s, emailDate = new Date()) {
  const t = plain(String(s || '')).replace(/,/g, ' ');
  let m = t.match(/^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  let mo, d, y;
  if ((m = t.match(/^\s*([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:\s+(\d{4}))?/))) [mo, d, y] = [MONTHS[m[1]], +m[2], m[3] && +m[3]];
  else if ((m = t.match(/^\s*(\d{1,2})(?:er|st|nd|rd|th)?\s+([a-z]{3,9})\.?(?:\s+(\d{4}))?/))) [mo, d, y] = [MONTHS[m[2]], +m[1], m[3] && +m[3]];
  if (!mo) return '';
  if (!y) {
    const e = new Date(emailDate);
    y = e.getFullYear();
    if (new Date(y, mo - 1, d) < new Date(e.getTime() - 60 * 864e5)) y++;
  }
  return valid(y, mo, d);
}
function valid(y, mo, d) {
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : '';
}

// Also "Next injection scheduled for: 9th March 2027" (reports@ prescription copy, Oct 23, 2026)
const ASSIGNED = /(?:assigned\s+for\s+the\s+following\s+date|pour\s+la\s+date\s+suivante|next\s+injection\s+(?:is\s+)?scheduled\s+(?:for|on)|prochaine\s+injection\s+(?:est\s+)?(?:pr[ée]vue|planifi[ée]e|c[ée]dul[ée]e)\s+(?:le|pour|au))\s*:?\s*([^\n(]{4,40})(?:\(([^)\n]{0,300})\)?)?/i;

// → { due: 'YYYY-MM-DD' | '', note: 'text in brackets' | '' }
export function emailDueDate(body, emailDate) {
  const m = String(body || '').replace(/\r/g, '').match(ASSIGNED);
  if (!m) return { due: '', note: '' };
  const due = readDate(m[1].trim(), emailDate);
  const note = (m[2] || '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  return { due, note: due ? note.slice(0, 200) : '' };
}

const SIGNATURE_RX = /have\s+the\s+patient\s+sign\s+the\s+enrol+ment\s+form|faire\s+signer\s+(?:le\s+)?formulaire\s+d['’]\s*(?:inscription|adh[ée]sion)/i;
export const SIGNATURE_NOTE = 'Signature required!';
export const needsSignature = text => SIGNATURE_RX.test(String(text || ''));

// Special Instructions text from what the emails said
export function cardNotes({ signature, note }) {
  return [signature ? SIGNATURE_NOTE : '', note ? `Coordinator: ${note}` : ''].filter(Boolean).join(' | ');
}

// A coordinator writing from reports@medicum.ca signs the email:
//   "Kavya Shetty / Coordonnatrice administrative des patients/… / kavyas@medicum.ca"
// → { address: 'kavyas@medicum.ca', firstName: 'Kavya' } (the reply goes to her, CC reports@)
const SHARED = /^(?:reports|no-?reply|nsd|info|admin|fax|support)@/i;
export function signedBy(body) {
  const text = String(body || '').replace(/\r/g, '').split(/\n(?:From|De)\s*:|\n-{2,}\s*Original/i)[0];   // not quoted history
  const address = (text.match(/\b[a-z0-9._-]+@medicum\.ca\b/gi) || []).map(a => a.toLowerCase()).find(a => !SHARED.test(a));
  if (!address) return null;
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
  const role = lines.findIndex(l => /coordonnat|coordinat/i.test(l));
  const nameLine = role > 0 ? lines[role - 1] : '';
  const first = (nameLine.match(/^([A-ZÀ-Ý][a-zà-ÿ'-]+)(?:\s+[A-ZÀ-Ý][A-Za-zà-ÿ'-]+){0,3}$/) || [])[1] || '';
  return { address, firstName: first };
}

// The coordinator's own words: the message up to the sign-off — not the bilingual
// signature or confidentiality notice, which made English emails look French.
export function openingText(body) {
  const text = String(body || '').replace(/\r/g, '').split(/\n(?:From|De)\s*:|\n-{2,}\s*Original/i)[0];
  const out = [];
  for (const line of text.split(/\n/)) {
    if (/^\s*(thank|thanks|merci|regards|best|cordialement|salutations|have a (great|good|nice)|bonne (journ|fin))/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n').slice(0, 800);
}

// Patient updates from a coordinator (Oct 25, 2026), read from the subject and
// her own message (often the subject is just "Name - AB 35251"):
//   transfer  — "temporarily transferred to your portal" → new patient, Temporary
//   permanent — "will remain in your portal permanently" → Assignment Type Permanent
//   back      — "Patient is Back" / "is back from …" → out of Hold, due date from the email
//   on_hold   — "File on Hold" / "placed on hold" → moved to Hold with the reason
// → { kind, reason, due } or null
const UPDATE_RULES = [
  ['transfer', /temporar(?:y|ily)\s+transfer|transf[ée]r[ée]e?\s+temporairement|transfert\s+temporaire/i],
  ['permanent', /permanently\s+in\s+your\s+portal|in\s+your\s+portal\s+permanently|remain\s+in\s+your\s+portal\s+permanently|de\s+fa[çc]on\s+permanente|en\s+permanence\s+dans\s+votre\s+portail/i],
  ['back', /\bpatient\s+is\s+back\b|\bis\s+(?:now\s+)?back\b|\best\s+de\s+retour\b|patient\s+de\s+retour/i],
  ['on_hold', /\bon\s*hold\b|\ben\s+attente\b|\bsuspendu|mis\s+en\s+pause|placed\s+on\s+pause/i],
];
const clean = s => s.replace(/^\s*(?:\*+\s*)?(?:please\s+(?:be\s+advised|note)\s+(?:that\s+)?|veuillez\s+(?:noter|prendre\s+note)\s+que\s+)/i, '').replace(/\s+/g, ' ').trim();
export function patientUpdate({ subject = '', body = '', date } = {}) {
  if (/^\s*(re|tr|fw|fwd)\s*:/i.test(subject)) return null;   // replies are not new requests
  const msg = openingText(body);
  const hit = UPDATE_RULES.find(([, re]) => re.test(subject) || re.test(msg));
  if (!hit) return null;
  const [kind, re] = hit;
  const sentences = msg.replace(/\n+/g, ' ').split(/(?<!\b(?:Mr|Mrs|Ms|Dr|Mme|Mlle|M|St))(?<=[.!?])\s+/);
  // "Mr. Kim 34451 is currently in hospital…" → "Currently in hospital…" (the card already shows who)
  const what = clean(sentences.find(s => re.test(s)) || sentences.find(s => s.trim().length > 20) || '')
    .replace(/^.*?\b\d{4,6}\b\s*(?:is\s+|has\s+been\s+|has\s+|will\s+|est\s+|a\s+été\s+)?/i, '');
  const reason = (what.charAt(0).toUpperCase() + what.slice(1)).slice(0, 180);
  let due = '';
  if (kind === 'back' || kind === 'transfer') {
    const m = msg.match(/(?:was\s+)?(?:due|pr[ée]vue?|d[ûu]e?)\s+(?:on\s+|le\s+|pour\s+le\s+)?([A-Za-zÀ-ÿ]+\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:er)?\s+[A-Za-zÀ-ÿ]+\s+\d{4}|\d{4}-\d{2}-\d{2})/i);
    due = (m && readDate(m[1], date)) || emailDueDate(body, date).due || '';
  }
  return { kind, reason, due };
}
