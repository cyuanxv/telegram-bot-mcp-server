// Independent PostgreSQL review; embedded PGlite and synthetic transports only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { AsyncReportQueue } from '../lib/telegram/delivery/async-queue.ts';
import { PostgresQueueStore } from '../lib/telegram/delivery/postgres-store.ts';
import { PgPoolDatabase } from '../lib/telegram/delivery/pg-pool-adapter.ts';
import { draftJob, DELIVERY_LEASE_MS } from '../lib/telegram/delivery/state.ts';

const migration = readFileSync(new URL('../migrations/001_delivery_reports.sql', import.meta.url), 'utf8');
const input = { idempotencyKey: 'independent:pg', botAlias: 'reports', chatId: '-10012345', text: 'one' };
const wrap = pg => ({ transaction: fn => pg.transaction(tx => fn({ query: (sql, args) => tx.query(sql, args) })) });
async function setup(t) {
  const pg = new PGlite(); await pg.exec(migration); t.after(() => pg.close()); return pg;
}

test('lost claim COMMIT acknowledgement never invokes transport or makes resend eligible', async t => {
  const pg = await setup(t); let fault = false; let releases = [];
  const db = new PgPoolDatabase({ connect: async () => ({ query: async (sql, args) => {
    const result = { ...(await pg.query(sql, args)), ...(sql === 'COMMIT' ? { command: 'COMMIT' } : {}) };
    if (fault && sql === 'COMMIT') { fault = false; throw new Error('sensitive provider error'); }
    return result;
  }, release: destroy => releases.push(destroy) }) });
  let now = 1000000; const q = new AsyncReportQueue(new PostgresQueueStore(db), () => now);
  const d = await q.draft(input); await q.enqueue(d.id, d.fingerprint);
  let sends = 0; const send = { send: async r => { sends++; return { chatId: r.chatId, messageId: 1 }; } };
  fault = true;
  await assert.rejects(q.dispatchNext(d.id, d.fingerprint, send), e => e.message === 'Delivery database operation failed');
  assert.equal(sends, 0); assert.equal((await q.get(d.id)).state, 'sending');
  now += DELIVERY_LEASE_MS;
  assert.equal((await q.recoverStale(d.id)).state, 'unknown');
  await assert.rejects(q.dispatchNext(d.id, d.fingerprint, send), /unknown/);
  assert.equal(sends, 0);
});

test('failed settlement rolls back to sending and stale recovery prevents a second transport', async t => {
  const pg = await setup(t); let failUpdate = false; let now = 1000000;
  const base = wrap(pg); const db = { transaction: fn => base.transaction(sql => fn({ query: (query, args) => {
    if (failUpdate && query.startsWith('UPDATE ')) { failUpdate = false; throw new Error('synthetic settlement failure'); }
    return sql.query(query, args);
  } })) };
  const q = new AsyncReportQueue(new PostgresQueueStore(db), () => now);
  const d = await q.draft(input); await q.enqueue(d.id, d.fingerprint); let sends = 0;
  const send = { send: async r => { sends++; failUpdate = true; return { chatId: r.chatId, messageId: 1 }; } };
  await assert.rejects(q.dispatchNext(d.id, d.fingerprint, send), /settlement failure/);
  assert.equal(sends, 1); assert.equal((await q.get(d.id)).state, 'sending');
  now += DELIVERY_LEASE_MS; assert.equal((await q.recoverStale(d.id)).state, 'unknown');
  await assert.rejects(q.dispatchNext(d.id, d.fingerprint, send), /unknown/); assert.equal(sends, 1);
});

test('async update callbacks roll back all mutations before any write', async t => {
  const pg = await setup(t), store = new PostgresQueueStore(wrap(pg));
  const d = await store.create(draftJob(input, () => 1000000));
  await assert.rejects(store.update(d.id, async job => { job.updatedAt = 2000000; return job; }));
  assert.equal((await store.get(d.id)).updatedAt, 1000000);
});

test('regression: migration must reject absent or JSON-null document identity', async t => {
  const pg = await setup(t);
  await assert.rejects(pg.query('INSERT INTO public.telegram_delivery_reports(id,idempotency_key,document) VALUES($1,$2,$3::jsonb)', ['outer-id', 'outer-key', JSON.stringify({ id: null, idempotencyKey: null })]));
});

test('regression: create must not persist mutation of caller-owned input while awaiting its transaction', async t => {
  const pg = await setup(t); const base = wrap(pg); let release;
  const gate = new Promise(resolve => release = resolve);
  const store = new PostgresQueueStore({ transaction: async fn => { await gate; return base.transaction(fn); } });
  const draft = draftJob(input, () => 1000000); const originalId = draft.id;
  const pending = store.create(draft);
  draft.chunks = [];
  release();
  await pending;
  const persisted = await pg.query('SELECT document FROM public.telegram_delivery_reports WHERE id=$1', [originalId]);
  assert.equal(persisted.rows[0].document.chunks.length, 1);
});

test('regression: pg adapter must not report success after a swallowed SQL error aborts the transaction', async t => {
  const pg = await setup(t); const db = new PgPoolDatabase({ connect: async () => ({ query: async (sql, args) => ({ ...(await pg.query(sql, args)), ...(sql === 'COMMIT' ? { command: 'COMMIT' } : {}) }), release() {} }) });
  await assert.rejects(db.transaction(async sql => {
    await sql.query('INSERT INTO public.telegram_delivery_reports(id,idempotency_key,document) VALUES($1,$2,$3::jsonb)', ['example', 'example', JSON.stringify({ id: 'example', idempotencyKey: 'example' })]);
    try { await sql.query('SELECT 1/0'); } catch { /* caller handles operation error */ }
    return 'reported success';
  }));
});

for (const command of ['ROLLBACK', undefined]) {
  test(`regression: pg adapter rejects unproven COMMIT result (${command})`, async () => {
    let released; const db = new PgPoolDatabase({ connect: async () => ({
      query: async sql => ({ rows: [], ...(sql === 'COMMIT' ? { command } : {}) }),
      release: destroy => released = destroy,
    }) });
    await assert.rejects(db.transaction(async () => 'uncommitted result'));
    assert.equal(typeof released, 'boolean');
  });
}

test('lost settlement COMMIT acknowledgement preserves the committed receipt and blocks repeat dispatch', async t => {
  const pg = await setup(t); let fault = false;
  const db = new PgPoolDatabase({ connect: async () => ({ query: async (sql, args) => {
    const result = { ...(await pg.query(sql, args)), ...(sql === 'COMMIT' ? { command: 'COMMIT' } : {}) };
    if (fault && sql === 'COMMIT') { fault = false; throw new Error('sensitive provider error'); }
    return result;
  }, release() {} }) });
  const q = new AsyncReportQueue(new PostgresQueueStore(db), () => 1000000);
  const d = await q.draft(input); await q.enqueue(d.id, d.fingerprint); let sends = 0;
  const send = { send: async r => { sends++; fault = true; return { chatId: r.chatId, messageId: 123 }; } };
  await assert.rejects(q.dispatchNext(d.id, d.fingerprint, send), e => e.message === 'Delivery database operation failed');
  const persisted = await q.get(d.id);
  assert.equal(persisted.state, 'delivered'); assert.equal(persisted.chunks[0].receipt.messageId, 123);
  await assert.rejects(q.dispatchNext(d.id, d.fingerprint, send), /delivered/);
  assert.equal(sends, 1);
});
