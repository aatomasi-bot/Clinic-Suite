// Dubbi — the brain behind the voice assistant.
// Plain JavaScript with no imports, so it runs in the Supabase Edge Function
// (index.ts) and in local tests alike. Everything it needs is passed in.
//
// Safety model
//   • Claude can only READ (overview, lists, patient lookup, reply drafts).
//   • For anything that changes data or sends email, Claude can only PROPOSE.
//     The proposal waits until YOU confirm (button, or saying "yes"/"oui"),
//     and then this code — not the AI — carries it out, re-checking everything.
//   • Conversations are append-only and kept 7 days.

export const MODEL = 'claude-opus-5-5';
const DOSES = ['7.5', '22.5', '30', '45'];
const HEARTBEAT_ID = '00000000-0000-0000-0000-00000000beef';
const MAX_MESSAGES = 60;          // then a fresh conversation starts
const OPEN = ['todo', 'reply_ready', 'failed', 'waiting_docs'];
const YES = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|confirm(ed)?|do it|go ahead|send it|please do|oui|ouais|d'accord|vas-?y|confirme|envoie)\b[\s.!]*$/i;
const NO = /^\s*(no|nope|cancel|stop|don'?t|non|annule|laisse tomber)\b/i;
const FR = /\b(bonjour|merci|patient(e)?s?|dossier|nouveau|nouvelle|ferme[rz]?|envoie|rendez-vous|quels?|quelles?|est-ce|combien|aujourd'hui|demain|oui|non)\b|[éèêàçù]/i;

const SYSTEM = `You are Dubbi, the voice assistant of a home-care nurse in Montreal who gives injections (Eligard) to patients assigned by Medicum coordinators. You work on top of VaPiq, the nurse's patient app.

How to answer
- Your answers are usually spoken aloud. Keep them short and natural: one to three sentences, no markdown, no bullet points, no emojis. Read numbers the way a person says them.
- Answer in the language the nurse uses (English or French).
- Use the tools to look things up. Never guess or invent patient details, counts, dates or file numbers. If a tool returns nothing, say so.
- Refer to a patient by name and file number when the nurse asks about them; otherwise prefer counts and file numbers.

Actions
- You cannot change anything yourself. To send a reply, mark a prescription applied, close a file, ask a coordinator for documents, or add a new patient, call propose_action. Then, in one short sentence, say exactly what will happen and ask the nurse to confirm. Do not claim it is done.
- Propose one action at a time unless the nurse clearly asked for several.
- If an item can't be acted on yet (for example a new patient whose form is missing information), explain what is missing.

Background
- New assignments arrive by email. The nurse's Mac checks the inbox every two minutes; check_for_new_assignments tells you when it last checked.
- Coordinator replies are sent by the Mac within about two minutes after the nurse confirms.
- "To schedule" means an active patient who is due within 14 days and has no appointment yet.`;

// ── Tools Claude may call ───────────────────────────────────────────────
const S = (props, required = Object.keys(props)) => ({ type: 'object', properties: props, required, additionalProperties: false });
export const TOOLS = [
  { name: 'get_overview', description: 'Counts of everything that needs the nurse: new patients to add, replies to send, files to close, prescriptions to apply, items waiting for documents, overdue items, patients to schedule, appointments to confirm, visits today, and when the Mac last checked email. Use for "what\'s new", "what do I have", briefings.',
    strict: true, input_schema: S({}) },
  { name: 'list_open_items', description: 'The open to-do items (each with an item_id to use with read_reply or propose_action). Filter by kind.',
    strict: true, input_schema: S({ kind: { type: 'string', enum: ['all', 'new_patient', 'reply', 'close_file', 'prescription', 'waiting_docs', 'overdue'] } }) },
  { name: 'check_for_new_assignments', description: 'Assignments and coordinator requests that arrived in the last 24 hours, plus when the Mac last checked the inbox. Use for "look for new assignments", "anything new?".',
    strict: true, input_schema: S({}) },
  { name: 'find_patient', description: 'Look up VaPiq patients by file number or (part of) a name. Returns up to 5 matches with status, dose, doses remaining, due date, appointment and phone.',
    strict: true, input_schema: S({ query: { type: 'string', description: 'File number like 35290, or a name like Tremblay' } }) },
  { name: 'list_scheduling', description: 'Scheduling lists. need_appointment: active patients due within 14 days with no appointment. to_confirm: upcoming appointments not yet confirmed. appointments: booked appointments between from and to (YYYY-MM-DD).',
    strict: true, input_schema: S({ list: { type: 'string', enum: ['need_appointment', 'to_confirm', 'appointments'] },
      from: { type: 'string', description: 'YYYY-MM-DD, or empty for today' }, to: { type: 'string', description: 'YYYY-MM-DD, or empty for 14 days from now' } }) },
  { name: 'read_reply', description: 'The drafted reply for an item (recipient, CC and text), to read it to the nurse before sending.',
    strict: true, input_schema: S({ item_id: { type: 'string' } }) },
  { name: 'propose_action', description: 'Propose an action. It does NOT run: the nurse must confirm first. send_reply: send the drafted reply of a reply item. mark_applied: a prescription was applied in VaPiq (makes the reply ready). close_file: archive the patient in VaPiq (makes the reply ready). ask_for_documents: prepare the polite request for missing documents. add_patient: add a new patient to VaPiq from the pre-filled form.',
    strict: true, input_schema: S({ action: { type: 'string', enum: ['send_reply', 'mark_applied', 'close_file', 'ask_for_documents', 'add_patient'] }, item_id: { type: 'string' } }) },
];

// ── Helpers ─────────────────────────────────────────────────────────────
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const ymd = d => d.toISOString().slice(0, 10);
const hoursSince = (iso, now) => iso ? (now - Date.parse(iso)) / 36e5 : 0;
const trimFile = f => String(f ?? '').trim();
const normFile = f => trimFile(f).toLowerCase();
const docsMissing = t => t.kind === 'new_patient' && t.documents && ['assignment', 'enrollment'].filter(k => !t.documents[k]);
const unknownDocs = t => ((t.documents && t.documents.files) || []).filter(f => !(f.types || []).length && !f.checked).length;
const statusOf = p => p.archived ? 'Archived' : p.pending ? 'Pending' : 'Active';
const coordinator = t => t.to_name || (t.email_from || '').replace(/<.*>/, '').trim() || t.to_address;

export function montrealNow(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montreal', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(now));
}

export function createDubbi({ sb, anthropic, userId, userEmail, now = () => Date.now(), log = () => {} }) {
  const since30 = () => new Date(now() - 30 * 864e5).toISOString();

  async function loadState() {
    const [pending, tasks] = await Promise.all([
      sb.from('pending_patients').select('*').gte('created_at', since30()).then(must),
      sb.from('email_tasks').select('*').gte('created_at', since30()).then(must),
    ]);
    return { pending, tasks };
  }

  // One item per thing to do — the same rules as the Dubbi page.
  function items({ pending, tasks }) {
    const out = [], used = new Set(), t0 = now();
    for (const t of tasks) {
      if (!OPEN.includes(t.status)) continue;
      const r = t.pending_id ? pending.find(p => p.id === t.pending_id) : null;
      if (r) used.add(r.id);
      if (t.kind === 'new_patient' && t.status === 'todo' && r && ['rejected', 'dismissed', 'exists'].includes(r.status)) continue;
      const kind = t.status === 'waiting_docs' ? 'waiting_docs' : (t.status === 'reply_ready' || t.status === 'failed') ? 'reply'
        : t.kind === 'new_patient' ? (r && r.status === 'approved' ? 'reply' : 'new_patient') : t.kind;
      const missing = docsMissing(t) || [];
      const age = hoursSince(t.created_at, t0);
      const overdue = (kind === 'new_patient' && age > 24) || (kind === 'reply' && hoursSince(t.decided_at || t.created_at, t0) > 48)
        || ((kind === 'close_file' || kind === 'prescription') && age > 24) || (kind === 'waiting_docs' && hoursSince(t.asked_docs_at, t0) > 48) || t.status === 'failed';
      out.push({ item_id: 't:' + t.id, kind, file_number: trimFile(t.file_number), reference: t.subject_ref || null,
        patient_name: r?.record?.patient_name || t.existing_patient?.patient_name || null, coordinator: coordinator(t),
        documents_missing: missing, age_hours: Math.round(age), overdue, test: !!t.is_test,
        note: t.status === 'failed' ? `send failed: ${t.error || 'unknown'}` : (t.details && t.details.reply_mode === 'ask_docs' && kind === 'reply') ? 'reply asks for documents' : undefined });
    }
    for (const r of pending) {
      if (used.has(r.id) || r.status !== 'pending') continue;
      const age = hoursSince(r.created_at, t0);
      out.push({ item_id: 'p:' + r.id, kind: 'new_patient', file_number: trimFile(r.record.file_number), reference: null,
        patient_name: r.record.patient_name || null, coordinator: (r.email_from || '').replace(/<.*>/, '').trim(),
        documents_missing: [], age_hours: Math.round(age), overdue: age > 24, test: !!r.is_test });
    }
    return out;
  }

  async function heartbeat() {
    const h = await sb.from('assistant_log').select('created_at,summary').eq('id', HEARTBEAT_ID).maybeSingle().then(must);
    return h ? { mac_last_checked_minutes_ago: Math.round((now() - Date.parse(h.created_at)) / 6e4), mode: h.summary?.mode || null } : { mac_last_checked_minutes_ago: null };
  }

  async function scheduling(list, from, to) {
    const today = ymd(new Date(now())), horizon = ymd(new Date(now() + 14 * 864e5));
    const f = from || today, t = to || horizon;
    if (list === 'need_appointment') {
      const rows = await sb.from('patients').select('file_number,patient_name,due_date,phone1').eq('archived', false)
        .is('appointment_date_time', null).lte('due_date', horizon).order('due_date').then(must);
      return rows.map(p => ({ name: p.patient_name, file_number: trimFile(p.file_number), due_date: p.due_date, past_due: p.due_date < today, phone: p.phone1 || null }));
    }
    let q = sb.from('patients').select('file_number,patient_name,appointment_date_time,appointment_confirmed,phone1,address').eq('archived', false)
      .gte('appointment_date_time', f).lte('appointment_date_time', t + 'T23:59').order('appointment_date_time');
    if (list === 'to_confirm') q = q.eq('appointment_confirmed', false);
    const rows = await q.then(must);
    return rows.map(p => ({ name: p.patient_name, file_number: trimFile(p.file_number), appointment: p.appointment_date_time, confirmed: !!p.appointment_confirmed, phone: p.phone1 || null, address: p.address || null }));
  }

  // ── Read tools ──────────────────────────────────────────────────────
  async function runTool(name, input, ctx) {
    switch (name) {
      case 'get_overview': {
        const st = await loadState(), it = items(st);
        const need = await scheduling('need_appointment'), conf = await scheduling('to_confirm');
        const today = ymd(new Date(now()));
        const visits = await scheduling('appointments', today, today);
        const c = k => it.filter(i => i.kind === k).length;
        return { new_patients_to_add: c('new_patient'), replies_to_send: c('reply'), files_to_close: c('close_file'), prescriptions_to_apply: c('prescription'),
          waiting_for_documents: c('waiting_docs'), overdue: it.filter(i => i.overdue).length, test_items: it.filter(i => i.test).length,
          patients_to_schedule: need.length, past_due_without_appointment: need.filter(p => p.past_due).length,
          appointments_to_confirm: conf.length, visits_today: visits.length, ...(await heartbeat()) };
      }
      case 'list_open_items': {
        let it = items(await loadState());
        if (input.kind === 'overdue') it = it.filter(i => i.overdue);
        else if (input.kind && input.kind !== 'all') it = it.filter(i => i.kind === input.kind);
        return { count: it.length, items: it.slice(0, 25) };
      }
      case 'check_for_new_assignments': {
        const st = await loadState(), cutoff = now() - 24 * 36e5;
        const fresh = items(st).filter(i => {
          const src = i.item_id.startsWith('t:') ? st.tasks.find(t => 't:' + t.id === i.item_id) : st.pending.find(r => 'p:' + r.id === i.item_id);
          return src && Date.parse(src.created_at) >= cutoff;
        });
        return { last_24_hours: fresh, ...(await heartbeat()), note: 'The Mac checks the inbox every 2 minutes.' };
      }
      case 'find_patient': {
        const q = String(input.query || '').trim();
        if (!q) return { matches: [] };
        const safe = q.replace(/[%_,()]/g, ' ').trim();
        let rows;
        if (/^\d{3,8}$/.test(safe)) rows = await sb.from('patients').select('*').ilike('file_number', `%${safe}%`).limit(5).then(must);
        else rows = await sb.from('patients').select('*').ilike('patient_name', `%${safe}%`).limit(5).then(must);
        return { matches: rows.map(p => ({ name: p.patient_name, file_number: trimFile(p.file_number), status: statusOf(p), dose_mg: p.dose_prescribed,
          doses_remaining: p.doses_remaining, due_date: p.due_date, appointment: p.appointment_date_time || null, appointment_confirmed: !!p.appointment_confirmed,
          phone: p.phone1 || null, address: p.address || null })) };
      }
      case 'list_scheduling': return { items: await scheduling(input.list, input.from || '', input.to || '') };
      case 'read_reply': {
        const t = await taskById(input.item_id);
        if (!t) return { error: 'No such item.' };
        if (!t.reply_body) return { error: 'This item has no reply drafted yet.' };
        return { to: `${coordinator(t)} <${t.to_address}>`, cc: t.cc_addresses || [], subject: /^re\s*:/i.test(t.email_subject || '') ? t.email_subject : 'Re: ' + (t.email_subject || ''),
          language: t.lang, text: t.reply_body, ready_to_send: ['reply_ready', 'failed'].includes(t.status) };
      }
      case 'propose_action': return propose(input.action, input.item_id, ctx);
      default: return { error: 'Unknown tool' };
    }
  }

  async function taskById(itemId) {
    if (!String(itemId).startsWith('t:')) return null;
    return sb.from('email_tasks').select('*').eq('id', itemId.slice(2)).maybeSingle().then(must);
  }
  async function pendingById(id) { return sb.from('pending_patients').select('*').eq('id', id).maybeSingle().then(must); }
  async function resolve(itemId) {
    const t = await taskById(itemId);
    if (t) return { t, r: t.pending_id ? await pendingById(t.pending_id) : null };
    if (String(itemId).startsWith('p:')) {
      const r = await pendingById(itemId.slice(2));
      const t2 = r ? (await sb.from('email_tasks').select('*').eq('pending_id', r.id).then(must))[0] || null : null;
      return { t: t2, r };
    }
    return { t: null, r: null };
  }

  // ── Actions: check, describe, and only run after "yes" ──────────────
  async function check(action, itemId) {
    const { t, r } = await resolve(itemId);
    const fileRef = trimFile(t?.file_number || r?.record?.file_number);
    switch (action) {
      case 'send_reply':
        if (!t || !['reply_ready', 'failed'].includes(t.status) || !t.reply_body) return { ok: false, why: 'There is no reply ready to send for that item.' };
        return { ok: true, t, r, describe: `Send the reply to ${coordinator(t)}${(t.cc_addresses || []).length ? ', with ' + t.cc_addresses.join(', ') + ' in copy' : ''}, for file ${fileRef}${t.is_test ? ' (test — it will be saved, not sent)' : ''}.` };
      case 'mark_applied':
        if (!t || t.kind !== 'prescription' || t.status !== 'todo') return { ok: false, why: 'That is not an open prescription.' };
        return { ok: true, t, r, describe: `Mark the prescription for file ${fileRef} as applied and prepare the reply to ${coordinator(t)}.` };
      case 'close_file': {
        if (!t || t.kind !== 'close_file' || t.status !== 'todo') return { ok: false, why: 'That is not an open close-file request.' };
        const e = t.existing_patient;
        if (!e) return { ok: false, why: `File ${fileRef} is not in VaPiq, so there is nothing to close.` };
        if (e.status === 'Archived') return { ok: false, why: `File ${fileRef} is already closed. You can ask me to prepare the reply instead.` };
        return { ok: true, t, r, describe: `Close file ${fileRef} (${e.patient_name}) in VaPiq — it will be archived — and prepare the reply to ${coordinator(t)}${t.is_test ? ' (test card — VaPiq will not change)' : ''}.` };
      }
      case 'ask_for_documents': {
        if (!t || t.kind !== 'new_patient' || !['todo', 'waiting_docs'].includes(t.status)) return { ok: false, why: 'That is not an open new-patient item.' };
        if (unknownDocs(t)) return { ok: false, why: 'A scanned fax still needs to be checked in the app first — tick what it contains.' };
        const missing = docsMissing(t) || [];
        if (!missing.length) return { ok: false, why: 'Both documents are already here.' };
        return { ok: true, t, r, describe: `Prepare a polite request to ${coordinator(t)} for the ${missing.map(k => k + ' form').join(' and ')} for file ${fileRef}. You can then review and send it.` };
      }
      case 'add_patient': {
        if (!r || r.status !== 'pending') return { ok: false, why: 'There is no new-patient form waiting for that item.' };
        const rec = r.record, problems = [];
        if (!rec.patient_name) problems.push('the name');
        if (!trimFile(rec.file_number)) problems.push('the file number');
        if (!DOSES.includes(String(rec.dose_prescribed))) problems.push('the dose');
        if (!rec.due_date) problems.push('the due date');
        if (problems.length) return { ok: false, why: `The form is missing ${problems.join(', ')}. Please check it in the app.` };
        return { ok: true, t, r, describe: `Add ${rec.patient_name}, file ${trimFile(rec.file_number)}, ${rec.dose_prescribed} mg, due ${rec.due_date}, to VaPiq${r.is_test ? ' (test card — VaPiq will not change)' : ''}.` };
      }
      default: return { ok: false, why: 'Unknown action.' };
    }
  }

  async function propose(action, itemId, ctx) {
    const c = await check(action, itemId);
    if (!c.ok) return { proposed: false, reason: c.why };
    const id = 'a' + Math.random().toString(36).slice(2, 10);
    ctx.pending.push({ id, action, item_id: itemId, describe: c.describe, created_at: new Date(now()).toISOString() });
    ctx.proposedNow.push(id);
    return { proposed: true, action_id: id, will_do: c.describe, next: 'Ask the nurse to confirm. It runs only after she or he says yes.' };
  }

  const audit = async (action, fileNum, detail) => {
    const { error } = await sb.from('audit_log').insert({ user_email: userEmail, action, patient_file_num: String(fileNum || ''),
      detail: JSON.stringify({ ...detail, via: 'dubbi' }).slice(0, 500), created_at: new Date(now()).toISOString() });
    if (error) log('[audit] ' + error.message);
  };
  const setTask = async (t, from, status, extra = {}) => {
    const rows = await sb.from('email_tasks').update({ status, decided_at: new Date(now()).toISOString(), decided_by: userEmail, ...extra })
      .eq('id', t.id).in('status', from).select('id').then(must);
    if (!rows.length) throw new Error('This item changed in the meantime — nothing was done.');
  };

  // Runs a confirmed action. Re-checks first; never trusts the earlier check.
  async function execute(p) {
    const c = await check(p.action, p.item_id);
    if (!c.ok) return c.why;
    const { t, r } = c, fn = trimFile(t?.file_number || r?.record?.file_number);
    switch (p.action) {
      case 'send_reply':
        await setTask(t, ['reply_ready', 'failed'], 'send_approved', { error: null });
        await audit('ASSISTANT_REPLY_APPROVED', fn, { task_id: t.id, kind: t.kind, test: t.is_test });
        return t.is_test ? 'Done. It’s a test reply, so it will be saved, not sent.' : 'Done. Your Mac will send it within about two minutes.';
      case 'mark_applied':
        await setTask(t, ['todo'], 'reply_ready', { details: { ...(t.details || {}), reply_mode: 'confirm' } });
        return `Done. The reply to ${coordinator(t)} is ready — say "send it" when you want it to go.`;
      case 'close_file': {
        const e = t.existing_patient;
        if (!t.is_test) {
          const rows = await sb.from('patients').update({ archived: true }).eq('id', e.id).select('id,file_number').then(must);
          if (!rows.length || normFile(rows[0].file_number) !== normFile(e.file_number)) return 'I couldn’t find that patient — please close it in VaPiq.';
          await audit('UPDATE', fn, { id: e.id, source: 'assistant', action: 'close_file', task_id: t.id });
        }
        await setTask(t, ['todo'], 'reply_ready', { details: { ...(t.details || {}), reply_mode: 'confirm' } });
        return `Done. File ${fn} is closed${t.is_test ? ' (test — VaPiq unchanged)' : ''}, and the reply to ${coordinator(t)} is ready.`;
      }
      case 'ask_for_documents':
        await setTask(t, ['todo', 'waiting_docs'], 'reply_ready', { details: { ...(t.details || {}), reply_mode: 'ask_docs' } });
        return 'The request is ready in your list. Say "send it" or review it in the app first.';
      case 'add_patient': {
        const rec = { ...r.record, file_number: trimFile(r.record.file_number) };
        const all = [];
        for (let from = 0; ; from += 1000) {
          const page = await sb.from('patients').select('id,file_number,patient_name,archived,pending').range(from, from + 999).then(must);
          all.push(...page); if (page.length < 1000) break;
        }
        const ex = all.find(p => normFile(p.file_number) === normFile(rec.file_number));
        if (ex) {
          await sb.from('pending_patients').update({ status: 'exists', existing_patient: { file_number: ex.file_number, patient_name: ex.patient_name, status: statusOf(ex) } }).eq('id', r.id);
          return `File ${rec.file_number} already exists in VaPiq as ${ex.patient_name}, so I didn’t add it.`;
        }
        const decided = { decided_at: new Date(now()).toISOString(), decided_by: userEmail };
        if (r.is_test) {
          await sb.from('pending_patients').update({ status: 'approved', ...decided }).eq('id', r.id).eq('status', 'pending').then(must);
          await audit('ASSISTANT_TEST_APPROVED', rec.file_number, { pending_id: r.id });
        } else {
          const row = await sb.from('patients').insert([rec]).select('id').single().then(must);
          await audit('INSERT', rec.file_number, { name: rec.patient_name, source: 'assistant', pending_id: r.id });
          await sb.from('pending_patients').update({ status: 'approved', patient_id: String(row.id), record: rec, ...decided }).eq('id', r.id).eq('status', 'pending').then(must);
        }
        if (t && t.status === 'todo') {
          const missing = docsMissing(t) || [];
          await setTask(t, ['todo'], 'reply_ready', { details: { ...(t.details || {}), reply_mode: missing.length ? 'ask_docs' : 'confirm' } });
        }
        return `Done. ${rec.patient_name} is in VaPiq${r.is_test ? ' (test — nothing written)' : ''}, and the reply to the coordinator is ready.`;
      }
    }
    return 'Nothing was done.';
  }

  // ── Conversations ───────────────────────────────────────────────────
  async function conversation({ conversationId, source }) {
    await sb.from('dubbi_conversations').delete().eq('user_id', userId).lt('updated_at', new Date(now() - 7 * 864e5).toISOString());
    let c = null;
    if (conversationId) c = await sb.from('dubbi_conversations').select('*').eq('id', conversationId).eq('user_id', userId).maybeSingle().then(must);
    else if (source === 'siri') {
      // Siri: continue the conversation from the last 10 minutes ("yes" after a question)
      c = (await sb.from('dubbi_conversations').select('*').eq('user_id', userId).eq('source', 'siri')
        .gte('updated_at', new Date(now() - 10 * 6e4).toISOString()).order('updated_at', { ascending: false }).limit(1).then(must))[0] || null;
    }
    if (!c || (c.messages || []).length > MAX_MESSAGES) {
      c = await sb.from('dubbi_conversations').insert({ user_id: userId, source, messages: [], pending_actions: [] }).select('*').single().then(must);
    }
    return c;
  }
  const save = (c, messages, pending) => sb.from('dubbi_conversations')
    .update({ messages, pending_actions: pending, updated_at: new Date(now()).toISOString() }).eq('id', c.id).then(must);

  function textOf(content) {
    return content.filter(b => b.type === 'text').map(b => b.text).join(' ').replace(/\s+/g, ' ').trim();
  }

  // Main entry: { text } to talk, { execute: action_id } / { cancel: action_id } for buttons.
  async function handle({ text = '', execute: execId = null, cancel: cancelId = null, conversationId = null, source = 'app' }) {
    const c = await conversation({ conversationId, source });
    const messages = c.messages || [];
    let pending = (c.pending_actions || []).filter(p => hoursSince(p.created_at, now()) < 1);
    const said = String(text || '').trim();
    const fr = FR.test(said);

    // Confirmations never go through the AI: code runs exactly what was proposed.
    const pick = execId ? pending.find(p => p.id === execId) : (YES.test(said) && pending.length === 1 ? pending[0] : null);
    if (pick) {
      let result;
      try { result = await execute(pick); } catch (e) { result = 'That didn’t work: ' + e.message; }
      pending = pending.filter(p => p.id !== pick.id);
      messages.push({ role: 'user', content: said || `Yes, do it: ${pick.describe}` }, { role: 'assistant', content: [{ type: 'text', text: result }] });
      await save(c, messages, pending);
      return { conversation_id: c.id, reply: result, proposals: pending, executed: pick.id };
    }
    const drop = cancelId ? pending.find(p => p.id === cancelId) : (NO.test(said) && pending.length ? pending[pending.length - 1] : null);
    if (drop) {
      pending = pending.filter(p => p.id !== drop.id);
      const reply = fr ? 'D’accord, je n’ai rien fait.' : 'Okay, I didn’t do it.';
      messages.push({ role: 'user', content: said || `Cancel: ${drop.describe}` }, { role: 'assistant', content: [{ type: 'text', text: reply }] });
      await save(c, messages, pending);
      return { conversation_id: c.id, reply, proposals: pending, cancelled: drop.id };
    }
    if (!said) return { conversation_id: c.id, reply: fr ? 'Je vous écoute.' : 'I’m listening.', proposals: pending };

    messages.push({ role: 'user', content: `[${montrealNow(now())}] ${said}` });
    const ctx = { pending, proposedNow: [] };
    let reply = '';
    for (let turn = 0; turn < 8; turn++) {
      const resp = await anthropic.beta.messages.create({
        model: MODEL, max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        output_config: { effort: 'low' },
        system: SYSTEM, tools: TOOLS, messages,
      });
      messages.push({ role: 'assistant', content: resp.content });
      if (resp.stop_reason === 'refusal') { reply = fr ? 'Désolé, je ne peux pas aider avec ça.' : 'Sorry, I can’t help with that one.'; break; }
      if (resp.stop_reason === 'pause_turn') continue;
      const uses = resp.content.filter(b => b.type === 'tool_use');
      if (resp.stop_reason !== 'tool_use' || !uses.length) { reply = textOf(resp.content); break; }
      const results = [];
      for (const u of uses) {
        let out;
        try { out = await runTool(u.name, u.input || {}, ctx); }
        catch (e) { out = { error: e.message }; }
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out), ...(out && out.error ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
    if (!reply) reply = fr ? 'Je n’ai pas pu terminer — réessayez.' : 'I couldn’t finish that — please try again.';
    await save(c, messages, ctx.pending);
    return { conversation_id: c.id, reply, proposals: ctx.pending };
  }

  return { handle, runTool, execute, items, TOOLS };
}
