import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaMultipart, MAX_UPLOAD_FILE_BYTES } from '../lib/telegram/media-bytes.ts';
import { callBotApiBytes, BotApiError } from '../lib/telegram/bot-api.ts';
const file = { field_name: 'upload1', filename: '报告.txt', content_type: 'text/plain', base64: Buffer.from('example bytes').toString('base64') };
const params = { chat_id: '-10012345', document: 'attach://upload1', caption: 'A file' };
function enable() { process.env.TELEGRAM_MEDIA_BYTES_ENABLED = 'true'; process.env.TELEGRAM_MEDIA_ALLOWED_DESTINATIONS_JSON = JSON.stringify([{ botAlias: 'reports', chatId: '-10012345' }]); process.env.TELEGRAM_BOTS_JSON = JSON.stringify({ reports: { token: 'synthetic-media-test-token' } }); }
for (const key of Object.keys(process.env)) if (key.startsWith('TELEGRAM_') || key === 'MCP_API_KEY') delete process.env[key];

test('pure multipart builder preserves exact bytes and Unicode filename without filesystem or network', async () => {
  const built = buildMediaMultipart('sendDocument', params, [file]);
  assert.equal(built.fileCount, 1); assert.equal(built.totalBytes, 13);
  assert.equal(built.body.get('chat_id'), params.chat_id); assert.equal(built.body.get('document'), 'attach://upload1');
  const blob = built.body.get('upload1'); assert.equal(blob.name, '报告.txt'); assert.equal(blob.type, 'text/plain');
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString(), 'example bytes');
});
test('file quotas include exact boundary and reject oversize before decoding all inputs', () => {
  const boundary = { ...file, base64: Buffer.alloc(MAX_UPLOAD_FILE_BYTES, 7).toString('base64') };
  assert.equal(buildMediaMultipart('sendDocument', params, [boundary]).totalBytes, MAX_UPLOAD_FILE_BYTES);
  assert.throws(() => buildMediaMultipart('sendDocument', params, [{ ...boundary, base64: Buffer.alloc(MAX_UPLOAD_FILE_BYTES + 1).toString('base64') }]), /size|oversized|bounded/);
  const files = ['a', 'b', 'c'].map(field_name => ({ ...boundary, field_name }));
  assert.throws(() => buildMediaMultipart('sendMediaGroup', { chat_id: params.chat_id, media: files.map(f => ({ type: 'document', media: `attach://${f.field_name}` })) }, files), /size|16 MiB/);
});
test('base64 must be canonical with no whitespace, URL prefix, URL-safe alphabet or nonzero pad bits', () => {
  for (const base64 of ['', 'A', 'AAA', 'A===', '====', 'AA==\n', 'data:text/plain;base64,AA==', 'AB==', 'AAA_', 'AAA-']) assert.throws(() => buildMediaMultipart('sendDocument', params, [{ ...file, base64 }]));
});
test('path/control/bidi filenames and content-type header injection are rejected', () => {
  for (const filename of ['../secret', '..', '.', 'a/b', 'a\\b', 'x\r\ny', '\u202eevil.exe', '\ud800']) assert.throws(() => buildMediaMultipart('sendDocument', params, [{ ...file, filename }]));
  for (const content_type of ['text/plain\r\nx: y', 'text/plain; filename=x', 'not-a-mime', '']) assert.throws(() => buildMediaMultipart('sendDocument', params, [{ ...file, content_type }]));
});
test('attachment references reject missing, unused, duplicate and parameter-colliding fields', () => {
  assert.throws(() => buildMediaMultipart('sendDocument', { ...params, document: 'attach://absent' }, [file]));
  assert.throws(() => buildMediaMultipart('sendDocument', params, [file, { ...file, field_name: 'unused' }]));
  assert.throws(() => buildMediaMultipart('sendDocument', params, [file, file]));
  assert.throws(() => buildMediaMultipart('sendDocument', { ...params, document: 'attach://chat_id' }, [{ ...file, field_name: 'chat_id' }]));
  assert.throws(() => buildMediaMultipart('sendDocument', { ...params, document: 'attach://caption' }, [{ ...file, field_name: 'caption' }]));
});
test('media upload has an explicit method/identity boundary and never fetches URLs', () => {
  for (const method of ['getManagedBotToken', 'replaceManagedBotToken', 'setWebhook', '../sendDocument']) assert.throws(() => buildMediaMultipart(method, params, [file]));
  assert.throws(() => buildMediaMultipart('sendDocument', { ...params, business_connection_id: 'other-owner' }, [file]));
  assert.throws(() => buildMediaMultipart('sendDocument', { ...params, document: 'https://private.invalid/file' }, [file]));
  assert.throws(() => buildMediaMultipart('sendDocument', { ...params, thumbnail: 'file:///etc/passwd' }, [file]));
  assert.throws(() => buildMediaMultipart('sendDocument', { ...params, chat_id: '9223372036854775808' }, [file]));
});
test('media group serializes JSON and enforces album count and compatible types', () => {
  const second = { ...file, field_name: 'upload2' };
  const media = [{ type: 'photo', media: 'attach://upload1' }, { type: 'video', media: 'attach://upload2' }];
  assert.deepEqual(JSON.parse(buildMediaMultipart('sendMediaGroup', { chat_id: params.chat_id, media }, [file, second]).body.get('media')), media);
  assert.throws(() => buildMediaMultipart('sendMediaGroup', { chat_id: params.chat_id, media: media.slice(0, 1) }, [file]));
  assert.throws(() => buildMediaMultipart('sendMediaGroup', { chat_id: params.chat_id, media: [media[0], { ...media[1], type: 'audio' }] }, [file, second]));
});
test('parameter budgets bound nesting, total encoded size and non-JSON values', () => {
  let deep = {}; for (let i = 0; i < 20; i++) deep = { nested: deep };
  for (const extra of [deep, { caption: 'x'.repeat(65537) }, { caption: '\0'.repeat(20000) }, { unsupported: 1n }, { unsupported: new Date() }, { constructor: 'bad' }]) assert.throws(() => buildMediaMultipart('sendDocument', { ...params, ...extra }, [file]));
});
test('live byte upload is disabled without explicit scope and checks policy before fetching', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('should not be called'); });
  delete process.env.TELEGRAM_MEDIA_BYTES_ENABLED;
  await assert.rejects(callBotApiBytes('reports', 'sendDocument', params, [file]), /disabled/);
  enable(); process.env.TELEGRAM_MEDIA_ALLOWED_DESTINATIONS_JSON = JSON.stringify([{ botAlias: 'other', chatId: params.chat_id }]);
  await assert.rejects(callBotApiBytes('reports', 'sendDocument', params, [file]), /outside/); assert.equal(calls, 0);
});
test('multipart dispatch shares fixed Telegram endpoint, no redirect, deadline and response verification', async t => {
  enable(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++; assert.equal(url, 'https://api.telegram.org/botsynthetic-media-test-token/sendDocument');
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal); assert.ok(init.body instanceof FormData);
    assert.equal(init.headers['content-type'], undefined); assert.equal(init.body.get('chat_id'), params.chat_id);
    return Response.json({ ok: true, result: { message_id: 1, chat: { id: -10012345 } } });
  });
  assert.equal((await callBotApiBytes('reports', 'sendDocument', params, [file])).result.message_id, 1); assert.equal(calls, 1);
});
test('multipart errors preserve uncertainty, sanitize descriptions and never retry', async t => {
  enable(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ ok: false, error_code: 500, description: 'provider-sensitive-secret' }, { status: 500 }); });
  await assert.rejects(callBotApiBytes('reports', 'sendDocument', params, [file]), e => e instanceof BotApiError && e.details.delivery_unknown === true && !e.message.includes('sensitive'));
  assert.equal(calls, 1);
});
test('ignored or arbitrary nested media-like keys cannot authorize otherwise unused bytes', () => {
  const extra = { ...file, field_name: 'upload2' };
  assert.throws(() => buildMediaMultipart('sendDocument', { ...params, dummy: { thumbnail: 'attach://upload2' } }, [file, extra]), /referenced/);
  assert.throws(() => buildMediaMultipart('sendMediaGroup', { chat_id: params.chat_id, media: [{ type: 'photo', media: 'known-file-id' }, { type: 'photo', media: 'other-file-id' }], document: 'attach://upload1' }, [file]), /supplied bytes/);
  assert.throws(() => buildMediaMultipart('sendPhoto', { chat_id: params.chat_id, photo: 'attach://upload1', thumbnail: 'attach://upload2' }, [file, extra]), /referenced/);
});
