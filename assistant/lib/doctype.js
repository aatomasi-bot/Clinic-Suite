// Recognises which document a PDF is, from its text (or file name when the
// PDF is a scanned fax with no text). A multi-page fax can be both.
//   assignment  — the Medicum injection assignment form we parse
//   enrollment  — the patient enrollment / consent form
// Unknown scanned PDFs are left for you to tick on the card.

const ASSIGNMENT_TEXT = /MEDICUM\s*#|PATIENT\s+NAME\s*\/\s*NOM\s+DU\s+PATIENT|NOM\s+DU\s+PATIENT|INJECTION\s+DUE\s+DAY/i;
const ENROLLMENT_TEXT = /ENROL+(?:MENT)?\b|INSCRIPTION|CONSENT(?:EMENT)?\b|ADH[ÉE]SION|PROGRAMME?\s+(?:DE\s+SOUTIEN|SUPPORT)|PATIENT\s+SUPPORT\s+PROGRAM/i;
const ASSIGNMENT_NAME = /assign|demande|request|referral|r[ée]f[ée]rence|nouveau|new.?patient/i;
const ENROLLMENT_NAME = /enrol|inscri|consent|adh[ée]sion/i;

export function documentTypes({ text = '', scanned = false, name = '' }) {
  const t = new Set();
  if (!scanned && text) {
    if (ASSIGNMENT_TEXT.test(text)) t.add('assignment');
    if (ENROLLMENT_TEXT.test(text)) t.add('enrollment');
  }
  if (!t.size) {
    if (ENROLLMENT_NAME.test(name)) t.add('enrollment');
    else if (ASSIGNMENT_NAME.test(name)) t.add('assignment');
  }
  return [...t];   // [] = unknown (usually a scanned fax) — you tick it on the card
}

// Combine all files seen for one patient into the documents summary.
export function summarizeDocuments(files) {
  return {
    assignment: files.some(f => f.types.includes('assignment')),
    enrollment: files.some(f => f.types.includes('enrollment')),
    unknown: files.filter(f => !f.types.length).length,
    files: files.map(f => ({ name: f.name, types: f.types, from: f.from })),
  };
}
