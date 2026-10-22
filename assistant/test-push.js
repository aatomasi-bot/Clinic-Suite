// Sends one test notification to every device that tapped "Notify me".
//   npm run test-push
import { loadConfig } from './intake.js';
import { supabaseStore } from './lib/store.js';
import { pushToPhones } from './lib/notify.js';

const cfg = loadConfig();
const store = await supabaseStore(cfg.supabase);
const r = await pushToPhones(store, { title: 'VaPiq (test)', body: 'Notifications are working ✓', url: cfg.push.approvalsUrl, subject: cfg.push.subject });
console.log(r.skipped ? `Not sent: ${r.skipped}` : `Test notification sent to ${r.sent} device(s).` + (r.sent ? '' : ' Tap "Notify me" in Approvals on your iPhone first.'));
