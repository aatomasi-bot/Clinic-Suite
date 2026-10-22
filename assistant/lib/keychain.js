// Secrets live in the macOS login Keychain — never in files or the repo.
// Values are passed to `security` on stdin (interactive mode), so they don't
// show up in the process list.
import { execFileSync } from 'node:child_process';

const ACCOUNT = 'vapiq-assistant';
const q = s => '"' + String(s).replace(/(["\\])/g, '\\$1') + '"';

export function getSecret(service) {
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-a', ACCOUNT, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function setSecret(service, value) {
  execFileSync('security', ['-i'], {
    input: `add-generic-password -U -s ${q(service)} -a ${q(ACCOUNT)} -w ${q(value)}\n`,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
}

export const SECRETS = {
  supabaseSession: 'vapiq-assistant-supabase',  // refresh token from `npm run login`
  yahooPassword:   'vapiq-assistant-yahoo',     // Yahoo *app password* (you add it yourself)
  vapid:           'vapiq-assistant-vapid',     // web-push keys from `npm run setup-push`
};
export { ACCOUNT as KEYCHAIN_ACCOUNT };
