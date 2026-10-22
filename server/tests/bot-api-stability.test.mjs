import assert from 'node:assert/strict';
import { test, beforeEach, after, mock } from 'node:test';
import { BotApiError, callBotApi, readBotApiJson, BOT_API_MAX_RESPONSE_BYTES, BOT_API_TIMEOUT_MS } from '../lib/telegram/bot-api.ts';
const originalFetch = globalThis.fetch;
const envKeys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOTS_JSON'];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let calls = 0;
beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = 'TEST_STABILITY_TOKEN';
  delete process.env.TELEGRAM_BOTS_JSON;
  calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ ok: true, result: { message_id: 1 } }); };
});
after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});

test('production response budget and deadline stay finite', () => {
  assert.equal(BOT_API_MAX_RESPONSE_BYTES, 2 * 1024 * 1024);
  assert.equal(BOT_API_TIMEOUT_MS, 30000);
});
test('malformed success envelopes do not become delivery receipts', async () => {
  for (const data of [null, [], { ok: 'true', result: {} }, { ok: true }, {}]) {
    globalThis.fetch = async () => Response.json(data);
    await assert.rejects(callBotApi(undefined, 'sendMessage'), e => e instanceof BotApiError && e.details.code === 'invalid_response' && e.details.delivery_unknown);
  }
});
test('successful false and null result values are preserved', async () => {
  for (const value of [false, null, 0, []]) {
    globalThis.fetch = async () => Response.json({ ok: true, result: value });
    assert.deepEqual((await callBotApi(undefined, 'test')).result, value);
  }
});
test('non-JSON response and its secrets are never copied to an error', async () => {
  globalThis.fetch = async () => new Response('<secret>TEST_STABILITY_TOKEN</secret>', { status: 502 });
  await assert.rejects(callBotApi(undefined, 'sendMessage'), e => e.details.code === 'invalid_response' && !JSON.stringify(e).includes('TEST_STABILITY_TOKEN') && !e.message.includes('TEST_STABILITY_TOKEN'));
});
test('body failures are sanitized and remain ambiguous without retry', async () => {
  globalThis.fetch = async () => { calls++; return new Response(new ReadableStream({ pull(controller) { controller.error(new Error('TEST_STABILITY_TOKEN')); } })); };
  await assert.rejects(callBotApi(undefined, 'sendMessage'), e => e.details.code === 'network_error' && e.details.delivery_unknown && !JSON.stringify(e).includes('TEST_STABILITY_TOKEN'));
  assert.equal(calls, 1);
});
test('oversized body is cancelled instead of read to completion', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(33)); }, cancel() { cancelled = true; } }));
  await assert.rejects(readBotApiJson(response, new AbortController().signal, 32), e => e.details.code === 'response_too_large');
  assert.equal(cancelled, true);
});
test('chunked UTF-8 decoding handles a multibyte character crossing chunks', async () => {
  const bytes = new TextEncoder().encode('{"ok":true,"result":"🙂中文"}');
  const response = new Response(new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } }));
  assert.deepEqual(await readBotApiJson(response, new AbortController().signal), { ok: true, result: '🙂中文' });
});
test('invalid UTF-8 is rejected instead of silently replaced', async () => {
  await assert.rejects(readBotApiJson(new Response(new Uint8Array([0xff])), new AbortController().signal), e => e.details.code === 'invalid_response');
});
test('stalled body stops at abort even if the stream ignores abort', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const promise = readBotApiJson(response, controller.signal);
  controller.abort();
  await assert.rejects(promise, e => e.details.code === 'timeout' && e.details.delivery_unknown);
  assert.equal(cancelled, true);
});
test('already-aborted body cannot produce a success', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readBotApiJson(Response.json({ ok: true, result: {} }), controller.signal), e => e.details.code === 'timeout');
});
test('fetch ignoring abort is still bounded by the absolute deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal, started;
  const fetchStarted = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async (_url, options) => { calls++; signal = options.signal; started(); return new Promise(() => {}); };
  const promise = callBotApi(undefined, 'sendMessage');
  const rejected = assert.rejects(promise, e => e.details.code === 'timeout' && e.details.automatic_retry_performed === false);
  await fetchStarted;
  t.mock.timers.tick(30000);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
});
test('absolute deadline covers delayed body after response headers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  globalThis.fetch = async (_url, options) => { signal = options.signal; return new Response(new ReadableStream({})); };
  const promise = callBotApi(undefined, 'sendMessage');
  const rejected = assert.rejects(promise, e => e.details.code === 'timeout' && e.details.delivery_unknown);
  await Promise.resolve();
  t.mock.timers.tick(30000);
  await rejected;
  assert.equal(signal.aborted, true);
});
test('provider error strips descriptions and arbitrary secret properties', async () => {
  globalThis.fetch = async () => Response.json({ ok: false, description: 'TEST_STABILITY_TOKEN', error_code: 400, parameters: { arbitrary: 'TEST_STABILITY_TOKEN' }, result: 'TEST_STABILITY_TOKEN' }, { status: 400 });
  await assert.rejects(callBotApi(undefined, 'sendMessage'), e => e.details.code === 'telegram_error' && e.details.delivery_unknown === false && !JSON.stringify(e).includes('TEST_STABILITY_TOKEN'));
});
test('rate limits retain bounded numeric advice and never retry', async () => {
  globalThis.fetch = async () => { calls++; return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 90 } }, { status: 429 }); };
  await assert.rejects(callBotApi(undefined, 'sendMessage'), e => e.details.retry_after_seconds === 90 && e.details.code === 'rate_limited');
  assert.equal(calls, 1);
});
test('invalid retry fields are discarded rather than coerced', async () => {
  for (const value of [-1, 0.2, '50', Number.MAX_SAFE_INTEGER + 1, null]) {
    globalThis.fetch = async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: value } }, { status: 429 });
    await assert.rejects(callBotApi(undefined, 'sendMessage'), e => !Object.hasOwn(e.details, 'retry_after_seconds'));
  }
});
test('migration destination is advice only; no automatic reroute', async () => {
  globalThis.fetch = async () => { calls++; return Response.json({ ok: false, error_code: 400, parameters: { migrate_to_chat_id: -1000123456789 } }, { status: 400 }); };
  await assert.rejects(callBotApi(undefined, 'sendMessage'), e => e.details.code === 'chat_migrated' && e.details.migrate_to_chat_id === '-1000123456789');
  assert.equal(calls, 1);
});
test('unsafe migration IDs are not rounded or exposed', async () => {
  globalThis.fetch = async () => Response.json({ ok: false, error_code: 400, parameters: { migrate_to_chat_id: -Number.MAX_SAFE_INTEGER - 2 } }, { status: 400 });
  await assert.rejects(callBotApi(undefined, 'sendMessage'), e => !Object.hasOwn(e.details, 'migrate_to_chat_id'));
});
test('request disallows redirects and keeps POST with a finite abort signal', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST'); assert(options.signal instanceof AbortSignal);
    assert.equal(new URL(url).hostname, 'api.telegram.org');
    return Response.json({ ok: true, result: true });
  };
  assert.equal((await callBotApi(undefined, 'getMe')).result, true);
});


test('coherent 5xx rejection keeps delivery uncertain', async () => {
  globalThis.fetch = async () => { calls++; return Response.json({ ok: false, error_code: 502 }, { status: 502 }); };
  await assert.rejects(callBotApi(undefined, 'sendMessage'), e => e.details.code === 'telegram_error' && e.details.delivery_unknown === true && e.details.automatic_retry_performed === false);
  assert.equal(calls, 1);
});
test('missing, malformed and conflicting rejection codes never claim non-delivery', async () => {
  for (const [status, errorCode] of [[200, undefined], [400, undefined], [200, 400], [400, 401], [400, 0], [400, '400'], [429, 999]]) {
    globalThis.fetch = async () => Response.json({ ok: false, ...(errorCode === undefined ? {} : { error_code: errorCode }) }, { status });
    await assert.rejects(callBotApi(undefined, 'sendMessage'), e => e.details.code === 'invalid_response' && e.details.delivery_unknown === true);
  }
});

test('asynchronous final send guard is awaited and cancellation after it prevents network dispatch', async () => {
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  const controller = new AbortController();
  const operation = callBotApi(undefined, 'sendMessageDraft', {chat_id:'123',draft_id:1,text:'x'}, {}, {
    signal:controller.signal, beforeSend:async()=>{entered();await pending;},
  });
  const rejected = assert.rejects(operation);
  await waiting;assert.equal(calls,0);controller.abort();release();await rejected;assert.equal(calls,0);
  await assert.rejects(callBotApi(undefined,'sendMessageDraft',{}, {},{beforeSend:async()=>{throw Error('stopped')}}));
  assert.equal(calls,0);
});
