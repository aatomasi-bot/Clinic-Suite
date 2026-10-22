// Dubbi's brain (supabase/functions/dubbi/core.js) with an in-memory
// database and a scripted stand-in for Claude — no network, no API cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDubbi, TOOLS } from '../../supabase/functions/dubbi/core.js';

// ── A tiny in-memory Supabase: just the query methods core.js uses ──────
function memDb(tables) {
  const db = JSON.parse(JSON.stringify(tables));
  let n = 0;
  return {
    db,
    from(table) {
      const st = { op: 'select', f: [], vals: null, ret: false, one: false, maybe: false, order: null, limit: null, range: null };
      const rows = () => (db[table] = db[table] || []);
      const run = () => {
        const hit = rows().filter(r => st.f.every(fn => fn(r)));
        let data = null;
        if (st.op === 'select') {
          let out = hit.slice();
          if (st.order) out.sort((a, b) => String(a[st.order.col]).localeCompare(String(b[st.order.col])) * (st.order.asc ? 1 : -1));
          if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
          if (st.limit != null) out = out.slice(0, st.limit);
          data = st.one || st.maybe ? (out[0] ?? null) : out;
          if (st.one && !data) return { data: null, error: { message: 'no rows' } };
        } else if (st.op === 'update') {
          hit.forEach(r => Object.assign(r, JSON.parse(JSON.stringify(st.vals))));
          data = st.ret ? (st.one ? hit[0] : hit.slice()) : null;
        } else if (st.op === 'insert') {
          const add = (Array.isArray(st.vals) ? st.vals : [st.vals]).map(v => ({ id: `${table}-${++n}`, created_at: new Date().toISOString(), ...JSON.parse(JSON.stringify(v)) }));
          rows().push(...add);
          data = st.one ? add[0] : add;
        } else if (st.op === 'delete') {
          db[table] = rows().filter(r => !hit.includes(r));
        }
        return { data, error: null };
      };
      const b = {
        select() { if (st.op !== 'select') st.ret = true; return b; },
        insert(v) { st.op = 'insert'; st.vals = v; return b; },
        update(v) { st.op = 'update'; st.vals = v; return b; },
        delete() { st.op = 'delete'; return b; },
        eq(c, v) { st.f.push(r => String(r[c]) === String(v)); return b; },
        in(c, vs) { st.f.push(r => vs.map(String).includes(String(r[c]))); return b; },
        is(c, v) { st.f.push(r => (r[c] ?? null) === v); return b; },
        gte(c, v) { st.f.push(r => r[c] != null && String(r[c]) >= String(v)); return b; },
        lte(c, v) { st.f.push(r => r[c] != null && String(r[c]) <= String(v)); return b; },
        lt(c, v) { st.f.push(r => r[c] != null && String(r[c]) < String(v)); return b; },
        ilike(c, p) { const re = new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i'); st.f.push(r => re.test(String(r[c] ?? ''))); return b; },
        order(col, o = {}) { st.order = { col, asc: o.ascending !== false }; return b; },
        limit(k) { st.limit = k; return b; },
        range(a, z) { st.range = [a, z]; return b; },
        single() { st.one = true; return b; },
        maybeSingle() { st.maybe = true; return b; },
        then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
      };
      return b;
    },
  };
}

// Scripted Claude: each call returns the next step; records what it was sent.
function scriptedClaude(steps) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (req) => {
      calls.push(JSON.parse(JSON.stringify(req)));
      const step = steps.shift();
      if (!step) throw new Error('no more scripted steps');
      return typeof step === 'function' ? step(req) : step;
    } } },
  };
}
const toolCall = (name, input, id = 'tu_' + name) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const say = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const lastToolResult = req => JSON.parse(req.messages.at(-1).content[0].content);

const NOW = Date.parse('2026-10-22T15:00:00Z');
const hAgo = h => new Date(NOW - h * 36e5).toISOString();
function fixture() {
  return {
    patients: [
      { id: 1, file_number: '98004', patient_name: 'Closing Testcase', archived: false, pending: false, dose_prescribed: '7.5', doses_remaining: '3', due_date: '2026-10-25', appointment_date_time: null },
      { id: 2, file_number: '98005', patient_name: 'Real Closer', archived: false, pending: false, dose_prescribed: '22.5', doses_remaining: '1', due_date: '2026-11-30', appointment_date_time: '2026-10-22T10:00', appointment_confirmed: true },
    ],
    pending_patients: [
      { id: 'p1', status: 'pending', is_test: false, created_at: hAgo(2), record: { patient_name: 'Nina Cocher', file_number: '99010', dose_prescribed: '22.5', due_date: '2026-11-15', address: '1 Rue', phone1: '555' } },
      { id: 'p2', status: 'pending', is_test: false, created_at: hAgo(30), record: { patient_name: 'No Dose', file_number: '99020', dose_prescribed: '', due_date: '2026-11-15' } },
    ],
    email_tasks: [
      { id: 'c1', kind: 'close_file', status: 'todo', is_test: true, created_at: hAgo(3), file_number: '98004', to_address: 'julie@medicum.ca', to_name: 'Julie', email_subject: 'Close file 98004',
        existing_patient: { id: 1, file_number: '98004', patient_name: 'Closing Testcase', status: 'Active' }, reply_body: 'Hello Julie,\n\nI have closed the file #98004.' },
      { id: 'c2', kind: 'close_file', status: 'todo', is_test: false, created_at: hAgo(3), file_number: '98005', to_address: 'julie@medicum.ca', to_name: 'Julie', email_subject: 'Close file 98005',
        existing_patient: { id: 2, file_number: '98005', patient_name: 'Real Closer', status: 'Active' }, reply_body: 'Hello Julie,\n\nI have closed the file #98005.' },
      { id: 'n1', kind: 'new_patient', status: 'todo', is_test: false, created_at: hAgo(2), pending_id: 'p1', file_number: '99010', to_address: 'giulia@medicum.ca', to_name: 'Giulia',
        cc_addresses: ['reports@medicum.ca'], documents: { assignment: true, enrollment: false, files: [] }, reply_body: '...did not receive the enrollment form...' },
      { id: 'r1', kind: 'prescription', status: 'reply_ready', is_test: false, created_at: hAgo(60), decided_at: hAgo(50), file_number: '30001', to_address: 'julie@medicum.ca', to_name: 'Julie', reply_body: 'Hello Julie' },
    ],
    assistant_log: [{ id: '00000000-0000-0000-0000-00000000beef', created_at: new Date(NOW - 3 * 6e4).toISOString(), summary: { mode: 'test' } }],
    audit_log: [], dubbi_conversations: [],
  };
}
const make = (sb, claude) => createDubbi({ sb, anthropic: claude, userId: 'u1', userEmail: 'nurse@example.test', now: () => NOW });

test('tools are strict and cannot change data on their own', () => {
  for (const t of TOOLS) {
    assert.equal(t.strict, true, t.name);
    assert.equal(t.input_schema.additionalProperties, false, t.name);
  }
  assert.ok(!TOOLS.some(t => /^(send|close|add|archive|delete|update)/.test(t.name)), 'only read tools + propose_action');
});

test('overview: counts, overdue and Mac health', async () => {
  const sb = memDb(fixture());
  const d = make(sb, scriptedClaude([]));
  const o = await d.runTool('get_overview', {}, { pending: [], proposedNow: [] });
  assert.equal(o.files_to_close, 2);
  assert.equal(o.new_patients_to_add, 2);
  assert.equal(o.replies_to_send, 1);
  assert.equal(o.overdue, 2, 'reply waiting 50 h + new patient 30 h');
  assert.equal(o.mac_last_checked_minutes_ago, 3);
  assert.equal(o.patients_to_schedule, 1);
  assert.equal(o.visits_today, 1);
});

test('"close file 98005": AI proposes, nothing changes until "yes"; then code archives + readies the reply', async () => {
  const sb = memDb(fixture());
  const claude = scriptedClaude([
    toolCall('list_open_items', { kind: 'close_file' }),
    req => { const items = lastToolResult(req).items; const it = items.find(i => i.file_number === '98005'); return toolCall('propose_action', { action: 'close_file', item_id: it.item_id }); },
    req => { assert.equal(lastToolResult(req).proposed, true); return say('Shall I close file 98005 for Real Closer and prepare the reply to Julie?'); },
  ]);
  const d = make(sb, claude);
  const r1 = await d.handle({ text: 'Close file 98005' });
  assert.match(r1.reply, /Shall I close/);
  assert.equal(r1.proposals.length, 1);
  assert.equal(sb.db.patients.find(p => p.id === 2).archived, false, 'not archived before confirmation');
  assert.equal(sb.db.email_tasks.find(t => t.id === 'c2').status, 'todo');
  // request sent to Claude: right model, low effort, fallbacks on
  assert.equal(claude.calls[0].model, 'claude-opus-5-5');
  assert.equal(claude.calls[0].output_config.effort, 'low');
  assert.equal(claude.calls[0].fallbacks, 'default');

  const r2 = await d.handle({ text: 'yes', conversationId: r1.conversation_id });
  assert.equal(claude.calls.length, 3, '"yes" never goes to the AI');
  assert.match(r2.reply, /File 98005 is closed/);
  assert.equal(sb.db.patients.find(p => p.id === 2).archived, true);
  assert.equal(sb.db.email_tasks.find(t => t.id === 'c2').status, 'reply_ready');
  assert.equal(sb.db.audit_log.at(-1).action, 'UPDATE');
  assert.match(sb.db.audit_log.at(-1).detail, /"via":"dubbi"/);
});

test('TEST cards never change VaPiq, even when confirmed', async () => {
  const sb = memDb(fixture());
  const d = make(sb, scriptedClaude([toolCall('propose_action', { action: 'close_file', item_id: 't:c1' }), say('Confirm?')]));
  const r1 = await d.handle({ text: 'close file 98004' });
  const r2 = await d.handle({ execute: r1.proposals[0].id, conversationId: r1.conversation_id });
  assert.match(r2.reply, /test/);
  assert.equal(sb.db.patients.find(p => p.id === 1).archived, false);
  assert.equal(sb.db.email_tasks.find(t => t.id === 'c1').status, 'reply_ready');
});

test('"no" cancels; a proposal that is no longer valid is re-checked and refused', async () => {
  const sb = memDb(fixture());
  const d = make(sb, scriptedClaude([toolCall('propose_action', { action: 'send_reply', item_id: 't:r1' }), say('Send it?')]));
  const r1 = await d.handle({ text: 'send the reply to Julie' });
  const r2 = await d.handle({ text: 'non', conversationId: r1.conversation_id });
  assert.match(r2.reply, /rien fait/);
  assert.equal(sb.db.email_tasks.find(t => t.id === 'r1').status, 'reply_ready');

  const d2 = make(sb, scriptedClaude([toolCall('propose_action', { action: 'send_reply', item_id: 't:r1' }), say('Send it?')]));
  const r3 = await d2.handle({ text: 'send it' });
  sb.db.email_tasks.find(t => t.id === 'r1').status = 'sent';            // sent from the app meanwhile
  const r4 = await d2.handle({ text: 'yes', conversationId: r3.conversation_id });
  assert.match(r4.reply, /no reply ready/i);
});

test('send_reply after yes → send_approved (the Mac sends it)', async () => {
  const sb = memDb(fixture());
  const d = make(sb, scriptedClaude([toolCall('propose_action', { action: 'send_reply', item_id: 't:r1' }), say('Send the reply to Julie?')]));
  const r1 = await d.handle({ text: 'send the prescription reply' });
  const r2 = await d.handle({ text: 'Yes!', conversationId: r1.conversation_id });
  assert.match(r2.reply, /Mac will send it/);
  assert.equal(sb.db.email_tasks.find(t => t.id === 'r1').status, 'send_approved');
});

test('add_patient: refused when the form is incomplete; adds + readies the documents request when complete', async () => {
  const sb = memDb(fixture());
  const d = make(sb, scriptedClaude([toolCall('propose_action', { action: 'add_patient', item_id: 'p:p2' }), say('The dose is missing.')]));
  const r = await d.handle({ text: 'add patient 99020' });
  assert.equal(r.proposals.length, 0);
  assert.equal(d.items({ pending: sb.db.pending_patients, tasks: sb.db.email_tasks }).length > 0, true);

  const d2 = make(sb, scriptedClaude([toolCall('propose_action', { action: 'add_patient', item_id: 't:n1' }), say('Add Nina Cocher?')]));
  const r1 = await d2.handle({ text: 'add Nina' });
  await d2.handle({ text: 'oui', conversationId: r1.conversation_id });
  assert.ok(sb.db.patients.some(p => p.file_number === '99010' && p.patient_name === 'Nina Cocher'));
  assert.equal(sb.db.pending_patients.find(p => p.id === 'p1').status, 'approved');
  const t = sb.db.email_tasks.find(x => x.id === 'n1');
  assert.equal(t.status, 'reply_ready');
  assert.equal(t.details.reply_mode, 'ask_docs', 'enrollment form missing → the reply asks for it');
});

test('find_patient + conversation is append-only', async () => {
  const sb = memDb(fixture());
  const claude = scriptedClaude([toolCall('find_patient', { query: '98005' }), req => say(`Found ${lastToolResult(req).matches[0].name}.`), toolCall('get_overview', {}), say('All good.')]);
  const d = make(sb, claude);
  const r1 = await d.handle({ text: 'who is file 98005?' });
  assert.equal(r1.reply, 'Found Real Closer.');
  const before = JSON.stringify(sb.db.dubbi_conversations[0].messages);
  await d.handle({ text: "what's new?", conversationId: r1.conversation_id });
  const after = sb.db.dubbi_conversations[0].messages;
  assert.equal(JSON.stringify(after.slice(0, JSON.parse(before).length)), before, 'earlier turns untouched');
  assert.equal(claude.calls[2].messages.length, JSON.parse(before).length + 1);
});
