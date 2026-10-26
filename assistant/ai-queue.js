#!/usr/bin/env node
// Reply suggestions (launchd, every 30 s): for reply cards in Dubbi,
//   • a ✨ suggestion for each reply waiting to be sent (once), and
//   • the rewrites you ask for (Shorter / More formal / French / thank-you / your own words).
// Claude runs through your subscription (lib/ai.js). Until `ai.realEmails` is
// true in config.json (privacy officer approval), only TEST cards are used.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './intake.js';
import { supabaseStore } from './lib/store.js';
import { claudeRunner, aiReply } from './lib/ai.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Pure step, used by the job and the tests: tasks → updates to write.
export async function processAi({ tasks, run, realEmails, maxPerRun = 4, now = () => new Date().toISOString() }) {
  const updates = [];
  for (const t of tasks) {
    if (updates.length >= maxPerRun) break;
    const d = t.details || {}, req = d.ai_request;
    if (!t.is_test && !realEmails) {                               // privacy gate: real emails never go to Claude
      if (req && !req.done) updates.push({ id: t.id, details: { ...d, ai_request: { ...req, done: now() }, ai_error: 'AI is off for real emails until your privacy officer approves' } });
      continue;
    }
    const draft = t.reply_body || '';
    const names = [t.existing_patient && t.existing_patient.patient_name, d.patient_name].filter(Boolean);
    if (!draft.trim()) continue;
    if (req && !req.done) {                                        // a rewrite you asked for
      const r = await aiReply({ run, action: req.action, instruction: req.instruction, draft: req.base || draft, excerpt: d.excerpt, names });
      updates.push({ id: t.id, details: { ...d, ai_request: { ...req, done: now() },
        ...(r.text ? { ai_suggestion: { text: r.text, action: req.action, at: now() }, ai_error: null } : { ai_error: r.error }) } });
    } else if (t.status === 'reply_ready' && !d.ai_suggestion && !d.ai_error) {   // first suggestion
      const r = await aiReply({ run, action: 'suggest', draft, excerpt: d.excerpt, names });
      updates.push({ id: t.id, details: { ...d, ...(r.text ? { ai_suggestion: { text: r.text, action: 'suggest', at: now() } } : { ai_error: r.error }) } });
    }
  }
  return updates;
}

async function main() {
  const cfg = loadConfig(), ai = cfg.ai || {};
  if (ai.enabled === false || cfg.mode !== 'live') return;
  const lock = path.join(here, 'state', 'ai.lock');
  try { if (Date.now() - fs.statSync(lock).mtimeMs < 5 * 60e3) return; } catch {}
  fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, String(process.pid));
  try {
    const store = await supabaseStore(cfg.supabase);
    const tasks = await store.tasksForAi();
    if (!tasks.length) return;
    const updates = await processAi({ tasks, run: claudeRunner({ command: ai.command }), realEmails: ai.realEmails === true, maxPerRun: ai.maxPerRun || 4 });
    for (const u of updates) await store.updateTask(u.id, { details: u.details });
    if (updates.length) console.log(`[${new Date().toISOString()}] ai: ${updates.length} suggestion(s)`);
  } finally { fs.rmSync(lock, { force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error('ai failed:', e.message); process.exitCode = 1; });
