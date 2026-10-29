#!/usr/bin/env node
// Dubbi's brain (launchd, always running while you're logged in): answers the
// questions you ask Dubbi, with Claude through your subscription (lib/brain.js
// says exactly what Claude sees). Checks for a new question every 2 seconds.
// It also makes Dubbi's natural voice (Kokoro, on this Mac — lib/voice.js) for every
// answer: Claude's, and the quick ones Dubbi asks to have read (lang "speak-en"/"speak-fr").
// It restarts itself every 20 minutes (fresh sign-in); launchd starts it again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './intake.js';
import { supabaseStore } from './lib/store.js';
import { claudeRunner } from './lib/ai.js';
import { aiPass } from './ai-queue.js';
import { kokoroVoice } from './lib/voice.js';
import { brainSystem, buildContext, brainPrompt, cleanQuestion, parseBrain, withNames } from './lib/brain.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One question → the row update. Pure enough to test with a fake store and a fake Claude.
// voiceLater: the text answer goes out at once and the voice follows (main() does it), so
// you read the answer while the Mac is still making the recording.
export async function answerOne({ ask, data, history = [], run, tts = null, now = new Date(), shareNames = false, voiceLater = false }) {
  const t0 = Date.now();
  const question = cleanQuestion(ask.question, data.patients, { shareNames });
  const context = buildContext({ ...data, now, shareNames });
  const prompt = brainPrompt({ question, context, shareNames, history: history.map(h => ({ q: h.answer?.q || '', a: h.answer?.raw || '' })).filter(h => h.q) });
  let raw;
  try { raw = await run(prompt); }
  catch (e) { return { status: 'failed', answer: { error: /usage limit|rate limit|quota/i.test(e.message) ? 'Claude usage limit reached' : String(e.message).slice(0, 200) } }; }
  const files = data.patients.map(p => String(p.file_number || '').trim()).filter(Boolean);
  const out = parseBrain(raw, files, { shareNames });
  if (!out) return { status: 'failed', answer: { error: 'The answer could not be used' } };
  const say = shareNames ? out.say : withNames(out.say, data.patients);   // with shareNames Claude already says the names
  // the voice is made on this Mac, so it may say the names (an action's Confirm card is read separately)
  const ms = Date.now() - t0;
  if (voiceLater) return { status: 'answered', answer: { say, show: out.show, action: out.action, q: question, raw: out.say, ms, ...(tts && !out.action ? { voice: 'pending' } : {}) } };
  const audio = tts && !out.action ? await tts(say, ask.lang === 'fr') : null;
  return { status: 'answered', answer: { say, show: out.show, action: out.action, q: question, raw: out.say, ms, ...(audio ? { audio } : {}) } };
}

async function main() {
  const cfg = loadConfig(), ai = cfg.ai || {};
  if (ai.enabled === false || ai.brain === false || cfg.mode !== 'live') { await sleep(10 * 60e3); return; }
  const store = await supabaseStore(cfg.supabase);
  const shareNames = ai.shareNames === true;
  // Speed: a fast model for Dubbi (config ai.brainModel; "haiku" unless you choose another), no extended thinking
  const run = claudeRunner({ command: ai.command, model: ai.brainModel || 'haiku', system: brainSystem({ shareNames }), timeoutMs: 75e3, fast: true });
  const replyRun = claudeRunner({ command: ai.command, model: ai.model || 'sonnet', fast: true });   // ✨ reply rewrites (lib/ai.js rules)
  let aiAt = 0, aiBusy = false;
  const tts = ai.voice === false ? null : kokoroVoice();   // null until install-voice.sh has run
  await store.purgeAsks(7).catch(() => {});     // questions are kept a week, then removed
  const until = Date.now() + (Number(process.env.BRAIN_MINUTES) || 20) * 60e3;   // BRAIN_MINUTES: shorter runs for testing
  // Watchdog: if the loop stops moving for 3 minutes (a stuck request or voice), quit —
  // launchd starts a fresh brain within ~10 s. Also a hard stop at 22 minutes.
  let beat = Date.now();
  const dog = setInterval(() => {
    if (Date.now() - beat > 3 * 60e3 || Date.now() > until + 2 * 60e3) { console.error(`[${new Date().toISOString()}] brain: stuck — restarting`); process.exit(1); }
  }, 15e3);
  // Patients and open items are refreshed in the background every 15 s, so a question never waits for them
  let data = null, dataAt = 0, dataBusy = false;
  const refresh = () => { if (dataBusy) return; dataBusy = true; store.brainData().then(d => { data = d; dataAt = Date.now(); }).catch(e => console.error('brain data:', e.message)).finally(() => { dataBusy = false; }); };
  refresh();
  while (Date.now() < until) {
    beat = Date.now();
    if (Date.now() - dataAt > 15e3) refresh();
    const ask = await store.nextAsk();
    if (!ask) {
      // idle: ✨ reply rewrites you asked for start within ~3 s (ai-queue.js every 30 s is the backup)
      // in the background, so a question you ask meanwhile is not kept waiting
      if (ai.rewritesInBrain !== false && !aiBusy && Date.now() - aiAt > 3000) {
        aiAt = Date.now(); aiBusy = true;
        aiPass({ store, ai, run: replyRun }).catch(e => console.error('brain ai:', e.message)).finally(() => { aiBusy = false; });
      }
      await sleep(400); continue;   // look for your next question ~2.5 times a second
    }
    if (!(await store.claimAsk(ask.id))) continue;
    // Text Dubbi wrote itself, to be read aloud: just the voice
    if (/^speak-/.test(ask.lang || '')) {
      const audio = tts ? await tts(ask.question, ask.lang === 'speak-fr') : null;
      await store.answerAsk(ask.id, audio ? { status: 'answered', answer: { audio } } : { status: 'failed', answer: { error: 'no voice' } }).catch(() => {});
      continue;
    }
    try {
      if (!data) { data = await store.brainData(); dataAt = Date.now(); }
      const history = await store.askHistory(ask.conv, ask.created_at);
      const r = await answerOne({ ask, data, history, run, tts, shareNames, voiceLater: true });
      await store.answerAsk(ask.id, r);   // the text is on your phone now
      console.log(`[${new Date().toISOString()}] brain: ${r.status}${r.status === 'failed' ? ' — ' + r.answer.error : ` in ${(r.answer.ms / 1000).toFixed(1)} s`}`);
      if (r.answer && r.answer.voice === 'pending') {   // then the voice
        const audio = await tts(r.answer.say, ask.lang === 'fr');
        await store.answerAsk(ask.id, { status: 'answered', answer: { ...r.answer, voice: audio ? 'done' : 'none', ...(audio ? { audio } : {}) } }).catch(() => {});
      }
    } catch (e) {
      await store.answerAsk(ask.id, { status: 'failed', answer: { error: String(e.message).slice(0, 200) } }).catch(() => {});
      console.error('brain:', e.message);
    }
  }
  clearInterval(dog);
  tts?.close?.();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.join(here, 'state'), { recursive: true });
  // exit for real when done: the voice helper must not keep this process alive doing nothing
  main().then(() => process.exit(0), async e => { console.error('brain failed:', e.message); await sleep(30e3); process.exit(1); });
}
