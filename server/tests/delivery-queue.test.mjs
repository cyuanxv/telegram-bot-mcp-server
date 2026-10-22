import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ReportQueue, DELIVERY_LEASE_MS, MAX_DELIVERY_ATTEMPTS } from '../lib/telegram/delivery/queue.ts';
import { MemoryQueueStore } from '../lib/telegram/delivery/store.ts';
import { SqliteQueueStore } from '../lib/telegram/delivery/sqlite-store.ts';
import { DefiniteRejection } from '../lib/telegram/delivery/types.ts';

const input = { idempotencyKey: 'daily:2026-10-08', botAlias: 'reports', chatId: '-10012345', text: 'hello world' };
const success = { send: async r => ({ chatId: r.chatId, messageId: 1 }) };
function setup(store = new MemoryQueueStore()) {
  let now = 1000000;
  const queue = new ReportQueue(store, () => now);
  return { queue, store, tick: ms => now += ms, draft: overrides => queue.draft({ ...input, ...overrides }) };
}
function queued(s, overrides) { const d = s.draft(overrides); s.queue.enqueue(d.id, d.fingerprint); return d; }
function sqlite(t) {
  const folder = mkdtempSync(join(tmpdir(), 'telegram-delivery-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'queue.sqlite');
  return { folder, file };
}

test('draft is offline, starts unapproved, and splitting preserves complete Unicode text', () => {
  const s = setup(); const d = s.draft({ text: '👩‍💻中文\nabc\nxyz', maxChunkLength: 8 });
  assert.equal(d.state, 'draft'); assert.equal(d.chunks.map(c => c.text).join(''), '👩‍💻中文\nabc\nxyz');
  assert.ok(d.chunks.length > 1); assert.ok(d.chunks.every(c => c.attempts === 0));
});
test('idempotency returns same job, fingerprint binds destination, bot and exact chunking', () => {
  const s = setup(); const a = s.draft(); const b = s.draft(); assert.equal(a.id, b.id);
  for (const changed of [{ text: 'changed' }, { chatId: '-100999' }, { botAlias: 'other' }, { maxChunkLength: 6 }]) {
    assert.throws(() => s.draft(changed), /Idempotency/);
  }
});
test('explicit stable IDs and bounded idempotency keys are required', () => {
  const s = setup();
  for (const changes of [{ chatId: '@group' }, { chatId: '0' }, { chatId: '' }, { botAlias: '' }, { idempotencyKey: 'x'.repeat(129) }]) assert.throws(() => s.draft(changes));
});
test('copies returned by adapters cannot mutate stored destinations or chunks', () => {
  const s = setup(); const d = s.draft(); d.chatId = '999'; d.chunks[0].text = 'changed';
  assert.equal(s.queue.get(d.id).chatId, input.chatId); assert.equal(s.queue.get(d.id).chunks[0].text, input.text);
});
test('draft and wrong fingerprint cannot dispatch', async () => {
  const s = setup(); const d = s.draft(); let calls = 0;
  const transport = { send: async r => { calls++; return success.send(r); } };
  await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, transport), /blocked/);
  assert.throws(() => s.queue.enqueue(d.id, 'wrong'), /fingerprint/);
  s.queue.enqueue(d.id, d.fingerprint);
  await assert.rejects(s.queue.dispatchNext(d.id, 'wrong', transport), /fingerprint/);
  assert.equal(calls, 0);
});
test('each explicit dispatch sends only one chunk and final success blocks repeats', async () => {
  const s = setup(); const d = queued(s, { text: 'abcdef', maxChunkLength: 3 }); const texts = [];
  const transport = { send: async r => { texts.push(r.text); return { chatId: r.chatId, messageId: texts.length }; } };
  let result = await s.queue.dispatchNext(d.id, d.fingerprint, transport);
  assert.equal(result.state, 'queued'); assert.deepEqual(texts, ['abc']);
  result = await s.queue.dispatchNext(d.id, d.fingerprint, transport);
  assert.equal(result.state, 'delivered'); assert.deepEqual(texts, ['abc', 'def']);
  await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, transport), /blocked/);
  assert.equal(texts.length, 2);
});
test('concurrent dispatchers cannot both send the same chunk', async () => {
  const s = setup(); const d = queued(s); let finish, calls = 0;
  const first = s.queue.dispatchNext(d.id, d.fingerprint, { send: r => { calls++; return new Promise(resolve => finish = () => resolve({ chatId: r.chatId, messageId: 1 })); } });
  await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, success), /blocked/);
  assert.equal(calls, 1); finish(); assert.equal((await first).state, 'delivered');
});
test('unknown errors stop the report without leaking error text or automatic retry', async () => {
  const s = setup(); const d = queued(s, { text: 'abcdef', maxChunkLength: 3 }); let calls = 0;
  const result = await s.queue.dispatchNext(d.id, d.fingerprint, { send: async () => { calls++; throw new Error('private-token-secret'); } });
  assert.equal(result.state, 'unknown'); assert.equal(result.chunks[1].attempts, 0);
  assert.ok(!JSON.stringify(result).includes('private-token-secret'));
  s.tick(99999999);
  await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, success), /unknown/);
  assert.throws(() => s.queue.enqueue(d.id, d.fingerprint)); assert.equal(calls, 1);
});
test('receipt validation rejects wrong recipient, absent receipt and unsafe message IDs', async () => {
  for (const receipt of [null, {}, { chatId: 'other', messageId: 1 }, { chatId: input.chatId, messageId: 0 }, { chatId: input.chatId, messageId: Number.MAX_SAFE_INTEGER + 1 }]) {
    const s = setup(); const d = queued(s);
    assert.equal((await s.queue.dispatchNext(d.id, d.fingerprint, { send: async () => receipt })).state, 'unknown');
  }
});
test('definite rate limit persists its full delay and needs another explicit dispatch', async () => {
  const s = setup(); const d = queued(s); let calls = 0;
  let result = await s.queue.dispatchNext(d.id, d.fingerprint, { send: async () => { calls++; throw new DefiniteRejection('rate_limited', 120); } });
  assert.equal(result.state, 'retry_wait'); assert.equal(result.chunks[0].retryAt, 1120000); assert.equal(calls, 1);
  await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, success), /delay/);
  s.tick(120000); result = await s.queue.dispatchNext(d.id, d.fingerprint, success);
  assert.equal(result.state, 'delivered'); assert.equal(result.chunks[0].attempts, 2);
});
test('retry attempts have a hard budget and never retry terminal rejections', async () => {
  const s = setup(); const d = queued(s); let result;
  for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) result = await s.queue.dispatchNext(d.id, d.fingerprint, { send: async () => { throw new DefiniteRejection('rate_limited', 0); } });
  assert.equal(result.state, 'rejected'); assert.equal(result.chunks[0].attempts, MAX_DELIVERY_ATTEMPTS);
  await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, success));
});
test('invalid or excessive retry hints fail closed rather than shorten the server wait', async () => {
  for (const seconds of [-1, NaN, Infinity, 0.5, 604801]) {
    const s = setup(); const d = queued(s);
    const result = await s.queue.dispatchNext(d.id, d.fingerprint, { send: async () => { throw new DefiniteRejection('rate_limited', seconds); } });
    assert.equal(result.state, 'rejected'); assert.equal(result.chunks[0].retryAt, undefined);
  }
});
test('ordinary definite rejection is terminal', async () => {
  const s = setup(); const d = queued(s);
  assert.equal((await s.queue.dispatchNext(d.id, d.fingerprint, { send: async () => { throw new DefiniteRejection('rejected'); } })).state, 'rejected');
});
test('stale in-flight claim recovers to unknown, and late results cannot overwrite it', async () => {
  const s = setup(); const d = queued(s); let finish;
  const pending = s.queue.dispatchNext(d.id, d.fingerprint, { send: r => new Promise(resolve => finish = () => resolve({ chatId: r.chatId, messageId: 1 })) });
  assert.equal(s.queue.recoverStale(d.id).state, 'sending'); s.tick(DELIVERY_LEASE_MS);
  assert.equal(s.queue.recoverStale(d.id).state, 'unknown');
  finish(); await assert.rejects(pending, /manual reconciliation/);
  await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, success), /unknown/);
});
test('verified unknown receipt requires matching attempt and recipient before continuation', async () => {
  const s = setup(); const d = queued(s, { text: 'abcdef', maxChunkLength: 3 });
  const failed = await s.queue.dispatchNext(d.id, d.fingerprint, { send: async () => { throw new Error('timeout'); } });
  const input = { chunkIndex: 1, attemptId: failed.chunks[0].attemptId, receipt: { chatId: d.chatId, messageId: 777 }, evidenceReference: 'operator verified Telegram message 777' };
  assert.throws(() => s.queue.confirmUnknownDelivery(d.id, d.fingerprint, { ...input, attemptId: 'other' }));
  assert.throws(() => s.queue.confirmUnknownDelivery(d.id, d.fingerprint, { ...input, evidenceReference: '' }));
  assert.throws(() => s.queue.confirmUnknownDelivery(d.id, d.fingerprint, { ...input, receipt: { chatId: 'other', messageId: 1 } }));
  assert.equal(s.queue.confirmUnknownDelivery(d.id, d.fingerprint, input).state, 'queued');
  assert.equal((await s.queue.dispatchNext(d.id, d.fingerprint, success)).state, 'delivered');
});
test('failed store settlement after successful send leaves durable sending claim, never pending', async () => {
  const s = setup(); const d = queued(s); const update = s.store.update.bind(s.store); let updates = 0;
  s.store.update = (...args) => { if (++updates === 2) throw new Error('disk full'); return update(...args); };
  await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, success), /disk full/);
  s.store.update = update; assert.equal(s.queue.get(d.id).state, 'sending'); s.tick(DELIVERY_LEASE_MS);
  assert.equal(s.queue.recoverStale(d.id).state, 'unknown');
});
test('SQLite job, receipt and idempotency survive a closed connection and restart', async t => {
  const { file } = sqlite(t); let store = new SqliteQueueStore(file); let s = setup(store); const d = queued(s);
  await s.queue.dispatchNext(d.id, d.fingerprint, success); store.close();
  store = new SqliteQueueStore(file); t.after(() => store.close()); s = setup(store);
  assert.equal(s.queue.get(d.id).state, 'delivered'); assert.equal(s.draft().id, d.id);
  await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, success), /delivered/);
});
test('SQLite transaction rolls back mutation when callback fails', t => {
  const { file } = sqlite(t); const store = new SqliteQueueStore(file); t.after(() => store.close()); const s = setup(store); const d = queued(s);
  assert.throws(() => store.update(d.id, job => { job.chatId = '99'; throw new Error('rollback'); }));
  assert.equal(store.get(d.id).chatId, input.chatId);
});
test('two SQLite connections enforce idempotency and single in-flight claim', async t => {
  const { file } = sqlite(t); const a = new SqliteQueueStore(file); const b = new SqliteQueueStore(file); t.after(() => { a.close(); b.close(); });
  const x = setup(a), y = setup(b), d = queued(x); assert.equal(y.draft().id, d.id);
  let finish;
  const pending = x.queue.dispatchNext(d.id, d.fingerprint, { send: r => new Promise(resolve => finish = () => resolve({ chatId: r.chatId, messageId: 9 })) });
  await assert.rejects(y.queue.dispatchNext(d.id, d.fingerprint, success), /sending/); finish(); await pending;
  assert.equal(y.queue.get(d.id).state, 'delivered');
});
test('actual child-process crash after committed claim recovers unknown with zero resend', async t => {
  const { file, folder } = sqlite(t); let store = new SqliteQueueStore(file); const s = setup(store); const d = queued(s); store.close();
  const marker = join(folder, 'mock-send.txt');
  const script = `import {SqliteQueueStore} from './lib/telegram/delivery/sqlite-store.ts';\nimport {ReportQueue} from './lib/telegram/delivery/queue.ts';\nimport {writeFileSync} from 'node:fs';\nconst s=new SqliteQueueStore(${JSON.stringify(file)}); const q=new ReportQueue(s,()=>1000000);\nawait q.dispatchNext(${JSON.stringify(d.id)},${JSON.stringify(d.fingerprint)},{send:async()=>{writeFileSync(${JSON.stringify(marker)},'one mock attempt');process.exit(23)}});`;
  const child = spawnSync(process.execPath, ['--import', './tests/register-typescript.mjs', '--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 23, child.stderr); assert.equal(readFileSync(marker, 'utf8'), 'one mock attempt');
  store = new SqliteQueueStore(file); t.after(() => store.close()); const restarted = setup(store); restarted.tick(DELIVERY_LEASE_MS);
  assert.equal(restarted.queue.get(d.id).state, 'sending'); assert.equal(restarted.queue.recoverStale(d.id).state, 'unknown');
  let calls = 0; await assert.rejects(restarted.queue.dispatchNext(d.id, d.fingerprint, { send: async r => { calls++; return success.send(r); } }), /unknown/);
  assert.equal(calls, 0);
});
test('SQLite rejects relative paths and explicit ephemeral hosting contexts', t => {
  assert.throws(() => new SqliteQueueStore('relative.sqlite'), /absolute/);
  const { file } = sqlite(t); const prior = process.env.VERCEL; process.env.VERCEL = '1';
  try { assert.throws(() => new SqliteQueueStore(file), /ephemeral/); } finally { if (prior === undefined) delete process.env.VERCEL; else process.env.VERCEL = prior; }
});

test('SQLite refuses structurally corrupted persisted records before transport can run', async t => {
  const { file } = sqlite(t); const store = new SqliteQueueStore(file); t.after(() => store.close());
  const s = setup(store); const d = queued(s);
  const { DatabaseSync } = await import('node:sqlite'); const raw = new DatabaseSync(file); t.after(() => raw.close());
  const original = JSON.parse(raw.prepare('SELECT document FROM delivery_reports WHERE id=?').get(d.id).document);
  for (const mutate of [job => job.chunks[0].attempts = -1, job => job.state = 'delivered', job => job.chunks[0].text = '', job => job.chunks[0].index = 2]) {
    const job = structuredClone(original); mutate(job); raw.prepare('UPDATE delivery_reports SET document=? WHERE id=?').run(JSON.stringify(job), d.id);
    let calls = 0;
    await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, { send: async r => { calls++; return success.send(r); } }), /corrupted/);
    assert.equal(calls, 0);
  }
});
test('persisted destination or content changes are rejected by the bound fingerprint', async t => {
  const { file } = sqlite(t); const store = new SqliteQueueStore(file); t.after(() => store.close()); const s = setup(store); const d = queued(s);
  const { DatabaseSync } = await import('node:sqlite'); const raw = new DatabaseSync(file); t.after(() => raw.close());
  const job = JSON.parse(raw.prepare('SELECT document FROM delivery_reports WHERE id=?').get(d.id).document); job.chatId = '-100999';
  raw.prepare('UPDATE delivery_reports SET document=? WHERE id=?').run(JSON.stringify(job), d.id);
  await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, success), /fingerprint/);
});
test('duplicate receipt across report chunks cannot mark both as delivered', async () => {
  const s = setup(); const d = queued(s, { text: 'abcdef', maxChunkLength: 3 });
  await s.queue.dispatchNext(d.id, d.fingerprint, success);
  await assert.rejects(s.queue.dispatchNext(d.id, d.fingerprint, success), /corrupted/);
  assert.equal(s.queue.get(d.id).state, 'sending'); s.tick(DELIVERY_LEASE_MS);
  assert.equal(s.queue.recoverStale(d.id).state, 'unknown');
});
