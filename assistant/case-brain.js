// Dubbi's case brain, run by brain.js in the background (about once a minute).
// For every patient file with a Medicum email in the last week, it reads ALL that file's
// emails (Inbox + Medicum folder, 45 days) with VaPiq's record and the open cards, and
// asks Claude what is true now (lib/cases.js). A case is read again only when a new
// email arrives or you teach Dubbi what a PDF is. Dubbi shows the result; you confirm.
import { buildCase, casePrompt, parseCase } from './lib/cases.js';
import { replyAllowed } from './lib/classify.js';
import { normFile } from './lib/match.js';

// Pure enough to test: a fake store and a fake Claude.
export async function casePass({ store, run, rules, signature = '', maxPerPass = 3, recentDays = 7, now = new Date(), log = console.log }) {
  const [emails, data, memory, cases] = await Promise.all([store.caseEmails(45), store.brainData(), store.memory(), store.cases()]);
  const byFile = new Map();
  for (const e of emails) for (const f of e.file_numbers || []) { const k = normFile(f); if (!byFile.has(k)) byFile.set(k, []); byFile.get(k).push(e); }
  const old = new Map(cases.map(c => [normFile(c.file_number), c]));
  const recent = [...byFile.entries()]
    .map(([file, list]) => ({ file, list, last: Math.max(...list.map(e => +new Date(e.email_date))) }))
    .filter(x => now - x.last < recentDays * 864e5)
    .sort((a, b) => b.last - a.last);
  let done = 0;
  for (const { file, list } of recent) {
    if (done >= maxPerPass) break;
    const patient = data.patients.find(p => normFile(p.file_number) === file) || null;
    const tasks = data.tasks.filter(t => normFile(t.file_number) === file && !t.is_test);
    const c = buildCase({ file, emails: list, patient, tasks, memory, now });
    const prev = old.get(file);
    if (prev && prev.basis === c.basis) continue;
    if (prev && prev.status === 'failed' && now - new Date(prev.updated_at) < 10 * 6e4) continue;   // a failure is retried after 10 min
    done++;
    const row = { file_number: file, basis: c.basis, questions: c.questions, decided_at: null, decided_by: null, result: null };
    try {
      const raw = await run(casePrompt({ text: c.text, signature }));
      const a = parseCase(raw, { cardIds: tasks.map(t => t.id), emails: c.emails, replyAllowed: addr => replyAllowed(addr, rules) });
      if (!a) { await store.saveCase({ ...row, status: 'failed', error: 'The answer could not be used', analysis: null }); log(`  case #${file}: answer not usable`); continue; }
      const busy = a.actions.length || c.questions.length || Object.values(a.cards).includes('obsolete');
      await store.saveCase({ ...row, status: busy ? 'ready' : 'quiet', analysis: a, error: null });
      log(`  case #${file}: ${busy ? `${a.actions.length} action(s), ${c.questions.length} question(s)` : 'nothing to do'}`);
    } catch (e) {
      const msg = /usage limit|rate limit|quota/i.test(e.message) ? 'Claude usage limit reached' : String(e.message).slice(0, 200);
      await store.saveCase({ ...row, basis: null, status: 'failed', error: msg, analysis: null }).catch(() => {});   // basis null → tried again later
      log(`  case #${file}: ${msg}`);
      if (/usage limit/.test(msg)) break;
    }
  }
  return done;
}

