#!/usr/bin/env node
// Notes mover (launchd, every morning and at login): 10 days after a month ends, it works out
// which records in your Apple Notes "Medicum, …" notes belong in a later month's note
// (lib/notesmove.js decides where) and gives you a checklist to move them yourself.
// It ONLY READS your notes. Writing through Notes' scripting loses your colours (blue sides),
// bold and font sizes, so the cut and paste is yours (⌘X / ⌘V in Notes keeps all styling).
// Box (stays until you choose): Show list · Pend it (ask tomorrow) · Hold it (not for this month —
// `npm run notes-move -- --month 2026-10` asks again). Each morning it re-reads and says how
// many are left; when none are, the month is done.
//   npm run notes-move                  ask now if a month is due
//   npm run notes-move -- --list        open the checklist now
//   npm run notes-move -- --preview     print the plan
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseNote, planMoves, whereIn, fmtDate, MONTH_NAMES } from './lib/notesmove.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(here, 'state');
const stateFile = path.join(stateDir, 'notes-mover.json');
const listFile = path.join(stateDir, 'notes-move-list.html');
const FROM = 2026 * 12 + 9;   // October 2026: the first month the mover looks after
const ACCOUNT = 'iCloud', FOLDER = 'Medicum';

const osa = (script, args = []) => execFileSync('osascript', ['-e', script, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 0 }).replace(/\n$/, '');

// Your "Medicum, …" notes (only the iCloud → Medicum folder) — read only
function readNotes() {
  const SEP = '\u001e', FS = '\u001f';
  const raw = osa(`tell application "Notes"
    set out to ""
    repeat with n in (every note of folder "${FOLDER}" of account "${ACCOUNT}")
      if name of n starts with "Medicum" then set out to out & (id of n) & "${FS}" & (name of n) & "${FS}" & (body of n) & "${SEP}"
    end repeat
    return out
  end tell`);
  return raw.split(SEP).filter(Boolean).map(s => { const [id, title, body] = s.split(FS); return { id, title: title.trim(), body }; });
}

// The box that stays until you choose (no time limit)
function ask(text) {
  try {
    return osa('on run argv\nwith timeout of 31536000 seconds\nreturn button returned of (display dialog (item 1 of argv) with title "VaPiq · Medicum notes" buttons {"Hold it", "Pend it", "Show list"} default button "Show list" with icon note)\nend timeout\nend run', [text]);
  } catch { return 'Pend it'; }   // closed some other way: ask again tomorrow
}
const notify = (text) => { try { osa('on run argv\ndisplay notification (item 1 of argv) with title "VaPiq · Medicum notes"\nend run', [text]); } catch {} };
const say = (text) => { try { osa('on run argv\nwith timeout of 31536000 seconds\ndisplay dialog (item 1 of argv) with title "VaPiq · Medicum notes" buttons {"OK"} default button "OK" with icon note\nend timeout\nend run', [text]); } catch {} };

const loadState = () => { try { return { done: {}, held: {}, listed: {}, pendUntil: null, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { return { done: {}, held: {}, listed: {}, pendUntil: null }; } };
const saveState = s => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
const monthName = mk => { const [y, m] = mk.split('-'); return `${MONTH_NAMES[+m - 1]} ${y}`; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function plan(state, only) {
  const notes = readNotes().map(n => ({ ...parseNote(n.title, n.body), id: n.id })).filter(n => n.period.length);
  const skip = mk => only ? mk !== only : !!(state.done[mk] || state.held[mk]);
  return { notes, ...planMoves(notes, { now: new Date(), skip, from: FROM }) };
}

function summary(p, state) {
  const months = p.months.map(monthName).join(', ');
  const again = p.months.some(mk => state.listed[mk]);
  let t = again ? `${months}: ${p.moves.length} record${p.moves.length === 1 ? '' : 's'} still to move.\n`
    : `${months} is over.\n\n${p.moves.length} record${p.moves.length === 1 ? '' : 's'} should move forward.\n`;
  const by = {};
  for (const m of p.moves) by[m.to] = (by[m.to] || 0) + 1;
  for (const [to, n] of Object.entries(by)) t += `\n   ${n} → ${to}${p.moves.find(m => m.to === to).create ? ' (new note)' : ''}`;
  if (p.left.length) t += `\n\n${p.left.length} stay where they are (please check — they are on the list).`;
  return t + '\n\nShow list opens a checklist of where each one goes. Cut and paste them in Notes yourself (⌘X, ⌘V): your colours, bold and sizes stay as they are. The mover never edits your notes.';
}

// The checklist page (kept on this Mac only, in state/)
function writeList(p) {
  const byTo = {};
  for (const m of p.moves) (byTo[m.to] ||= []).push(m);
  const sec = Object.entries(byTo).map(([to, ms]) => {
    const target = p.notes.find(n => n.title === to);
    const rows = ms.sort((a, b) => (a.date.y - b.date.y) || (a.date.m - b.date.m) || (a.date.d - b.date.d))
      .map(m => `<tr><td><input type="checkbox"></td><td><b>#${esc(m.file)}</b> ${esc(m.id.split(' ').slice(1).join(' '))}</td><td>${esc(fmtDate(m.date))}</td><td>${esc(m.from)}</td><td>${esc(whereIn(target, m.date))}</td></tr>`).join('');
    return `<h2>${esc(to)} <span>${ms.length}</span></h2>${target ? '' : `<p class="new">This note doesn't exist yet — create it in Notes with this name first.</p>`}
      <table><tr><th></th><th>Patient</th><th>Projected</th><th>Now in</th><th>Put it</th></tr>${rows}</table>`;
  }).join('');
  const left = p.left.length ? `<h2>Stay where they are — please check <span>${p.left.length}</span></h2><table><tr><th>Patient</th><th>In</th><th>Why</th></tr>${p.left.map(l => `<tr><td><b>${esc(l.id)}</b></td><td>${esc(l.note)}</td><td>${esc(l.why)}</td></tr>`).join('')}</table>` : '';
  fs.writeFileSync(listFile, `<!doctype html><meta charset="utf-8"><title>Medicum notes to move</title>
<style>body{font:15px -apple-system,sans-serif;margin:24px auto;max-width:980px;padding:0 16px;color:#222}h1{font-size:22px}h2{font-size:17px;margin-top:28px}h2 span{background:#5B48A0;color:#fff;border-radius:10px;padding:1px 8px;font-size:13px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{font-size:12px;color:#666}tr:has(input:checked) td{color:#aaa;text-decoration:line-through}.tip{background:#F0EEF9;border:1px solid #C4B8E8;border-radius:8px;padding:10px 14px}.new{color:#b00}</style>
<h1>Medicum notes to move — ${esc(p.months.map(monthName).join(', '))}</h1>
<p class="tip">In Notes: open the "Now in" note, press ⌘F and type the file number, select the whole line, ⌘X. Open the target note, click where "Put it" says, ⌘V. Your colours, bold and sizes stay. Tick the box here as you go (ticks are not saved). Tomorrow morning the mover re-reads your notes and tells you how many are left.</p>
${sec}${left}<p style="color:#888;font-size:12px">Made ${esc(new Date().toLocaleString())}. The mover only reads your notes.</p>`);
  execFileSync('open', [listFile]);
}

async function main() {
  fs.mkdirSync(stateDir, { recursive: true });
  const args = process.argv.slice(2);
  const only = args.includes('--month') ? args[args.indexOf('--month') + 1] : null;
  const state = loadState();
  if (args.includes('--preview')) { console.log(summary(plan(state, only), state)); return; }
  if (args.includes('--list')) { writeList(plan(state, only)); return; }
  if (!only && state.pendUntil && new Date() < new Date(state.pendUntil)) return;
  const p = plan(state, only);
  if (!p.moves.length) {
    if (!p.months.length) return;
    const wasListed = p.months.some(mk => state.listed[mk]);
    for (const mk of p.months) { state.done[mk] = new Date().toISOString(); delete state.listed[mk]; }
    saveState(state);
    notify(`${p.months.map(monthName).join(', ')}: all moved${p.left.length ? ` · ${p.left.length} to check` : ''}`);
    if (p.left.length && !wasListed) { writeList(p); }
    return;
  }
  const choice = ask(summary(p, state));
  if (choice === 'Pend it') { state.pendUntil = new Date(Date.now() + 20 * 3600e3).toISOString(); saveState(state); console.log('pended'); return; }
  if (choice === 'Hold it') { for (const mk of p.months) state.held[mk] = new Date().toISOString(); state.pendUntil = null; saveState(state); console.log('held', p.months); return; }
  writeList(p);
  for (const mk of p.months) state.listed[mk] ||= new Date().toISOString();
  state.pendUntil = null; saveState(state);
  console.log(`[${new Date().toISOString()}] notes: list shown, ${p.moves.length} to move, ${p.left.length} to check`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error('notes mover:', e.message); notify('Notes mover: ' + e.message.slice(0, 120)); process.exit(1); });
