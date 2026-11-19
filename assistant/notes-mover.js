#!/usr/bin/env node
// Notes mover (launchd, every morning and at login): 10 days after a month ends, the records
// in your Apple Notes "Medicum, …" notes whose projected date belongs in a later month are
// cut and pasted into that month's note (lib/notesmove.js decides where).
// It asks first, in a box that stays on screen: Do it · Pend it (ask tomorrow) · Hold it (not
// for this month — `npm run notes-move -- --month 2026-10` asks again). Records it can't place
// stay where they are and are listed. Every note is saved to state/notes-backup/ before a change.
//   npm run notes-move                  ask now if a month is due
//   npm run notes-move -- --preview     print the plan, change nothing
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseNote, planMoves, removeRecords, insertRecords, newNoteBody, textOf, fmtDate, MONTH_NAMES } from './lib/notesmove.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(here, 'state');
const stateFile = path.join(stateDir, 'notes-mover.json');
const FROM = 2026 * 12 + 9;   // October 2026: the first month the mover looks after
const ACCOUNT = 'iCloud', FOLDER = 'Medicum';

const osa = (script, args = []) => execFileSync('osascript', ['-e', script, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 0 }).replace(/\n$/, '');

// Your "Medicum, …" notes (only the iCloud → Medicum folder)
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
const writeNote = (id, html) => osa('on run argv\ntell application "Notes" to set body of note id (item 1 of argv) to (item 2 of argv)\nend run', [id, html]);
const readBody = id => osa('on run argv\ntell application "Notes" to get body of note id (item 1 of argv)\nend run', [id]);
const createNote = html => osa(`on run argv\ntell application "Notes" to return id of (make new note at folder "${FOLDER}" of account "${ACCOUNT}" with properties {body:(item 1 of argv)})\nend run`, [html]);

// The box that stays until you choose (no time limit)
function ask(text) {
  try {
    return osa('on run argv\nwith timeout of 31536000 seconds\nreturn button returned of (display dialog (item 1 of argv) with title "VaPiq · Medicum notes" buttons {"Hold it", "Pend it", "Do it"} default button "Do it" with icon note)\nend timeout\nend run', [text]);
  } catch { return 'Pend it'; }   // closed some other way: ask again tomorrow
}
const notify = (text) => { try { osa('on run argv\ndisplay notification (item 1 of argv) with title "VaPiq · Medicum notes"\nend run', [text]); } catch {} };
const say = (text) => { try { osa('on run argv\nwith timeout of 31536000 seconds\ndisplay dialog (item 1 of argv) with title "VaPiq · Medicum notes" buttons {"OK"} default button "OK" with icon note\nend timeout\nend run', [text]); } catch {} };

const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { done: {}, held: {}, pendUntil: null }; } };
const saveState = s => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
const monthName = mk => { const [y, m] = mk.split('-'); return `${MONTH_NAMES[+m - 1]} ${y}`; };

function plan(state, only) {
  const raw = readNotes();
  const notes = raw.map(n => ({ ...parseNote(n.title, n.body), id: n.id, body: n.body })).filter(n => n.period.length);
  const skip = mk => only ? mk !== only : !!(state.done[mk] || state.held[mk]);
  return { notes, ...planMoves(notes, { now: new Date(), skip, from: FROM }) };
}

function summary(p) {
  const months = p.months.map(monthName).join(', ');
  const by = {};
  for (const m of p.moves) (by[m.to] ||= []).push(`${m.id} (${m.date.d} ${MONTH_NAMES[m.date.m].slice(0, 3)})`);
  let t = `${months} is over.\n\nMove ${p.moves.length} record${p.moves.length === 1 ? '' : 's'} forward?\n`;
  for (const [to, ids] of Object.entries(by)) t += `\n${ids.length} → ${to}${p.moves.find(m => m.to === to).create ? ' (new note)' : ''}\n   ${ids.join(', ')}\n`;
  if (p.left.length) t += `\n${p.left.length} stay where they are (please check):\n` + p.left.map(l => `   ${l.id} — ${l.why}`).join('\n') + '\n';
  return t + '\nEvery note is backed up on this Mac before a change.';
}

// Do it: paste into the target notes, check, then cut from the old notes
function apply(p) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(stateDir, 'notes-backup', stamp);
  fs.mkdirSync(backup, { recursive: true });
  for (const n of p.notes) fs.writeFileSync(path.join(backup, n.title.replace(/[\/:]/g, '-') + '.html'), n.body);
  const byTarget = {};
  for (const m of p.moves) (byTarget[m.to] ||= []).push(m);
  const placed = new Set();
  for (const [title, items] of Object.entries(byTarget)) {
    const existing = p.notes.find(n => n.title === title);
    const html = insertRecords(existing ? existing.body : newNoteBody(title), title, items);
    const id = existing ? (writeNote(existing.id, html), existing.id) : createNote(html);
    const back = textOf(readBody(id));
    for (const it of items) if (back.includes(it.block.text.slice(0, 40))) placed.add(it.file);   // arrived?
  }
  // cut only what is now in its new note
  const bySource = {};
  for (const m of p.moves) if (placed.has(m.file)) (bySource[m.from] ||= new Set()).add(m.file);
  for (const [title, files] of Object.entries(bySource)) {
    const n = p.notes.find(x => x.title === title);
    writeNote(n.id, removeRecords(n.body, files));
  }
  return { moved: placed.size, notPlaced: p.moves.filter(m => !placed.has(m.file)), backup };
}

async function main() {
  fs.mkdirSync(stateDir, { recursive: true });
  const args = process.argv.slice(2);
  const only = args.includes('--month') ? args[args.indexOf('--month') + 1] : null;
  const state = loadState();
  if (!only && state.pendUntil && new Date() < new Date(state.pendUntil)) return;
  let p = plan(state, only);
  if (args.includes('--preview')) { console.log(summary(p)); return; }
  if (!p.moves.length) {
    if (p.left.length && !only) { notify(`${p.left.length} record(s) need checking in ${p.months.map(monthName).join(', ')}`); say(summary(p)); }
    for (const mk of p.months) state.done[mk] = new Date().toISOString();
    saveState(state); return;
  }
  for (;;) {
    const shown = p.moves.map(m => m.file).sort().join(',');
    const choice = ask(summary(p));
    if (choice === 'Pend it') { state.pendUntil = new Date(Date.now() + 20 * 3600e3).toISOString(); saveState(state); console.log('pended'); return; }
    if (choice === 'Hold it') { for (const mk of p.months) state.held[mk] = new Date().toISOString(); state.pendUntil = null; saveState(state); console.log('held', p.months); return; }
    // Do it — on the notes as they are now (you may have edited them while the box was open)
    const fresh = plan(state, only);
    if (fresh.moves.map(m => m.file).sort().join(',') !== shown) { p = fresh; if (!p.moves.length) return; continue; }
    p = fresh; break;
  }
  const r = apply(p);
  for (const mk of p.months) { state.done[mk] = new Date().toISOString(); delete state.held[mk]; }
  state.pendUntil = null; saveState(state);
  console.log(`[${new Date().toISOString()}] notes: moved ${r.moved}, left ${p.left.length}, not placed ${r.notPlaced.length}; backup ${r.backup}`);
  notify(`Moved ${r.moved} record${r.moved === 1 ? '' : 's'}${p.left.length ? ` · ${p.left.length} to check` : ''}`);
  if (p.left.length || r.notPlaced.length) say(`Moved ${r.moved} record(s).\n\n`
    + (r.notPlaced.length ? `Could not be placed (still in the old note):\n${r.notPlaced.map(m => `   ${m.id} → ${m.to}`).join('\n')}\n\n` : '')
    + (p.left.length ? `Left where they are, please check:\n${p.left.map(l => `   ${l.id} — ${l.why}`).join('\n')}` : ''));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error('notes mover:', e.message); notify('Notes mover: ' + e.message.slice(0, 120)); process.exit(1); });
