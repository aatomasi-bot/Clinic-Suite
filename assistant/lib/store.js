// Database access.
//   supabaseStore — signs in as YOU (refresh token from `npm run login`), so the
//                   same row-level security as the VaPiq app applies.
//   offlineStore  — fixture patients + a local JSON file; for testing with no
//                   network and no real data.
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { getSecret, setSecret, SECRETS } from './keychain.js';

export const HEARTBEAT_ID = '00000000-0000-0000-0000-00000000beef';

// { due, notes } → the card fields to change. The email's date wins over the
// form's; notes are added to Special Instructions once.
export function applyCardPatch(row, { due = '', notes = '' } = {}) {
  const record = { ...row.record };
  let missing = row.missing_fields || [], warnings = row.warnings || [];
  if (due && record.due_date !== due) {
    if (record.due_date && !missing.includes('Due Date')) warnings = [...warnings, `Due date from the coordinator's email (${due}) replaces the form's (${record.due_date}).`];
    record.due_date = due;
    missing = missing.filter(f => f !== 'Due Date');
  }
  const cur = String(record.special_instructions || '');
  const add = String(notes || '').split(' | ').filter(n => n && !cur.includes(n));
  if (add.length) record.special_instructions = [cur, ...add].filter(Boolean).join(' | ');
  return { record, missing_fields: missing, warnings };
}

// A lock directory in state/ shared by every assistant job (stale after 60 s).
const AUTH_LOCK = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'state', 'auth.lock');
async function withAuthLock(fn) {
  fs.mkdirSync(path.dirname(AUTH_LOCK), { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(AUTH_LOCK); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(AUTH_LOCK).mtimeMs > 60e3) { fs.rmSync(AUTH_LOCK, { recursive: true, force: true }); continue; } } catch {}
      if (i > 150) throw new Error('sign-in is busy — will try again');
      await new Promise(r => setTimeout(r, 200));
    }
  }
  try { return await fn(); } finally { fs.rmSync(AUTH_LOCK, { recursive: true, force: true }); }
}

export async function supabaseStore(cfg) {
  const sb = createClient(cfg.url, cfg.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  // The refresh key changes on every use; two jobs using it at once could
  // invalidate each other, so only one refreshes at a time.
  const { data, error } = await withAuthLock(async () => {
    const refresh = getSecret(SECRETS.supabaseSession);
    if (!refresh) throw new Error('Not signed in — run `npm run login` in the assistant folder first.');
    const res = await sb.auth.refreshSession({ refresh_token: refresh });
    if (res.data && res.data.session) setSecret(SECRETS.supabaseSession, res.data.session.refresh_token);
    return res;
  });
  if (error || !data.session) {
    const msg = error?.message || 'no session';
    if (/fetch failed|network|ENOTFOUND|ECONN|timed? ?out/i.test(msg)) throw new Error('No internet connection — will try again (' + msg + ')');
    throw new Error('Supabase sign-in expired — run `npm run login` again. (' + msg + ')');
  }
  const userEmail = data.session.user.email;

  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

  return {
    kind: 'supabase',
    async loadPatients() {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const page = must(await sb.from('patients').select('id,file_number,patient_name,archived,pending,dose_prescribed,doses_remaining').range(from, from + 999));
        out.push(...page);
        if (page.length < 1000) return out;
      }
    },
    async knownSourceKeys(keys) {
      if (!keys.length) return new Set();
      const rows = must(await sb.from('pending_patients').select('source_key').in('source_key', keys));
      return new Set(rows.map(r => r.source_key));
    },
    async openPendingFileNumbers() {
      const rows = must(await sb.from('pending_patients').select('record->>file_number').eq('status', 'pending'));
      return rows.map(r => r.file_number).filter(Boolean);
    },
    async insertPending(row) {
      return must(await sb.from('pending_patients').insert(row).select('id').single()).id;
    },
    async audit(action, fileNum, detail) {
      const { error } = await sb.from('audit_log').insert({
        user_email: userEmail, action, patient_file_num: String(fileNum || ''),
        detail: detail ? JSON.stringify(detail).slice(0, 500) : null, created_at: new Date().toISOString(),
      });
      if (error) console.warn('[audit] failed:', action, error.message);
    },
    async knownTaskKeys(keys) {
      if (!keys.length) return new Set();
      const rows = must(await sb.from('email_tasks').select('source_key').in('source_key', keys));
      return new Set(rows.map(r => r.source_key));
    },
    // Has this email already been read? (joined into an item, or a card of its own)
    async knownMessage(messageId) {
      const a = must(await sb.from('email_tasks').select('id').contains('related_emails', JSON.stringify([{ message_id: messageId }])).limit(1));
      if (a.length) return true;
      const b = must(await sb.from('email_tasks').select('id').eq('email_message_id', messageId).limit(1));
      return b.length > 0;
    },
    // The open/recent new-patient item for a file number (pairs coordinator + reports@ emails)
    async findGroupTask(groupKey, days) {
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const rows = must(await sb.from('email_tasks').select('*').eq('kind', 'new_patient').eq('group_key', groupKey)
        .gte('created_at', since).order('created_at', { ascending: false }).limit(1));
      return rows[0] || null;
    },
    // Open new-patient items of the last N days (to look for their other emails)
    async openNewPatientItems(days) {
      const since = new Date(Date.now() - days * 864e5).toISOString();
      return must(await sb.from('email_tasks').select('id,group_key,pending_id,documents,status').eq('kind', 'new_patient')
        .in('status', ['todo', 'waiting_docs', 'reply_ready']).not('group_key', 'is', null).gte('created_at', since));
    },
    // Reply cards for the AI job: open replies of the last 30 days (filtered in ai-queue.js)
    async tasksForAi() {
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      return must(await sb.from('email_tasks').select('id,status,is_test,reply_body,details')
        .in('status', ['reply_ready', 'todo', 'waiting_docs', 'failed']).gte('created_at', since).limit(200));
    },
    // Items you chose to "Leave it" whose email still has the assistant's ★
    async tasksToLeave() {
      const rows = must(await sb.from('email_tasks').select('*').eq('status', 'dismissed').contains('details', { leave: true }).limit(50));
      return rows.filter(t => !(t.details && t.details.left));
    },
    async getCard(id) {
      return must(await sb.from('pending_patients').select('id,status,attachment_name').eq('id', id).maybeSingle());
    },
    // Rebuild a card that is still waiting (never one you already decided on)
    async replaceCard(id, fields) {
      must(await sb.from('pending_patients').update(fields).eq('id', id).eq('status', 'pending'));
    },
    async insertTask(row) {
      return must(await sb.from('email_tasks').insert(row).select('id').single()).id;
    },
    async tasksToSend() {
      return must(await sb.from('email_tasks').select('*').eq('status', 'send_approved').order('decided_at'));
    },
    // send_approved → sending, atomically: returns false if it was already taken or cancelled
    async claimTask(id) {
      const rows = must(await sb.from('email_tasks').update({ status: 'sending' }).eq('id', id).eq('status', 'send_approved').select('id'));
      return rows.length === 1;
    },
    // What a later email says, added to a card that is still waiting for you
    async patchCard(pendingId, patch) {
      const row = must(await sb.from('pending_patients').select('id,status,record,missing_fields,warnings').eq('id', pendingId).maybeSingle());
      if (!row || row.status !== 'pending') return;
      must(await sb.from('pending_patients').update(applyCardPatch(row, patch)).eq('id', pendingId));
    },
    async updateTask(id, fields) {
      must(await sb.from('email_tasks').update(fields).eq('id', id));
    },
    async failStuckSending(minutes) {
      const cutoff = new Date(Date.now() - minutes * 60e3).toISOString();
      must(await sb.from('email_tasks').update({ status: 'failed', error: 'Interrupted while sending — check your Sent folder before retrying.' })
        .eq('status', 'sending').lt('decided_at', cutoff));
    },
    // Everything the safety net looks at (open items + active patients' scheduling fields)
    async snapshot() {
      const since = new Date(Date.now() - 60 * 864e5).toISOString();
      const pending = must(await sb.from('pending_patients').select('id,status,created_at,alerted_at,is_test').eq('status', 'pending'));
      const tasks = must(await sb.from('email_tasks').select('id,kind,status,created_at,decided_at,alerted_at,asked_docs_at,documents,is_test')
        .in('status', ['todo', 'waiting_docs', 'reply_ready', 'failed']).gte('created_at', since));
      const patients = [];
      for (let from = 0; ; from += 1000) {
        const page = must(await sb.from('patients').select('id,archived,pending,due_date,appointment_date_time,appointment_confirmed').range(from, from + 999));
        patients.push(...page);
        if (page.length < 1000) break;
      }
      return { pending, tasks, patients };
    },
    async markAlerted(items) {
      const at = new Date().toISOString();
      for (const table of ['pending_patients', 'email_tasks']) {
        const ids = items.filter(i => i.table === table).map(i => i.id);
        if (ids.length) must(await sb.from(table).update({ alerted_at: at }).in('id', ids));
      }
    },
    // One fixed row the Dubbi page reads: "Mac assistant checked 1 min ago"
    async heartbeat(summary) {
      const { error } = await sb.from('assistant_log').upsert({ id: HEARTBEAT_ID, kind: 'heartbeat', created_at: new Date().toISOString(), summary });
      if (error) console.warn('[heartbeat]', error.message);
    },
    async log(kind, summary) {
      const { error } = await sb.from('assistant_log').insert({ kind, summary });
      if (error) console.warn('[assistant_log]', error.message);
    },
    async pushSubscriptions() {
      return must(await sb.from('push_subscriptions').select('endpoint,p256dh,auth'));
    },
    async removeSubscription(endpoint) {
      await sb.from('push_subscriptions').delete().eq('endpoint', endpoint);
    },
    // Decided cards are kept 30 days, then removed (patients/audit_log keep the record).
    async purgeDecided(days) {
      const cutoff = new Date(Date.now() - days * 864e5).toISOString();
      await sb.from('pending_patients').delete().in('status', ['approved', 'rejected', 'dismissed']).lt('decided_at', cutoff);
      await sb.from('email_tasks').delete().in('status', ['sent', 'done', 'dismissed']).lt('decided_at', cutoff);
    },
  };
}

export function offlineStore({ patientsFile, outFile }) {
  const patients = JSON.parse(fs.readFileSync(patientsFile, 'utf8'));
  const saved = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
  const rows = Array.isArray(saved) ? saved : (saved.pending || []);
  const tasks = saved.tasks || [];
  const save = () => { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify({ pending: rows, tasks }, null, 2)); };
  return {
    kind: 'offline',
    rows,
    tasks,
    async knownTaskKeys(keys) { return new Set(tasks.map(t => t.source_key).filter(k => keys.includes(k))); },
    async knownMessage(id) { return tasks.some(t => t.email_message_id === id || (t.related_emails || []).some(r => r.message_id === id)); },
    async findGroupTask(k, days) {
      const since = Date.now() - days * 864e5;
      return tasks.filter(t => t.kind === 'new_patient' && t.group_key === k && Date.parse(t.created_at) >= since).at(-1) || null;
    },
    async openNewPatientItems(days) {
      const since = Date.now() - days * 864e5;
      return tasks.filter(t => t.kind === 'new_patient' && t.group_key && ['todo', 'waiting_docs', 'reply_ready'].includes(t.status) && Date.parse(t.created_at) >= since);
    },
    async getCard(id) { return rows.find(r => r.id === id) || null; },
    async tasksForAi() { return tasks.filter(t => ['reply_ready', 'todo', 'waiting_docs', 'failed'].includes(t.status)); },
    async tasksToLeave() { return tasks.filter(t => t.status === 'dismissed' && t.details && t.details.leave && !t.details.left); },
    async replaceCard(id, fields) { const r = rows.find(x => x.id === id); if (r && r.status === 'pending') { Object.assign(r, fields); save(); } },
    async insertTask(row) { const id = `task-${tasks.length + 1}`; tasks.push({ id, created_at: new Date().toISOString(), ...row }); save(); return id; },
    async tasksToSend() { return tasks.filter(t => t.status === 'send_approved'); },
    async claimTask(id) { const t = tasks.find(t => t.id === id); if (!t || t.status !== 'send_approved') return false; t.status = 'sending'; save(); return true; },
    async updateTask(id, fields) { Object.assign(tasks.find(t => t.id === id), fields); save(); },
    async patchCard(pendingId, patch) {
      const r = rows.find(x => x.id === pendingId); if (!r || r.status !== 'pending') return;
      Object.assign(r, applyCardPatch(r, patch)); save();
    },
    async failStuckSending() {},
    async loadPatients() { return patients; },
    async knownSourceKeys(keys) { return new Set(rows.map(r => r.source_key).filter(k => keys.includes(k))); },
    async openPendingFileNumbers() { return rows.filter(r => r.status === 'pending').map(r => r.record.file_number); },
    async insertPending(row) { const id = `offline-${rows.length + 1}`; rows.push({ id, ...row }); save(); return id; },
    async audit() {},
    async snapshot() { return { pending: rows.filter(r => r.status === 'pending'), tasks: tasks.filter(t => ['todo', 'waiting_docs', 'reply_ready', 'failed'].includes(t.status)), patients }; },
    async markAlerted(items) { const at = new Date().toISOString(); for (const i of items) { const r = (i.table === 'pending_patients' ? rows : tasks).find(x => x.id === i.id); if (r) r.alerted_at = at; } save(); },
    async log() {},
    async heartbeat() {},
    async pushSubscriptions() { return []; },
    async removeSubscription() {},
    async purgeDecided() {},
  };
}
