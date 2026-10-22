import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { AsyncReportQueue } from '../lib/telegram/delivery/async-queue.ts';
import { PostgresQueueStore } from '../lib/telegram/delivery/postgres-store.ts';
import { PgPoolDatabase } from '../lib/telegram/delivery/pg-pool-adapter.ts';
import { DefiniteRejection } from '../lib/telegram/delivery/types.ts';
import { DELIVERY_LEASE_MS } from '../lib/telegram/delivery/state.ts';

const migration = readFileSync(new URL('../migrations/001_delivery_reports.sql', import.meta.url), 'utf8');
const draft = { idempotencyKey: 'postgres:daily', botAlias: 'reports', chatId: '-10012345', text: 'abcdef', maxChunkLength: 3 };
function wrap(pg) { return { transaction: fn => pg.transaction(tx => fn({ query: (sql, values) => tx.query(sql, values) })) }; }
async function setup(t, file) {
  const pg = new PGlite(file); await pg.exec(migration); t.after(() => pg.close());
  const store = new PostgresQueueStore(wrap(pg)); let now = 1000000;
  const queue = new AsyncReportQueue(store, () => now);
  return { pg, store, queue, tick: n => now += n };
}
async function queued(s) { const d = await s.queue.draft(draft); await s.queue.enqueue(d.id, d.fingerprint); return d; }
const success = { send: async r => ({ chatId: r.chatId, messageId: r.text === 'abc' ? 1 : 2 }) };

test('real embedded PostgreSQL persists drafts, enforces key conflicts, and completes sequential dispatch', async t => {
  const s = await setup(t), d = await queued(s);
  assert.equal((await s.queue.draft(draft)).id, d.id);
  await assert.rejects(s.queue.draft({ ...draft, chatId: '-100999' }), /Idempotency/);
  assert.equal((await s.queue.dispatchNext(d.id, d.fingerprint, success)).state, 'queued');
  assert.equal((await s.queue.dispatchNext(d.id, d.fingerprint, success)).state, 'delivered');
  await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, success), /delivered/);
});
test('PostgreSQL concurrent async dispatch calls claim once and never hold transaction across send', async t => {
  const s = await setup(t), d = await queued(s); let calls = 0, finish, started;
  const began = new Promise(resolve => started = resolve);
  const first = s.queue.dispatchNext(d.id, d.fingerprint, { send: r => { calls++; started(); return new Promise(resolve => finish = () => resolve({ chatId: r.chatId, messageId: 1 })); } });
  await began;
  // This read must finish while transport is paused; its transaction is not held by the sender.
  assert.equal((await s.queue.get(d.id)).state, 'sending');
  await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, success), /sending/);
  finish(); await first; assert.equal(calls, 1);
});
test('PostgreSQL rollback keeps previous state when callback throws or mutates identity', async t => {
  const s = await setup(t), d = await queued(s);
  await assert.rejects(s.store.update(d.id, job => { job.chatId = '-100777'; throw new Error('rollback'); }));
  assert.equal((await s.queue.get(d.id)).chatId, draft.chatId);
  await assert.rejects(s.store.update(d.id, job => { job.id = 'other'; }), /identity/);
  assert.equal((await s.queue.get(d.id)).id, d.id);
});
test('PostgreSQL unknown outcome never becomes retryable; exact external receipt can resume next chunk', async t => {
  const s = await setup(t), d = await queued(s);
  const result = await s.queue.dispatchNext(d.id, d.fingerprint, { send: async () => { throw new Error('provider-secret'); } });
  assert.equal(result.state, 'unknown'); assert.ok(!JSON.stringify(result).includes('provider-secret'));
  await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, success), /unknown/);
  assert.equal((await s.queue.confirmUnknownDelivery(d.id, d.fingerprint, { chunkIndex: 1, attemptId: result.chunks[0].attemptId, receipt: { chatId: d.chatId, messageId: 1 }, evidenceReference: 'verified-test-message-1' })).state, 'queued');
  assert.equal((await s.queue.dispatchNext(d.id, d.fingerprint, success)).state, 'delivered');
});
test('PostgreSQL queue respects persisted retry delay and retry budget', async t => {
  const s = await setup(t), d = await queued(s);
  const limited = { send: async () => { throw new DefiniteRejection('rate_limited', 900); } };
  const result = await s.queue.dispatchNext(d.id, d.fingerprint, limited); assert.equal(result.chunks[0].retryAt, 1900000);
  await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, success), /delay/);
  s.tick(900000); await s.queue.dispatchNext(d.id, d.fingerprint, limited);
  s.tick(900000); assert.equal((await s.queue.dispatchNext(d.id, d.fingerprint, limited)).state, 'rejected');
});
test('PostgreSQL reopen preserves in-flight claim and recovery blocks a resend', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-pg-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let pg = new PGlite(dir); await pg.exec(migration); let queue = new AsyncReportQueue(new PostgresQueueStore(wrap(pg)), () => 1000000);
  const d = await queue.draft(draft); await queue.enqueue(d.id, d.fingerprint);
  let started; const began = new Promise(resolve => started = resolve);
  void queue.dispatchNext(d.id, d.fingerprint, { send: () => { started(); return new Promise(() => {}); } });
  await began; await pg.close(); pg = new PGlite(dir); t.after(() => pg.close());
  queue = new AsyncReportQueue(new PostgresQueueStore(wrap(pg)), () => 1000000 + DELIVERY_LEASE_MS);
  assert.equal((await queue.get(d.id)).state, 'sending'); assert.equal((await queue.recoverStale(d.id)).state, 'unknown');
  await assert.rejects(queue.dispatchNext(d.id, d.fingerprint, success), /unknown/);
});
test('PostgreSQL schema rejects document/storage identity disagreement', async t => {
  const s = await setup(t), d = await queued(s);
  await assert.rejects(s.pg.query('UPDATE public.telegram_delivery_reports SET document = jsonb_set(document, \'{id}\', \'"other"\') WHERE id=$1', [d.id]));
  assert.equal((await s.queue.get(d.id)).id, d.id);
});
test('async configuration preflight leaves zero attempts and queued state', async t => {
  const s = await setup(t), d = await queued(s); let sends = 0;
  await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, { validateConfiguration() { throw new Error('configuration missing'); }, send: async r => { sends++; return success.send(r); } }), /configuration/);
  assert.equal((await s.queue.get(d.id)).chunks[0].attempts, 0); assert.equal(sends, 0);
});
test('pg Pool adapter pins transaction to one connection, sets bounded timeouts and sanitizes provider failures', async () => {
  const log = []; let released;
  const pool = { connect: async () => ({ query: async (sql, values) => { log.push([sql, values]); return { rows: [], command: sql.split(" ")[0] }; }, release: value => released = value }) };
  const db = new PgPoolDatabase(pool);
  await db.transaction(async sql => { await sql.query('SELECT 1'); return 7; });
  assert.deepEqual(log.map(x => x[0]), ['BEGIN', "SET LOCAL statement_timeout = '5000ms'", "SET LOCAL lock_timeout = '5000ms'", 'SELECT 1', 'COMMIT']); assert.equal(released, false);
  const bad = new PgPoolDatabase({ connect: async () => { throw new Error('postgres://secret'); } });
  await assert.rejects(bad.transaction(async () => 0), e => e.message === 'Delivery database connection failed');
});
test('pg Pool adapter rolls back and destroys a connection when rollback fails', async () => {
  let released; const log = [];
  const db = new PgPoolDatabase({ connect: async () => ({ query: async sql => { log.push(sql); if (sql === 'ROLLBACK') throw new Error('provider-secret'); return { rows: [] }; }, release: value => released = value }) });
  await assert.rejects(db.transaction(async () => { throw new Error('safe callback failure'); }), /safe callback/);
  assert.equal(released, true); assert.ok(log.includes('ROLLBACK')); assert.ok(!log.includes('COMMIT'));
});
test('PostgreSQL connection settings require explicit enablement and verified TLS', async () => {
  const { postgresConnectionConfig } = await import('../lib/telegram/delivery/postgres-config.ts');
  assert.throws(() => postgresConnectionConfig({}), /disabled/);
  assert.throws(() => postgresConnectionConfig({ TELEGRAM_DELIVERY_POSTGRES_ENABLED: 'true' }), /missing/);
  for (const url of ['not-a-url-secret', 'http://user:private@example.test/db', 'postgres://user:private@example.test/', 'postgres://user:private@example.test/db?sslmode=disable', 'postgres://user:private@example.test/db#secret']) {
    assert.throws(() => postgresConnectionConfig({ TELEGRAM_DELIVERY_POSTGRES_ENABLED: 'true', TELEGRAM_DELIVERY_DATABASE_URL: url }), e => !e.message.includes('private') && !e.message.includes('secret'));
  }
  const config = postgresConnectionConfig({ TELEGRAM_DELIVERY_POSTGRES_ENABLED: 'true', TELEGRAM_DELIVERY_DATABASE_URL: 'postgres://fake:example@example.invalid/reports' });
  assert.equal(config.ssl.rejectUnauthorized, true); assert.equal(config.max, 4); assert.equal(config.query_timeout, 10000);
  const env = { TELEGRAM_DELIVERY_POSTGRES_ENABLED: 'true', TELEGRAM_DELIVERY_DATABASE_URL: 'postgres://fake:example@example.invalid/reports' };
  const ca = '-----BEGIN CERTIFICATE-----\nprovider-ca\n-----END CERTIFICATE-----';
  const custom = postgresConnectionConfig({ ...env, TELEGRAM_DELIVERY_DATABASE_CA_PEM: ca });
  assert.equal(custom.ssl.ca, ca); assert.equal(custom.ssl.rejectUnauthorized, true);
  for (const invalid of ['', 'private-secret', ca.repeat(1000)]) {
    assert.throws(() => postgresConnectionConfig({ ...env, TELEGRAM_DELIVERY_DATABASE_CA_PEM: invalid }), e => e.message === 'Invalid PostgreSQL CA certificate configuration');
  }
});
