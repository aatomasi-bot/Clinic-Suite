// Dubbi's AI voice (ElevenLabs): your Mac turns Claude's answer into natural speech,
// and Dubbi plays it.
// Privacy: only the NAME-FREE answer is sent (file numbers, dates, statuses — the
// same text Claude wrote before names were put back), checked once more by redact().
// The ElevenLabs key lives in your Mac's Keychain (npm run voice-setup), never in a file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './ai.js';
import { getSecret, SECRETS } from './keychain.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const VOICE_FILE = path.join(here, '..', 'state', 'voice.json');   // { voiceId, name } chosen in voice-setup
export const DEFAULT_VOICE = { voiceId: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah' };
const API = 'https://api.elevenlabs.io/v1';

// What is read aloud: "#35037" → "file 35037"; nothing identifying, or nothing at all.
export function speakable(text, fr) {
  const t = String(text || '').replace(/#(\d{4,6})/g, (fr ? 'dossier ' : 'file ') + '$1').replace(/👍/g, '').replace(/\s+/g, ' ').trim();
  if (!t || redact(t) !== t) return '';
  return t.slice(0, 800);
}

export function voiceChoice() {
  try { return { ...DEFAULT_VOICE, ...JSON.parse(fs.readFileSync(VOICE_FILE, 'utf8')) }; } catch { return DEFAULT_VOICE; }
}

// text → mp3 (base64), or null. Never throws: no voice just means the phone's own voice.
export function elevenLabs({ key = getSecret(SECRETS.elevenLabs), model = 'eleven_multilingual_v2', timeoutMs = 9000, fetchFn = fetch } = {}) {
  if (!key) return null;
  return async (text, fr) => {
    const input = speakable(text, fr);
    if (!input) return null;
    const { voiceId } = voiceChoice();
    try {
      const res = await fetchFn(`${API}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_64`, {
        method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text: input, model_id: model, voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.15, speed: 1.0 } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { console.warn('voice:', res.status, (await res.text()).slice(0, 150)); return null; }
      return Buffer.from(await res.arrayBuffer()).toString('base64');
    } catch (e) { console.warn('voice:', e.message); return null; }
  };
}

export async function listVoices(key, fetchFn = fetch) {
  const res = await fetchFn(`${API}/voices`, { headers: { 'xi-api-key': key } });
  if (!res.ok) throw new Error(`ElevenLabs said ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return (await res.json()).voices || [];
}
