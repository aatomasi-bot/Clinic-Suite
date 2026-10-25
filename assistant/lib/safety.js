// Safety net — so no patient falls through the cracks.
// Pure functions over a snapshot { pending, tasks, patients }, shared by the
// overdue alerts (every run) and the 7:00 AM summary. Outputs counts and ids
// only; notifications never carry names or file numbers.

const H = 36e5;

// In live mode, leftover TEST cards never count.
export const forMode = (snap, live) => live
  ? { ...snap, pending: snap.pending.filter(r => !r.is_test), tasks: snap.tasks.filter(t => !t.is_test) } : snap;
const ageHours = (iso, now) => iso ? (now - Date.parse(iso)) / H : 0;
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Everything that has waited longer than it should.
//   new patient card not added           > alerts.newPatientHours  (24 h)
//   reply drafted but not sent           > alerts.replyHours       (48 h)
//   documents missing and not yet asked  > alerts.waitingDocsHours (24 h)
//   asked for documents, still nothing   > 48 h after asking
export function overdueItems({ pending, tasks }, alerts, now = Date.now()) {
  const out = [];
  for (const r of pending) {
    if (r.status === 'pending' && ageHours(r.created_at, now) > alerts.newPatientHours)
      out.push({ table: 'pending_patients', id: r.id, why: 'new_patient_not_added', alerted_at: r.alerted_at });
  }
  for (const t of tasks) {
    const docsMissing = t.kind === 'new_patient' && t.documents && (!t.documents.assignment || !t.documents.enrollment);
    if (t.status === 'reply_ready' && ageHours(t.decided_at || t.created_at, now) > alerts.replyHours)
      out.push({ table: 'email_tasks', id: t.id, why: 'reply_not_sent', alerted_at: t.alerted_at });
    else if (t.status === 'todo' && t.kind !== 'new_patient' && ageHours(t.created_at, now) > alerts.newPatientHours)
      out.push({ table: 'email_tasks', id: t.id, why: { close_file: 'file_not_closed', prescription: 'prescription_not_applied' }[t.kind] || 'update_not_applied', alerted_at: t.alerted_at });
    else if (t.status === 'todo' && docsMissing && !t.asked_docs_at && ageHours(t.created_at, now) > alerts.waitingDocsHours)
      out.push({ table: 'email_tasks', id: t.id, why: 'documents_missing', alerted_at: t.alerted_at });
    else if (t.status === 'waiting_docs' && ageHours(t.asked_docs_at || t.decided_at, now) > 48)
      out.push({ table: 'email_tasks', id: t.id, why: 'documents_still_missing', alerted_at: t.alerted_at });
    else if (t.status === 'failed')
      out.push({ table: 'email_tasks', id: t.id, why: 'reply_failed', alerted_at: t.alerted_at });
  }
  return out;
}

// Alert at most once a day per item.
export const dueForAlert = (items, now = Date.now()) => items.filter(i => !i.alerted_at || ageHours(i.alerted_at, now) >= 24);

// Active VaPiq patients who need scheduling: no appointment and due within
// `days` (or already overdue). Same idea as VaPiq's own reminder groups.
export function schedulingGaps(patients, days, now = new Date()) {
  const today = ymd(now), horizon = ymd(new Date(now.getTime() + days * 864e5));
  const active = patients.filter(p => !p.archived);
  const noAppt = active.filter(p => !p.appointment_date_time && p.due_date && p.due_date <= horizon);
  return {
    noAppointment: noAppt.length,
    overdueNoAppointment: noAppt.filter(p => p.due_date < today).length,
    unconfirmed: active.filter(p => p.appointment_date_time && !p.appointment_confirmed
      && String(p.appointment_date_time).slice(0, 10) >= today && String(p.appointment_date_time).slice(0, 10) <= horizon).length,
    visitsToday: active.filter(p => String(p.appointment_date_time || '').slice(0, 10) === today).length,
  };
}

export function openCounts({ pending, tasks }) {
  const open = t => ['todo', 'reply_ready', 'failed'].includes(t.status);
  return {
    newPatients: pending.filter(r => r.status === 'pending').length,
    prescriptions: tasks.filter(t => t.kind === 'prescription' && t.status === 'todo').length,
    closes: tasks.filter(t => t.kind === 'close_file' && t.status === 'todo').length,
    updates: tasks.filter(t => ['on_hold', 'back', 'permanent'].includes(t.kind) && t.status === 'todo').length,
    replies: tasks.filter(t => t.status === 'reply_ready').length,
    waitingDocs: tasks.filter(t => t.status === 'waiting_docs' || (open(t) && t.kind === 'new_patient' && t.documents && (!t.documents.assignment || !t.documents.enrollment))).length,
    failed: tasks.filter(t => t.status === 'failed').length,
  };
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function morningText(c, g, overdue) {
  const todo = c.newPatients + c.prescriptions + c.closes + (c.updates || 0) + c.replies + c.failed;
  const parts = [];
  if (todo) parts.push(`${plural(todo, 'item')} to do`);
  if (overdue) parts.push(`⚠️ ${overdue} overdue`);
  if (c.waitingDocs) parts.push(`${c.waitingDocs} waiting for documents`);
  if (g.noAppointment) parts.push(`${plural(g.noAppointment, 'patient')} to schedule${g.overdueNoAppointment ? ` (${g.overdueNoAppointment} past due)` : ''}`);
  if (g.unconfirmed) parts.push(`${g.unconfirmed} to confirm`);
  parts.push(`${plural(g.visitsToday, 'visit')} today`);
  return parts.join(' · ');
}

export function overdueText(items) {
  const n = items.length;
  return `⚠️ ${plural(n, 'item')} waiting too long — open Approvals`;
}
