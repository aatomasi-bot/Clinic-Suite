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
import { kokoroVoice } from './lib/voice.js';
import { BRAIN_SYSTEM, buildContext, brainPrompt, cleanQuestion, parseBrain, withNames } from './lib/brain.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One question → the row update. Pure enough to test with a fake store and a fake Claude.
export async function answerOne({ ask, data, history = [], run, tts = null, now = new Date() }) {
  const question = cleanQuestion(ask.question, data.patients);
  const context = buildContext({ ...data, now });
  const prompt = brainPrompt({ question, context, history: history.map(h => ({ q: h.answer?.q || '', a: h.answer?.raw || '' })).filter(h => h.q) });
  let raw;
  try { raw = await run(prompt); }
  catch (e) { return { status: 'failed', answer: { error: /usage limit|rate limit|quota/i.test(e.message) ? 'Claude usage limit reached' : String(e.message).slice(0, 200) } }; }
  const files = data.patients.map(p => String(p.file_number || '').trim()).filter(Boolean);
  const out = parseBrain(raw, files);
  if (!out) return { status: 'failed', answer: { error: 'The answer could not be used' } };
  const say = withNames(out.say, data.patients);
  // the voice is made on this Mac, so it may say the names (an action's Confirm card is read separately)
  const audio = tts && !out.action ? await tts(say, ask.lang === 'fr') : null;
  return { status: 'answered', answer: { say, show: out.show, action: out.action, q: question, raw: out.say, ...(audio ? { audio } : {}) } };
}

async function main() {
  const cfg = loadConfig(), ai = cfg.ai || {};
  if (ai.enabled === false || ai.brain === false || cfg.mode !== 'live') { await sleep(10 * 60e3); return; }
  const store = await supabaseStore(cfg.supabase);
  const run = claudeRunner({ command: ai.command, system: BRAIN_SYSTEM, timeoutMs: 75e3 });
  const tts = ai.voice === false ? null : kokoroVoice();   // null until install-voice.sh has run
  await store.purgeAsks(7).catch(() => {});     // questions are kept a week, then removed
  const until = Date.now() + 20 * 60e3;
  let data = null, dataAt = 0;
  while (Date.now() < until) {
    const ask = await store.nextAsk();
    if (!ask) { await sleep(1000); continue; }
    if (!(await store.claimAsk(ask.id))) continue;
    // Text Dubbi wrote itself, to be read aloud: just the voice
    if (/^speak-/.test(ask.lang || '')) {
      const audio = tts ? await tts(ask.question, ask.lang === 'speak-fr') : null;
      await store.answerAsk(ask.id, audio ? { status: 'answered', answer: { audio } } : { status: 'failed', answer: { error: 'no voice' } }).catch(() => {});
      continue;
    }
    try {
      if (!data || Date.now() - dataAt > 20e3) { data = await store.brainData(); dataAt = Date.now(); }
      const history = await store.askHistory(ask.conv, ask.created_at);
      const r = await answerOne({ ask, data, history, run, tts });
      await store.answerAsk(ask.id, r);
      console.log(`[${new Date().toISOString()}] brain: ${r.status}${r.status === 'failed' ? ' — ' + r.answer.error : r.answer.audio ? ' (voice)' : ''}`);
    } catch (e) {
      await store.answerAsk(ask.id, { status: 'failed', answer: { error: String(e.message).slice(0, 200) } }).catch(() => {});
      console.error('brain:', e.message);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.join(here, 'state'), { recursive: true });
  main().catch(async e => { console.error('brain failed:', e.message); await sleep(30e3); process.exitCode = 1; });
}
