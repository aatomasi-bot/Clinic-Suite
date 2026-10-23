// VaPiq (index.html) invoice sync: two devices editing the same month.
// Runs the real invoice code from index.html against an in-memory "Supabase".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const cut = (from, to) => { const a = html.indexOf(from), b = html.indexOf(to, a); assert.ok(a > 0 && b > a, 'code not found: ' + from); return html.slice(a, b); };
const CODE = cut('function loadInvoiceData(key)', '// Load ALL invoice records from Supabase into cache')
  + cut('// ── Invoice changes (cross-device safe)', '\nfunction autoInvoiceNumber');

// One shared database; `beforeSelect` lets a test squeeze in the other device's save.
function database() {
  const db = { rows: [], beforeSelect: null, offline: false, n: 0 };
  db.client = {
    from() {
      const st = { op: 'select', eq: [], vals: null };
      const hit = () => db.rows.filter(r => st.eq.every(([k, v]) => String(r[k]) === String(v)));
      const run = async () => {
        if (db.offline) throw new Error('offline');
        if (st.op === 'select') { if (db.beforeSelect) { const f = db.beforeSelect; db.beforeSelect = null; await f(); } return { data: hit()[0] || null, error: null }; }
        if (st.op === 'update') { const h = hit(); h.forEach(r => Object.assign(r, structuredClone(st.vals))); return { data: h.map(r => ({ id: r.id })), error: null }; }
        if (db.rows.some(r => r.month_key === st.vals.month_key)) return { data: null, error: { message: 'duplicate key' } };
        const row = { id: ++db.n, ...structuredClone(st.vals), updated_at: st.vals.updated_at + '#' + db.n };
        db.rows.push(row); return { data: [{ id: row.id }], error: null };
      };
      const b = {
        select() { return b; }, eq(k, v) { st.eq.push([k, v]); return b; },
        update(v) { st.op = 'update'; st.vals = { ...v, updated_at: v.updated_at + '#' + (++db.n) }; return b; },
        insert(v) { st.op = 'insert'; st.vals = v; return b; },
        maybeSingle() { return run(); }, then(res, rej) { return run().then(res, rej); },
      };
      return b;
    },
  };
  return db;
}

function device(db) {
  const store = {};
  const ctx = vm.createContext({
    _sb: db.client, _invoiceCache: {}, currentView: 'patients', console, JSON, Date, Math, Set, Object, Error,
    toast() {}, renderInvoiceView() {}, autoInvoiceNumber: () => '010-2026',
    _lsGet: (k, fb) => JSON.parse(store[k] || fb),
    localStorage: { setItem: (k, v) => { store[k] = String(v); }, getItem: k => store[k] ?? null },
  });
  vm.runInContext(CODE, ctx);
  ctx.reload = () => { ctx._invoiceCache = {}; for (const r of db.rows) ctx._invoiceCache[r.month_key] = vm.runInContext('_invoiceFromRow', ctx)(structuredClone(r)); vm.runInContext('_invOps', ctx)().forEach(o => ctx._applyInvoiceOp(ctx.loadInvoiceData(o.key), o.op)); };
  ctx.waiting = () => vm.runInContext('_invOps', ctx)().length;
  return ctx;
}
const K = 'invoice_2026_10';
const day = (date, ...files) => ({ date, raw_km: 50, net_km: 30, raw_time: 120, net_time: 90, patients: files.map(f => ({ file: f, initials: 'XX', cpp: false })) });
const dates = db => db.rows.find(r => r.month_key === K).days.map(d => d.date);

test('a device with an old copy no longer erases the other device\'s visit', async () => {
  const db = database();
  const imac = device(db), iphone = device(db);
  imac.changeInvoice(K, { type: 'setDay', day: day('2026-10-01', '1') }); await imac._flushInvoiceOps();
  imac.reload(); iphone.reload();                                    // both open October
  imac.changeInvoice(K, { type: 'setDay', day: day('2026-10-02', '2') }); await imac._flushInvoiceOps();
  iphone.changeInvoice(K, { type: 'setDay', day: day('2026-10-03', '3') }); await iphone._flushInvoiceOps();   // iPhone never saw Oct 2
  assert.deepEqual(dates(db), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.deepEqual(Array.from(iphone._invoiceCache[K].days, d => d.date), ['2026-10-01', '2026-10-02', '2026-10-03'], 'iPhone now shows the iMac visit too');
});

test('both devices saving at the same moment: the later one merges instead of overwriting', async () => {
  const db = database();
  const imac = device(db), iphone = device(db);
  imac.changeInvoice(K, { type: 'setDay', day: day('2026-10-01', '1') }); await imac._flushInvoiceOps();
  // iMac reads the month, then the iPhone saves before the iMac writes
  let once = true;
  db.beforeSelect = async () => { if (!once) return; once = false; iphone.changeInvoice(K, { type: 'setDay', day: day('2026-10-05', '5') }); await iphone._flushInvoiceOps(); };
  imac.changeInvoice(K, { type: 'setDay', day: day('2026-10-04', '4') }); await imac._flushInvoiceOps();
  assert.deepEqual(dates(db), ['2026-10-01', '2026-10-04', '2026-10-05']);
});

test('remove a day / CPP / ignore / invoice number are applied by date and file, not by position', async () => {
  const db = database();
  const imac = device(db), iphone = device(db);
  imac.changeInvoice(K, { type: 'setDay', day: day('2026-10-01', '1', '9') }); imac.changeInvoice(K, { type: 'setDay', day: day('2026-10-02', '2') });
  await imac._flushInvoiceOps(); iphone.reload();
  imac.changeInvoice(K, { type: 'setDay', day: day('2026-09-30', '0') }); await imac._flushInvoiceOps();   // shifts positions on the iMac
  iphone.changeInvoice(K, { type: 'removeDay', date: '2026-10-02' });
  iphone.changeInvoice(K, { type: 'setCpp', date: '2026-10-01', file: '9', cpp: true });
  iphone.changeInvoice(K, { type: 'ignore', dates: ['2026-10-07'] });
  iphone.changeInvoice(K, { type: 'number', value: '011-2026' });
  await iphone._flushInvoiceOps();
  const row = db.rows[0];
  assert.deepEqual(row.days.map(d => d.date), ['2026-09-30', '2026-10-01']);
  assert.equal(row.days[1].patients.find(p => p.file === '9').cpp, true);
  assert.deepEqual(row.ignored_dates, ['2026-10-07']);
  assert.equal(row.invoice_number, '011-2026');
});

test('offline: the change waits on the device, stays on screen after a reload, and syncs later', async () => {
  const db = database();
  const iphone = device(db);
  db.offline = true;
  iphone.changeInvoice(K, { type: 'setDay', day: day('2026-10-06', '6') }); await iphone._flushInvoiceOps();
  assert.equal(iphone.waiting(), 1);
  assert.equal(db.rows.length, 0);
  iphone.reload();
  assert.deepEqual(Array.from(iphone._invoiceCache[K].days, d => d.date), ['2026-10-06'], 'still visible after reload');
  db.offline = false;
  await iphone._flushInvoiceOps();
  assert.equal(iphone.waiting(), 0);
  assert.deepEqual(dates(db), ['2026-10-06']);
});
