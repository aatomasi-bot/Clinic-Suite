// Notifications carry COUNTS only — never names, file numbers or other patient
// details — because they show on the lock screen and pass through Apple's
// push service.
import { execFile } from 'node:child_process';
import webpush from 'web-push';
import { getSecret, SECRETS } from './keychain.js';

export function summaryText({ queued, exists, needsReview, prescriptions, closes }) {
  const parts = [];
  if (queued) parts.push(`${queued} new patient${queued > 1 ? 's' : ''} to review`);
  if (prescriptions) parts.push(`${prescriptions} prescription${prescriptions > 1 ? 's' : ''} to apply`);
  if (closes) parts.push(`${closes} file${closes > 1 ? 's' : ''} to close`);
  if (exists) parts.push(`${exists} duplicate${exists > 1 ? 's' : ''}`);
  if (needsReview) parts.push(`${needsReview} need${needsReview > 1 ? '' : 's'} manual reading`);
  return parts.join(' · ');
}

export function macNotification(title, body) {
  const esc = s => String(s).replace(/(["\\])/g, '\\$1');
  execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], () => {});
}

export async function pushToPhones(store, { title, body, url, subject }) {
  const raw = getSecret(SECRETS.vapid);
  if (!raw) return { sent: 0, skipped: 'no VAPID keys (run npm run setup-push)' };
  const { publicKey, privateKey } = JSON.parse(raw);
  webpush.setVapidDetails(subject, publicKey, privateKey);
  let sent = 0;
  for (const s of await store.pushSubscriptions()) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body, url }), { TTL: 3600 });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await store.removeSubscription(s.endpoint);  // phone unsubscribed
      else console.warn('[push] failed:', e.statusCode || e.message);
    }
  }
  return { sent };
}
