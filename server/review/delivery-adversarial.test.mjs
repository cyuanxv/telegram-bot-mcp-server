// Independent review: synthetic inputs only; every transport call has mocked fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReportQueue } from '../lib/telegram/delivery/queue.ts';
import { MemoryQueueStore } from '../lib/telegram/delivery/store.ts';
import { BotApiDeliveryTransport } from '../lib/telegram/delivery/bot-transport.ts';

for (const key of Object.keys(process.env)) if (key.startsWith('TELEGRAM_') || key === 'MCP_API_KEY') delete process.env[key];
process.env.TELEGRAM_BOTS_JSON = JSON.stringify({ reports: { token: 'synthetic-offline-review-token' } });
function queued(suffix) {
  const queue = new ReportQueue(new MemoryQueueStore(), () => 1000000);
  const draft = queue.draft({ idempotencyKey: `review:${suffix}`, botAlias: 'reports', chatId: '-10012345', text: 'synthetic review report' });
  queue.enqueue(draft.id, draft.fingerprint);
  return { queue, draft };
}
for (const [name, hint] of [['fractional', 604800.5], ['unsafe', Number.MAX_SAFE_INTEGER + 1], ['string', '900'], ['negative', -1], ['null', null]]) {
  test(`real transport must not replace a present invalid ${name} retry hint with a 60 second retry`, async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return Response.json({ ok: false, error_code: 429, parameters: { retry_after: hint } }, { status: 429 });
    });
    const { queue, draft } = queued(name);
    const result = await queue.dispatchNext(draft.id, draft.fingerprint, new BotApiDeliveryTransport());
    assert.equal(calls, 1);
    assert.ok(['unknown', 'rejected'].includes(result.state), `invalid ${name} hint became ${result.state} at ${result.chunks[0].retryAt}`);
    assert.equal(result.chunks[0].retryAt, undefined);
  });
}
test('real transport preserves a valid server delay and never sends again implicitly', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 604800 } }, { status: 429 });
  });
  const { queue, draft } = queued('valid');
  const result = await queue.dispatchNext(draft.id, draft.fingerprint, new BotApiDeliveryTransport());
  assert.equal(result.state, 'retry_wait');
  assert.equal(result.chunks[0].retryAt, 1000000 + 604800000);
  await assert.rejects(queue.dispatchNext(draft.id, draft.fingerprint, new BotApiDeliveryTransport()), /delay/);
  assert.equal(calls, 1);
});
test('real transport refuses a valid but excessive server delay without shortening it', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 604801 } }, { status: 429 }));
  const { queue, draft } = queued('excessive');
  const result = await queue.dispatchNext(draft.id, draft.fingerprint, new BotApiDeliveryTransport());
  assert.equal(result.state, 'rejected');
  assert.equal(result.chunks[0].retryAt, undefined);
});
test('real transport does not guess a retry delay when Telegram omitted it', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: false, error_code: 429 }, { status: 429 }));
  const { queue, draft } = queued('missing');
  const result = await queue.dispatchNext(draft.id, draft.fingerprint, new BotApiDeliveryTransport());
  assert.equal(result.state, 'rejected');
  assert.equal(result.chunks[0].retryAt, undefined);
});
