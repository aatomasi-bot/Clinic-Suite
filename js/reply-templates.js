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
    thanks: 'Thank you!',
  },
  fr: {
    hello: n => n ? `Bonjour ${n},` : 'Bonjour,',
    new_patient: r => `Je confirme la réception de ce courriel${r ? ` pour le dossier ${r}` : ''}. Le dossier a été ajouté à ma liste de patients et je communiquerai avec la personne pour planifier l'injection.`,
    prescription: r => `J'ai ajouté cette ordonnance au dossier${r ? ` ${r}` : ''}.`,
    close_file: r => `J'ai fermé le dossier${r ? ` ${r}` : ''}.`,
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

function draftReply({ kind, lang, coordinatorName, fileNumber, subjectRef, signature, docs }) {
  const L = lang === 'fr' ? 'fr' : 'en', t = T[L];
  if (!t[kind]) throw new Error('Unknown reply kind: ' + kind);
  const ref = fmtRef(subjectRef || fileNumber || '');
  const body = kind === 'new_patient' && docs ? newPatientSentence(L, ref, docs) : t[kind](ref);
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
