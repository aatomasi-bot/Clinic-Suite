// Sorts coordinator emails, from headers only. Rules come from config.json
// (see config.example.json):
//   close_file  — subject asks to close a file ("Close file 32604", "Fermeture de dossier …")
//   assignment  — subject matches an include pattern, has a PDF (new patient, or a
//                 new prescription when the file number already exists in VaPiq)
//   null        — everything else (replies, on-hold, transfers, updates… left for you)
// Always: sender's domain must be allowed and the sender not excluded.

export function senderAddress(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

export function senderAllowed(from, rules) {
  const addr = senderAddress(from);
  const domain = addr.split('@')[1] || '';
  return rules.senderDomains.map(d => d.toLowerCase()).includes(domain)
    && !rules.excludeSenders.map(s => s.toLowerCase()).includes(addr);
}

const any = (list, s) => (list || []).some(rx => new RegExp(rx, 'i').test(s));

export function classifyEmail(email, rules) {
  if (!senderAllowed(email.from, rules)) return { kind: null, why: 'sender' };
  const subject = String(email.subject || '');
  if (/^\s*(re|tr|fw|fwd)\s*:/i.test(subject)) return { kind: null, why: 'reply/forward' };
  if (any(rules.closeSubject, subject)) return { kind: 'close_file' };
  if (any(rules.excludeSubject, subject)) return { kind: null, why: 'excluded subject' };
  if (!any(rules.includeSubject, subject)) return { kind: null, why: 'subject' };
  if (!email.pdfs || !email.pdfs.length) return { kind: null, why: 'no PDF' };
  return { kind: 'assignment' };
}

// Kept for callers that only care about assignments.
export function isAssignment(email, rules) {
  const c = classifyEmail(email, rules);
  return { ok: c.kind === 'assignment', why: c.why };
}

// "New patient 34734", "Patient JGC 35290", "fax - SS #33816" → last 4–6 digit number
export function subjectFileNumber(subject) {
  const all = String(subject || '').match(/\d{4,6}/g);
  return all ? all[all.length - 1] : '';
}
