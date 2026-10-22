// 7:00 AM summary — what's open, what's overdue, who still needs an
// appointment. launchd runs it every morning (install-launchd.sh); if the Mac
// was asleep at 7:00 it runs as soon as it wakes. Counts only — no names.
//   node summary.js
import { loadConfig } from './intake.js';
import { supabaseStore } from './lib/store.js';
import { pushToPhones, macNotification } from './lib/notify.js';
import { overdueItems, schedulingGaps, openCounts, morningText, forMode } from './lib/safety.js';

const cfg = loadConfig();
const store = await supabaseStore(cfg.supabase);
const snap = forMode(await store.snapshot(), cfg.mode === 'live' && cfg.liveConfirmed === true);
const counts = openCounts(snap), gaps = schedulingGaps(snap.patients, cfg.alerts.noAppointmentDays);
const overdue = overdueItems(snap, cfg.alerts).length;
const body = morningText(counts, gaps, overdue);
const title = 'Good morning ☀️ — VaPiq';
if (cfg.push.mac) macNotification(title, body);
const r = await pushToPhones(store, { title, body, url: cfg.push.approvalsUrl, subject: cfg.push.subject });
await store.log('morning_summary', { ...counts, ...gaps, overdue });
console.log(`[${new Date().toISOString()}] ${body} — push to ${r.sent ?? 0} device(s)`);
