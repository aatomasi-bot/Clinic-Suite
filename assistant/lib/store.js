// Database access.
//   supabaseStore — signs in as YOU (refresh token from `npm run login`), so the
//                   same row-level security as the VaPiq app applies.
//   offlineStore  — fixture patients + a local JSON file; for testing with no
//                   network and no real data.
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { getSecret, setSecret, SECRETS } from './keychain.js';

export async function supabaseStore(cfg) {
  const sb = createClient(cfg.url, cfg.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const refresh = getSecret(SECRETS.supabaseSession);
  if (!refresh) throw new Error('Not signed in — run `npm run login` in the assistant folder first.');
  const { data, error } = await sb.auth.refreshSession({ refresh_token: refresh });
  if (error || !data.session) throw new Error('Supabase sign-in expired — run `npm run login` again. (' + (error?.message || 'no session') + ')');
  setSecret(SECRETS.supabaseSession, data.session.refresh_token);   // tokens rotate on every refresh
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
    async updateTask(id, fields) {
      must(await sb.from('email_tasks').update(fields).eq('id', id));
    },
    async failStuckSending(minutes) {
      const cutoff = new Date(Date.now() - minutes * 60e3).toISOString();
      must(await sb.from('email_tasks').update({ status: 'failed', error: 'Interrupted while sending — check your Sent folder before retrying.' })
        .eq('status', 'sending').lt('decided_at', cutoff));
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
    async insertTask(row) { const id = `task-${tasks.length + 1}`; tasks.push({ id, created_at: new Date().toISOString(), ...row }); save(); return id; },
    async tasksToSend() { return tasks.filter(t => t.status === 'send_approved'); },
    async claimTask(id) { const t = tasks.find(t => t.id === id); if (!t || t.status !== 'send_approved') return false; t.status = 'sending'; save(); return true; },
    async updateTask(id, fields) { Object.assign(tasks.find(t => t.id === id), fields); save(); },
    async failStuckSending() {},
    async loadPatients() { return patients; },
    async knownSourceKeys(keys) { return new Set(rows.map(r => r.source_key).filter(k => keys.includes(k))); },
    async openPendingFileNumbers() { return rows.filter(r => r.status === 'pending').map(r => r.record.file_number); },
    async insertPending(row) { const id = `offline-${rows.length + 1}`; rows.push({ id, ...row }); save(); return id; },
    async audit() {},
    async pushSubscriptions() { return []; },
    async removeSubscription() {},
    async purgeDecided() {},
  };
}
