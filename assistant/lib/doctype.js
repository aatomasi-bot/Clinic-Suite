// Recognises which document a PDF is, from its text (or file name when the
// PDF is a scanned fax with no text). A multi-page fax can be both.
//   assignment  — the Medicum injection assignment form we parse
//   enrollment  — the patient enrollment / consent form
// Unknown scanned PDFs are left for you to tick on the card.

const ASSIGNMENT_TEXT = /MEDICUM\s*#|PATIENT\s+NAME\s*\/\s*NOM\s+DU\s+PATIENT|NOM\s+DU\s+PATIENT|INJECTION\s+DUE\s+DAY/i;
const ENROLLMENT_TEXT = /ENROL+(?:MENT)?\b|INSCRIPTION|CONSENT(?:EMENT)?\b|ADH[ÉE]SION|PROGRAMME?\s+(?:DE\s+SOUTIEN|SUPPORT)|PATIENT\s+SUPPORT\s+PROGRAM/i;
// "JS12345New.pdf", "DP 12345 New.pdf", "KS12345NewReopen.pdf", "RM12345NewCPP.jpg" — Medicum's assignment form
const ASSIGNMENT_NAME = /assign|demande|request|referral|r[ée]f[ée]rence|nouveau|new.?patient|\d{4,6}\s*_?new/i;
const ENROLLMENT_NAME = /enrol|inscri|consent|adh[ée]sion/i;

export function documentTypes({ text = '', scanned = false, name = '' }) {
  // A file named as the enrollment form IS the enrollment form, even though its
  // text has the patient fields ("Enrollment_Form_Auto_Generated_12345.pdf")
  if (ENROLLMENT_NAME.test(name)) return ['enrollment'];
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
