// Sends replies YOU approved in the Approvals page (status "send_approved").
// Safety checks before anything leaves:
//   - only to the coordinator who wrote (+ CC reports@) — allowed domain, not excluded, never no-reply@
//   - test cards only ever go to the test mailer; real cards only in live mode
//   - each task is claimed (send_approved → sending) so it can never go twice
import { replyAllowed } from './classify.js';

export async function runOutbox({ store, mailer, testMailer, rules, live, moveToFolder, log = console.log }) {
  const counts = { sent: 0, failed: 0, waiting: 0 };
  await store.failStuckSending(15);   // crashed mid-send → failed, so you check before retrying

  for (const task of await store.tasksToSend()) {
    const m = task.is_test ? testMailer : (live ? mailer : null);
    if (!m) { counts.waiting++; continue; }                     // real reply, but service is in test mode
    const recipients = [task.to_address, ...(task.cc_addresses || [])];
    if (!recipients.every(a => replyAllowed(a, rules)) || !String(task.reply_body || '').trim()) {
      await store.updateTask(task.id, { status: 'failed', error: 'Blocked: recipient not an allowed coordinator, or empty reply.' });
      counts.failed++; continue;
    }
    if (!(await store.claimTask(task.id))) continue;            // someone else took it / you cancelled
    try {
      const files = String(task.file_number || '').split(/[,\s]+/).filter(Boolean);
      const names = store.patientNames ? await store.patientNames(files, task.pending_id).catch(() => []) : [];
      await m.send(task, names);   // subject: initials + file number only
      const askDocs = task.details && task.details.reply_mode === 'ask_docs';
      if (askDocs) {
        // Asked for missing documents: keep the item open until they arrive; the email stays in Inbox
        const now = new Date().toISOString();
        await store.updateTask(task.id, { status: 'waiting_docs', asked_docs_at: now, sent_at: now, error: null,
          details: { ...task.details, reply_mode: 'confirm', asked: [...((task.details.asked) || []), now] } });
        await store.audit('ASSISTANT_DOCS_REQUESTED', task.file_number, { task_id: task.id, test: task.is_test });
        log(`  sent    documents request ${task.id}${task.is_test ? ' (test — saved, not sent)' : ''}`);
        counts.sent++;
        continue;
      }
      // notes to Medicum written in VaPiq have no original email to file
      const moved = moveToFolder && task.kind !== 'medicum_note' ? await m.moveOriginal(task, moveToFolder).catch(e => { log('  move failed:', e.message); return false; }) : false;
      await store.updateTask(task.id, { status: 'sent', sent_at: new Date().toISOString(), error: null, moved_to_folder: moved ? moveToFolder : null });
      await store.audit('ASSISTANT_REPLY_SENT', task.file_number, { task_id: task.id, kind: task.kind, test: task.is_test });
      log(`  sent    reply ${task.id}${task.is_test ? ' (test — saved, not sent)' : ''}${moved ? ` · moved to ${moveToFolder}` : ''}`);
      counts.sent++;
    } catch (e) {
      await store.updateTask(task.id, { status: 'failed', error: String(e.message || e).slice(0, 300) });
      log(`  failed  reply ${task.id}: ${e.message}`);
      counts.failed++;
    }
  }
  return counts;
}
