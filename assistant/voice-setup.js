// Dubbi's AI voice, once: paste your ElevenLabs API key (hidden), pick a voice,
// hear a sample. The key goes to your Mac's Keychain only.
//   npm run voice-setup
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { setSecret, getSecret, SECRETS } from './lib/keychain.js';
import { elevenLabs, listVoices, voiceChoice, VOICE_FILE } from './lib/voice.js';

function ask(question, hidden = false) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

const have = getSecret(SECRETS.elevenLabs);
let key = await ask(have ? 'ElevenLabs API key (hidden; press Return to keep the saved one): ' : 'ElevenLabs API key (hidden): ', true);
if (!key) key = have;
if (!key) { console.error('No key — nothing changed.'); process.exit(1); }

let voices;
try { voices = await listVoices(key); } catch (e) { console.error(e.message.includes('401') ? 'That key was not accepted. Copy it again from elevenlabs.io → Developers → API Keys.' : e.message); process.exit(1); }
setSecret(SECRETS.elevenLabs, key);
console.log('✓ Key saved in your Keychain.\n');

const cur = voiceChoice();
const list = voices.slice(0, 40);
list.forEach((v, i) => {
  const l = v.labels || {};
  console.log(`${String(i + 1).padStart(2)}. ${v.name}${[l.gender, l.accent, l.age, l.descriptive || l.description].filter(Boolean).length ? ' — ' + [l.gender, l.accent, l.age, l.descriptive || l.description].filter(Boolean).join(', ') : ''}${v.voice_id === cur.voiceId ? '   ← current' : ''}`);
});
const pick = await ask(`\nVoice number (Return = ${cur.name}): `);
const chosen = list[Number(pick) - 1] || list.find(v => v.voice_id === cur.voiceId) || list[0];
fs.mkdirSync(path.dirname(VOICE_FILE), { recursive: true });
fs.writeFileSync(VOICE_FILE, JSON.stringify({ voiceId: chosen.voice_id, name: chosen.name }, null, 2));
console.log(`✓ Dubbi will speak with ${chosen.name}.`);

const tts = elevenLabs({ key });
const mp3 = await tts('Hi! File 35037 is due Thursday and has no appointment yet. Bonjour! Le dossier 35037 est dû jeudi.', false);
if (mp3) {
  const f = path.join(os.tmpdir(), 'dubbi-voice-sample.mp3');
  fs.writeFileSync(f, Buffer.from(mp3, 'base64'));
  console.log('▶ Playing a sample…');
  try { execFileSync('afplay', [f]); } catch {}
  fs.rmSync(f, { force: true });
} else console.log('(Could not make a sample — check your ElevenLabs credits.)');

// Restart Dubbi's brain so it uses the voice right away
try { execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.vapiq.brain`], { stdio: 'ignore' }); console.log('✓ Dubbi\'s brain restarted with the new voice.'); } catch {}
console.log('Run `npm run voice-setup` again any time to change the voice.');
