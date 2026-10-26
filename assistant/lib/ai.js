// Reply suggestions with Claude, through YOUR Claude subscription (Claude Code's
// non-interactive mode, `claude -p`) — no API key, no extra bill.
//
// Privacy (Law 25):
//   • Only the coordinator's own message is used (no signature, disclaimer or
//     quoted history), and contact details are removed first: phone numbers,
//     email addresses, street addresses, postal codes, links (redact()).
//   • Real emails are used only once config `ai.realEmails` is true (after your
//     privacy officer approves); until then only TEST cards get suggestions.
//   • Claude runs with no tools, no MCP servers, no settings and no saved
//     session, from an empty folder: it only sees the text sent here.
//   • It only SUGGESTS. You read, edit and tap Send.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openingText } from './emailinfo.js';

// ── Contact details out ────────────────────────────────────────────────────
const RULES = [
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[email]'],
  [/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '[link]'],
  [/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b(?:\s*(?:ext|poste|x)\.?\s*\d{1,5})?/gi, '[phone]'],
  [/\b[A-Za-z]\d[A-Za-z][\s-]?\d[A-Za-z]\d\b/g, '[postal code]'],
  // "1234 Boulevard Deguire", "45, rue Saint-Denis", "2-310 avenue X" (apartment-number forms too)
  [/\b\d{1,5}(?:-\d{1,5})?,?\s+(?:rue|boul(?:evard)?\.?|bd\.?|avenue|av\.?|chemin|ch\.?|street|st\.?|road|rd\.?|drive|dr\.?|place|pl\.?|crescent|croissant|terrasse|mont[ée]e|rang|route|autoroute|ave\.?)\b[^\n,.;]{0,40}/gi, '[address]'],
  [/\b(?:apt|app|appartement|apartment|unit|unité|suite|bureau)\.?\s*#?\s*\w{1,6}\b/gi, '[unit]'],
];
export function redact(text) {
  let s = String(text || '');
  for (const [re, by] of RULES) s = s.replace(re, by);
  return s;
}
// The part of a coordinator email the AI may see: her message, cleaned, capped.
export const excerptOf = body => redact(openingText(body)).replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);

// ── What we ask ────────────────────────────────────────────────────────────
export const ACTIONS = {
  suggest: 'Write the best reply for this situation, based on the standard draft and the coordinator\'s message.',
  shorter: 'Make the reply shorter and simpler, keeping every fact.',
  formal:  'Make the reply more formal and polished.',
  french:  'Translate the reply into natural Quebec French (vous), keeping every fact.',
  english: 'Translate the reply into natural Canadian English, keeping every fact.',
  thanks:  'Add a short, warm thank-you to the coordinator.',
};
const SYSTEM = `You help a home-care nurse in Montreal reply to coordinators at Medicum (an injection program).
Rules:
- Output ONLY the email text, nothing else (no subject, no notes, no quotes, no markdown).
- Keep it short, professional and warm. Match the language of the draft unless asked to translate.
- Keep every fact from the standard draft (file numbers, what was done, which documents are missing).
- Never invent facts, dates, times, doses, phone numbers, actions or promises that are not in the draft, the message or the nurse's instruction (e.g. do not say you noted, called or sent anything unless the draft says so).
- Keep the greeting line and end exactly with the same closing and signature as the draft.
- Text in [brackets] like [phone] was removed for privacy: never try to fill it in.`;

export function buildPrompt({ action = 'suggest', instruction = '', draft = '', excerpt = '' }) {
  const ask = action === 'custom' ? `Rewrite the reply following this instruction from the nurse: "${String(instruction).slice(0, 400)}"` : (ACTIONS[action] || ACTIONS.suggest);
  return `Coordinator's message (contact details removed):\n"""\n${excerpt || '(not available)'}\n"""\n\nStandard draft reply:\n"""\n${draft}\n"""\n\nTask: ${ask}`;
}

// Basic checks on what comes back: still the same file number(s) and signature, no contact details.
export function checkReply(text, draft) {
  const out = String(text || '').trim().replace(/^```\w*\n?|```$/g, '').replace(/^"""|"""$/g, '').trim();
  if (out.length < 15 || out.length > 3000) return { ok: false, why: 'empty or too long' };
  for (const fn of String(draft).match(/#\d{4,6}/g) || []) if (!out.includes(fn)) return { ok: false, why: `file ${fn} missing` };
  const sig = String(draft).trim().split('\n').pop().trim();
  if (sig && /^[A-ZÀ-Ý]/.test(sig) && !out.includes(sig)) return { ok: false, why: 'signature missing' };
  if (redact(out) !== out) return { ok: false, why: 'contains contact details' };
  return { ok: true, text: out };
}

// ── Run Claude (your subscription) ─────────────────────────────────────────
const EMPTY_DIR = path.join(os.tmpdir(), 'vapiq-ai-empty');
export function claudeRunner({ command, timeoutMs = 90e3 } = {}) {
  const bin = String(command || '~/.local/bin/claude').replace(/^~(?=\/)/, os.homedir());
  return (prompt) => new Promise((resolve, reject) => {
    fs.mkdirSync(EMPTY_DIR, { recursive: true });
    const child = spawn(bin, ['-p', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
      '--output-format', 'text', '--system-prompt', SYSTEM], { cwd: EMPTY_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Claude did not answer in time')); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error((err || out || `exit ${code}`).trim().slice(0, 200))); });
    child.stdin.end(prompt);
  });
}

// One request → { text } or { error }
export async function aiReply({ run, action, instruction, draft, excerpt }) {
  try {
    const raw = await run(buildPrompt({ action, instruction, draft, excerpt }));
    const c = checkReply(raw, draft);
    return c.ok ? { text: c.text } : { error: `Suggestion not used (${c.why})` };
  } catch (e) { return { error: /usage limit|rate limit|quota/i.test(e.message) ? 'Claude usage limit reached — try later' : e.message }; }
}
