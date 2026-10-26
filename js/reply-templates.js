/* Reply drafts to Medicum coordinators — shared by the intake assistant (Node)
   and the Approvals page (browser). Drafts are only suggestions: every reply is
   shown to you, editable, and sent only after you tap Send.
     draftReply({ kind, lang, coordinatorName, fileNumber, subjectRef, signature })
       kind: 'new_patient' | 'prescription' | 'close_file'   lang: 'en' | 'fr'
     detectLanguage(text) -> 'en' | 'fr'
     coordinatorFirstName('Giulia Rodi <giuliar@medicum.ca>') -> 'Giulia'
     subjectReference('Patient JGC 35290') -> 'JGC 35290'
   Patients are referred to by file reference only ("file #35290 (JGC)") —
   gender-neutral, and no names in outgoing email. */
(function (root) {
'use strict';

const FR_WORDS = /\b(bonjour|fermeture|dossier|ordonnance|nouveau|nouvelle|patiente|merci|veuillez|svp|rendez-vous|traitement|mois)\b|[éèêàçù]/i;
const EN_WORDS = /\b(hello|hi|close|file|new|patient|please|thank|prescription|appointment|transfer|update)\b/i;

function detectLanguage(text) {
  const s = String(text || '');
  const fr = (s.match(new RegExp(FR_WORDS.source, 'gi')) || []).length;
  const en = (s.match(new RegExp(EN_WORDS.source, 'gi')) || []).length;
  return fr > en ? 'fr' : 'en';
}

// Display names that are departments, not people → greet without a name.
const NOT_A_PERSON = /^(medicum|reports?|nursing|services?|department|no-?reply|info|admin|fax)$/i;

function coordinatorFirstName(from) {
  const display = String(from || '').replace(/<[^>]*>/, '').replace(/["']/g, '').trim();
  if (!display || display.includes('@')) return '';
  // "Gareau, Amelia" → Amelia
  const first = display.includes(',') ? display.split(',')[1].trim().split(/\s+/)[0] : display.split(/\s+/)[0];
  if (!first || NOT_A_PERSON.test(first)) return '';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// "Patient JGC 35290" → "JGC 35290", "Fermeture de dossier M.S # 13328" → "M.S 13328",
// "Close File #33837 AA" → "AA 33837", "Close file 32604" → "32604"
function subjectReference(subject) {
  const s = String(subject || '');
  const nums = s.match(/\d{4,6}/g);
  if (!nums) return '';
  const num = nums[nums.length - 1];
  const INIT = /^[A-Z](?:[A-Z.\-]{0,6})$/;
  const SKIP = /^(RE|FW|FWD|TR|AC|MD|DR|NO|QC|PDF)$/;
  const tokens = s.replace(/[#:,()]/g, ' ').split(/\s+/).filter(Boolean);
  const i = tokens.lastIndexOf(num);
  const cand = [tokens[i - 1], tokens[i + 1]].map(t => (t || '').replace(/[.\-]+$/, ''));
  const initials = cand.find(t => t && INIT.test(t) && !SKIP.test(t)) || '';
  return initials ? `${initials} ${num}` : num;
}

// "JGC 35290" → "#35290 (JGC)", "32604" → "#32604"
// File number only — no patient initials next to it (Oct 23, 2026)
const fmtRef = ref => { const d = String(ref || '').match(/\d{4,6}(?!.*\d{4,6})/); return d ? `#${d[0]}` : (ref ? `#${String(ref).trim()}` : ''); };

const T = {
  en: {
    hello: n => n ? `Hello ${n},` : 'Hello,',
    new_patient: r => `I confirm the receipt of this email${r ? ` for file ${r}` : ''}. The patient has been added to my patient list and I will contact them to schedule the injection.`,
    prescription: r => `I have added this prescription to the file${r ? ` ${r}` : ''}.`,
    close_file: r => `I have closed the file${r ? ` ${r}` : ''}.`,
    on_hold: r => `Thank you for the update. I have placed the file${r ? ` ${r}` : ''} on hold and will wait for your news before scheduling the next injection.`,
    back: r => `Thank you for the update. I have reactivated the file${r ? ` ${r}` : ''} and will contact the patient to schedule the injection.`,
    permanent: r => `Thank you for the update. The file${r ? ` ${r}` : ''} will remain in my patient list permanently.`,
    thanks: 'Thank you!',
  },
  fr: {
    hello: n => n ? `Bonjour ${n},` : 'Bonjour,',
    new_patient: r => `Je confirme la réception de ce courriel${r ? ` pour le dossier ${r}` : ''}. Le dossier a été ajouté à ma liste de patients et je communiquerai avec la personne pour planifier l'injection.`,
    prescription: r => `J'ai ajouté cette ordonnance au dossier${r ? ` ${r}` : ''}.`,
    close_file: r => `J'ai fermé le dossier${r ? ` ${r}` : ''}.`,
    on_hold: r => `Merci pour la mise à jour. J'ai mis le dossier${r ? ` ${r}` : ''} en attente et j'attendrai de vos nouvelles avant de planifier la prochaine injection.`,
    back: r => `Merci pour la mise à jour. J'ai réactivé le dossier${r ? ` ${r}` : ''} et je communiquerai avec la personne pour planifier l'injection.`,
    permanent: r => `Merci pour la mise à jour. Le dossier${r ? ` ${r}` : ''} restera dans ma liste de patients de façon permanente.`,
    thanks: 'Merci!',
  },
};

const DOC_NAMES = {
  en: { assignment: 'assignment form', enrollment: 'enrollment form' },
  fr: { assignment: "formulaire d'assignation", enrollment: "formulaire d'inscription" },
};
const joinList = (items, and) => items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ` ${and} ` + items[items.length - 1];

// New patient, with documents known: "received everything" or "please send X".
// docs = { assignment: bool, enrollment: bool }
function newPatientSentence(lang, r, docs) {
  const missing = ['assignment', 'enrollment'].filter(k => !docs[k]);
  if (lang === 'fr') {
    const names = missing.map(k => 'le ' + DOC_NAMES.fr[k]);
    if (!missing.length) return `Je confirme la réception de ce courriel ainsi que des documents (formulaire d'assignation et formulaire d'inscription)${r ? ` pour le dossier ${r}` : ''}. Le dossier a été ajouté à ma liste de patients et je communiquerai avec la personne pour planifier l'injection.`;
    return `Je confirme la réception de ce courriel${r ? ` pour le dossier ${r}` : ''}. Cependant, je n'ai pas reçu ${joinList(names, 'ni')}. Pourriez-vous me ${missing.length > 1 ? 'les' : 'le'} faire parvenir dès que possible?`;
  }
  const names = missing.map(k => 'the ' + DOC_NAMES.en[k]);
  if (!missing.length) return `I confirm the receipt of this email along with the documents (assignment form and enrollment form)${r ? ` for file ${r}` : ''}. The patient has been added to my patient list and I will contact them to schedule the injection.`;
  return `I confirm the receipt of this email${r ? ` for file ${r}` : ''}. However, I did not receive ${joinList(names, 'or')}. Could you please send ${missing.length > 1 ? 'them' : 'it'} at your earliest convenience?`;
}

// A coordinator's question ("has the patient been contacted?") → what VaPiq knows about the file.
// facts = { found, onHold, appointment: 'YYYY-MM-DDTHH:MM', confirmed }. Only facts, nothing made up.
// Several patients in one follow-up: facts = { files: [{ file, found, onHold, appointment, confirmed }, …] } → one line each.
function fileLine(lang, f) {
  const fr = lang === 'fr', r = fmtRef(f.file), d = apptText(lang, f.appointment);
  if (!f.found) return fr ? `Dossier ${r} : je vérifie et je vous reviens rapidement.` : `File ${r}: I will look into it and get back to you shortly.`;
  if (f.onHold) return fr ? `Dossier ${r} : présentement en attente dans ma liste.` : `File ${r}: currently on hold in my patient list.`;
  if (d) return fr ? `Dossier ${r} : injection prévue le ${d}${f.confirmed ? ', rendez-vous confirmé' : ''}.` : `File ${r}: injection scheduled for ${d}${f.confirmed ? ', confirmed with the patient' : ''}.`;
  return fr ? `Dossier ${r} : rendez-vous pas encore fixé. Je communiquerai avec la personne et je vous confirmerai la date.` : `File ${r}: appointment not booked yet. I will contact the patient and confirm the date with you.`;
}
function apptText(lang, appointment) {
  const fr = lang === 'fr', m = String(appointment || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return '';
  const day = new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(fr ? 'fr-CA' : 'en-CA', { weekday: 'long', month: 'long', day: 'numeric' });
  return day + (m[4] ? (fr ? ` à ${+m[4]} h ${m[5]}` : ` at ${m[4]}:${m[5]}`) : '');
}
function questionSentence(lang, r, facts) {
  if (facts && facts.files && facts.files.length > 1)
    return (lang === 'fr' ? 'Merci pour votre message. Voici le suivi des dossiers :' : 'Thank you for your message. Here is an update on these files:')
      + '\n' + facts.files.map(f => '- ' + fileLine(lang, f)).join('\n');
  if (facts && facts.files) facts = facts.files[0] || {};
  const f = facts || {}, fr = lang === 'fr', file = r ? (fr ? ` pour le dossier ${r}` : ` for file ${r}`) : '';
  const about = r ? (fr ? ` concernant le dossier ${r}` : ` about file ${r}`) : '';
  const day = apptText(lang, f.appointment), at = '';
  if (fr) {
    if (!r || !f.found) return `Merci pour votre message${about}. Je vérifie et je vous reviens rapidement.`;
    if (f.onHold) return `Merci pour votre message. Le dossier ${r} est présentement en attente dans ma liste.`;
    if (day) return `Merci pour votre message. L'injection${file} est prévue le ${day}${at}${f.confirmed ? ', rendez-vous confirmé avec la personne' : ''}.`;
    return `Merci pour votre message. Le rendez-vous${file} n'est pas encore fixé. Je communiquerai avec la personne et je vous confirmerai la date dès qu'il sera planifié.`;
  }
  if (!r || !f.found) return `Thank you for your message${about}. I will look into it and get back to you shortly.`;
  if (f.onHold) return `Thank you for your message. File ${r} is currently on hold in my patient list.`;
  if (day) return `Thank you for your message. The injection${file} is scheduled for ${day}${at}${f.confirmed ? ', confirmed with the patient' : ''}.`;
  return `Thank you for your message. The appointment${file} is not booked yet. I will contact the patient and confirm the date with you as soon as it is scheduled.`;
}

function draftReply({ kind, lang, coordinatorName, fileNumber, subjectRef, signature, docs, facts }) {
  const L = lang === 'fr' ? 'fr' : 'en', t = T[L];
  if (!t[kind] && kind !== 'question') throw new Error('Unknown reply kind: ' + kind);
  const ref = fmtRef(subjectRef || fileNumber || '');
  const body = kind === 'question' ? questionSentence(L, ref, facts)
    : kind === 'new_patient' && docs ? newPatientSentence(L, ref, docs) : t[kind](ref);
  const lines = [t.hello(coordinatorName), '', body, '', t.thanks];
  if (signature) lines.push('', signature);   // blank line between "Thank you!" and the name
  return lines.join('\n');
}

// Which documents are still missing → for the card and the reply
function missingDocs(docs) { return ['assignment', 'enrollment'].filter(k => !(docs && docs[k])); }
// Scanned faxes the computer couldn't read: you tick what they contain before sending
function needsDocCheck(docs) { return !!(docs && docs.unknown > 0 && !docs.checked); }

const api = { draftReply, detectLanguage, coordinatorFirstName, subjectReference, missingDocs, needsDocCheck, DOC_NAMES };
if (typeof module === 'object' && module.exports) module.exports = api;
else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this);
