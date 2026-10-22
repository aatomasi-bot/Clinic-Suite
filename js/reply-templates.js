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
const fmtRef = ref => ref ? ref.replace(/^(.*?)\s*(\d{4,6})$/, (m, a, d) => a ? `#${d} (${a})` : `#${d}`) : '';

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

function draftReply({ kind, lang, coordinatorName, fileNumber, subjectRef, signature }) {
  const t = T[lang === 'fr' ? 'fr' : 'en'];
  if (!t[kind]) throw new Error('Unknown reply kind: ' + kind);
  const ref = subjectRef || fileNumber || '';
  const lines = [t.hello(coordinatorName), '', t[kind](fmtRef(ref)), '', t.thanks];
  if (signature) lines.push(signature);
  return lines.join('\n');
}

const api = { draftReply, detectLanguage, coordinatorFirstName, subjectReference };
if (typeof module === 'object' && module.exports) module.exports = api;
else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this);
