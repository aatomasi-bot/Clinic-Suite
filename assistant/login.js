// Signs the assistant in to Supabase as you, once. Run it yourself in
// Terminal: your password is typed here (hidden), sent only to Supabase, and
// never stored — only the session's refresh token is kept, in your Keychain.
import readline from 'node:readline';
import { createClient } from '@supabase/supabase-js';
import { loadConfig } from './intake.js';
import { setSecret, SECRETS } from './lib/keychain.js';

function ask(question, hidden = false) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

const cfg = loadConfig();
const sb = createClient(cfg.supabase.url, cfg.supabase.publishableKey, { auth: { persistSession: false } });
const email = await ask('VaPiq email: ');
const password = await ask('VaPiq password (hidden): ', true);
const { data, error } = await sb.auth.signInWithPassword({ email, password });
if (error || !data.session) { console.error('Sign-in failed:', error?.message || 'no session'); process.exit(1); }
setSecret(SECRETS.supabaseSession, data.session.refresh_token);
console.log('Signed in. The assistant will act as', data.session.user.email, '(same permissions as the VaPiq app).');
