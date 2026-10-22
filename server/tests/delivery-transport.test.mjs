import test from 'node:test';
import assert from 'node:assert/strict';
import { BotApiDeliveryTransport } from '../lib/telegram/delivery/bot-transport.ts';
import { DefiniteRejection } from '../lib/telegram/delivery/types.ts';
for (const key of Object.keys(process.env)) if (key.startsWith('TELEGRAM_') || key === 'MCP_API_KEY') delete process.env[key];
process.env.TELEGRAM_BOTS_JSON = JSON.stringify({ reports: { token: 'synthetic-test-token' } });
const request = { botAlias: 'reports', chatId: '-10012345', text: '<literal> & 中文', attemptId: 'fake-attempt' };
const transport = new BotApiDeliveryTransport();
function response(status, body) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

test('transport sends plain text to an exact ID and returns only a validated receipt', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++; assert.match(url, /\/sendMessage$/);
    assert.deepEqual(JSON.parse(init.body), { chat_id: request.chatId, text: request.text });
    return response(200, { ok: true, result: { message_id: 8, chat: { id: -10012345 }, text: 'unretained' } });
  });
  assert.deepEqual(await transport.send(request), { chatId: request.chatId, messageId: 8 }); assert.equal(calls, 1);
});
test('only coherent 429 response becomes a definite retryable rejection', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(429, { ok: false, error_code: 429, parameters: { retry_after: 900 }, description: 'unretained-token' }); });
  await assert.rejects(transport.send(request), e => e instanceof DefiniteRejection && e.kind === 'rate_limited' && e.retryAfterSeconds === 900 && !e.message.includes('token'));
  assert.equal(calls, 1);
});
test('coherent 400 or migration rejection does not reroute automatically', async t => {
  t.mock.method(globalThis, 'fetch', async () => response(400, { ok: false, error_code: 400, parameters: { migrate_to_chat_id: -100999 } }));
  await assert.rejects(transport.send(request), e => e instanceof DefiniteRejection && e.kind === 'rejected');
});
test('5xx, malformed or mismatching responses remain unknown', async t => {
  for (const [status, body] of [
    [500, { ok: false, error_code: 500 }],
    [429, { ok: false, error_code: 400 }],
    [200, { ok: true, result: { message_id: 1, chat: { id: -100999 } } }],
    [200, { ok: true, result: { message_id: 1, chat: { id: Number.MAX_SAFE_INTEGER + 1 } } }],
    [200, { ok: true, result: null }],
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => response(status, body));
    await assert.rejects(transport.send(request), e => !(e instanceof DefiniteRejection) && e.message === 'Telegram delivery outcome is unknown');
    mock.mock.restore();
  }
});
test('network failure remains unknown and does not leak provider details', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('https://api.telegram.org/botsynthetic-test-token/private'); });
  await assert.rejects(transport.send(request), e => !(e instanceof DefiniteRejection) && e.message === 'Telegram delivery outcome is unknown');
});
test('configuration preflight fails before claim and can be corrected without stranding the job', async t => {
  const { ReportQueue } = await import('../lib/telegram/delivery/queue.ts');
  const { MemoryQueueStore } = await import('../lib/telegram/delivery/store.ts');
  const q = new ReportQueue(new MemoryQueueStore());
  const job = q.draft({ idempotencyKey: 'config-preflight', botAlias: 'reports', chatId: request.chatId, text: 'sample' });
  q.enqueue(job.id, job.fingerprint); const previous = process.env.TELEGRAM_BOTS_JSON;
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return response(200, { ok: true, result: { message_id: 9, chat: { id: -10012345 } } }); });
  try {
    process.env.TELEGRAM_BOTS_JSON = '{}';
    await assert.rejects(q.dispatchNext(job.id, job.fingerprint, transport), /no delivery was attempted/);
    assert.equal(q.get(job.id).state, 'queued'); assert.equal(q.get(job.id).chunks[0].attempts, 0); assert.equal(calls, 0);
    process.env.TELEGRAM_BOTS_JSON = '{malformed';
    await assert.rejects(q.dispatchNext(job.id, job.fingerprint, transport), /no delivery was attempted/);
    assert.equal(q.get(job.id).state, 'queued'); assert.equal(calls, 0);
    process.env.TELEGRAM_BOTS_JSON = previous;
    assert.equal((await q.dispatchNext(job.id, job.fingerprint, transport)).state, 'delivered'); assert.equal(calls, 1);
  } finally { process.env.TELEGRAM_BOTS_JSON = previous; }
});
