// Dubbi's natural voice: Kokoro, an open-source voice that runs on this Mac,
// offline and free (installed by install-voice.sh into assistant/voice/).
// Nothing leaves the Mac, so it can say patient names. Dubbi plays the recording.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const PY = path.join(ROOT, 'voice', '.venv', 'bin', 'python');
const MODEL = path.join(ROOT, 'voice', 'models', 'kokoro-v1.0.fp16.onnx');

// How it is read: "#35037 (Jean Tremblay)" → "Jean Tremblay"; "#35037" → "file 35037"
export function speakable(text, fr) {
  return String(text || '')
    .replace(/#(\d{4,6})\s*\(([^)#]{2,60})\)/g, '$2')
    .replace(/#(\d{4,6})/g, (fr ? 'dossier ' : 'file ') + '$1')
    .replace(/[👍✓✨⚠️🔒]/gu, '').replace(/\s*—\s*/g, ', ').replace(/\s+/g, ' ').trim().slice(0, 1200);
}

export const voiceInstalled = () => fs.existsSync(PY) && fs.existsSync(MODEL);

// One Kokoro process, started on first use and kept (the voice loads once, ~2 s).
// Returns (text, fr) → base64 AAC (.m4a), or null. Never throws.
export function kokoroVoice({ timeoutMs = 15e3 } = {}) {
  if (!voiceInstalled()) return null;
  let child = null, ready = null, queue = Promise.resolve();
  const waiting = [];
  const start = () => {
    child = spawn(PY, [path.join(ROOT, 'kokoro_say.py')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    ready = new Promise((res, rej) => {
      child.stdout.on('data', d => {
        buf += d;
        for (let i; (i = buf.indexOf('\n')) >= 0;) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.ready) res(); else waiting.shift()?.(m);
        }
      });
      child.on('exit', () => { child = null; rej(new Error('voice stopped')); while (waiting.length) waiting.shift()({ ok: false, error: 'voice stopped' }); });
    });
    ready.catch(() => {});
  };
  const once = async (text, fr) => {
    const input = speakable(text, fr);
    if (!input) return null;
    if (!child) start();
    await ready;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dubbi-voice-'));
    const wav = path.join(tmp, 'a.wav'), m4a = path.join(tmp, 'a.m4a');
    try {
      const r = await new Promise(res => {
        const t = setTimeout(() => res({ ok: false, error: 'too slow' }), timeoutMs);
        waiting.push(m => { clearTimeout(t); res(m); });
        child.stdin.write(JSON.stringify({ text: input, lang: fr ? 'fr' : 'en', out: wav }) + '\n');
      });
      if (!r.ok) { console.warn('voice:', r.error); return null; }
      // AAC: ~7× smaller than WAV, plays on iPhone (afconvert is built into macOS)
      await new Promise((res, rej) => execFile('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '48000', wav, m4a], e => e ? rej(e) : res()));
      return fs.readFileSync(m4a).toString('base64');
    } catch (e) { console.warn('voice:', e.message); return null; }
    finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  };
  // one at a time, in order
  const speak = (text, fr) => { const p = queue.then(() => once(text, fr)); queue = p.catch(() => {}); return p; };
  speak.close = () => { try { child?.stdin.end(); child?.kill(); } catch {} };
  return speak;
}
