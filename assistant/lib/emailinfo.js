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

const ASSIGNED = /(?:assigned\s+for\s+the\s+following\s+date|pour\s+la\s+date\s+suivante)\s*:?\s*([^\n(]{4,40})(?:\(([^)\n]{0,300})\)?)?/i;

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
