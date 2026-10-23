// Text recognition for scanned forms, with macOS's built-in Vision engine
// (ocr/ocr.swift). Runs on this Mac only — nothing is sent anywhere.
// The helper is compiled on first use (Xcode Command Line Tools: swiftc).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '../ocr/ocr.swift');
const STATE = path.join(here, '../state');
const BIN = path.join(STATE, 'bin/ocr');

let unavailable = null;   // reason, once compiling failed — don't retry every email
function helper() {
  if (unavailable) return null;
  try {
    const fresh = fs.existsSync(BIN) && fs.statSync(BIN).mtimeMs >= fs.statSync(SRC).mtimeMs;
    if (!fresh) {
      fs.mkdirSync(path.dirname(BIN), { recursive: true });
      execFileSync('swiftc', ['-O', SRC, '-o', BIN], { stdio: 'ignore', timeout: 300e3 });
    }
    return BIN;
  } catch (e) {
    unavailable = 'text recognition is not available on this Mac (' + (e.code || e.message) + ')';
    return null;
  }
}

// Lines on the same row (Vision returns pieces) joined left to right, top to bottom.
function rowsOf(page) {
  const rows = [];
  for (const l of page.lines) {
    const r = rows.find(r => Math.abs(r.y - l.y) < 4);
    if (r) r.lines.push(l); else rows.push({ y: l.y, lines: [l] });
  }
  return rows.sort((a, b) => b.y - a.y).map(r => r.lines.sort((a, b) => a.x - b.x).map(l => l.text).join(' '));
}

// → { text } (one row per line) or null when the file can't be read.
export function ocrText(bytes, name = 'file.pdf') {
  const bin = helper();
  if (!bin) return null;
  const ext = path.extname(name).toLowerCase() || '.pdf';
  const tmp = path.join(STATE, `ocr-${crypto.randomBytes(6).toString('hex')}${ext}`);
  fs.writeFileSync(tmp, bytes, { mode: 0o600 });
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const out = JSON.parse(execFileSync(bin, [tmp], { timeout: 120e3, maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] }));
        return { text: out.pages.flatMap(rowsOf).join('\n') };
      } catch (e) { if (attempt === 2) return null; }   // one retry: CoreGraphics occasionally fails once
    }
  } finally { fs.rmSync(tmp, { force: true }); }
  return null;
}

export const ocrUnavailable = () => unavailable;
