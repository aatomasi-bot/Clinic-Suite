// Decides whether an email is a patient assignment, from headers only.
// Rules come from config.json (see config.example.json):
//   - sender's domain is allowed (medicum.ca) and the sender isn't excluded
//   - subject matches an include pattern and no exclude pattern
//   - it has at least one PDF attachment

export function senderAddress(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

export function isAssignment(email, rules) {
  const addr = senderAddress(email.from);
  const domain = addr.split('@')[1] || '';
  if (!rules.senderDomains.map(d => d.toLowerCase()).includes(domain)) return { ok: false, why: 'sender domain' };
  if (rules.excludeSenders.map(s => s.toLowerCase()).includes(addr)) return { ok: false, why: 'excluded sender' };
  const subject = String(email.subject || '');
  if (rules.excludeSubject.some(rx => new RegExp(rx, 'i').test(subject))) return { ok: false, why: 'excluded subject' };
  if (!rules.includeSubject.some(rx => new RegExp(rx, 'i').test(subject))) return { ok: false, why: 'subject' };
  if (!email.pdfs || !email.pdfs.length) return { ok: false, why: 'no PDF' };
  return { ok: true };
}

// "New patient 34734", "Patient JGC 35290", "fax - SS #33816" → last 4–6 digit number
export function subjectFileNumber(subject) {
  const all = String(subject || '').match(/\d{4,6}/g);
  return all ? all[all.length - 1] : '';
}
