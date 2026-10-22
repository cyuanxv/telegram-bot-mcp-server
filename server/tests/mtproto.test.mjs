import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { test, beforeEach, after, mock } from 'node:test';

const clients = [];
let connectError, sessionError, requestError, authorized, messages, me, dialogs, usernameResult;
const fakeSession = 'FAKE_TEST_SESSION';
const fakeHash = 'FAKE_TEST_HASH';
const fakeMcpKey = randomUUID();
let toJsonCalls = 0;
class FakeClient {
  constructor(session, apiId, apiHash, options) { this.options = options; this.disconnected = false; this.calls = []; clients.push(this); }
  async connect() { if (connectError) throw connectError; }
  async isUserAuthorized() { return authorized; }
  async disconnect() { this.disconnected = true; }
  async getMessages(peer, options) { this.calls.push({ operation: 'getMessages', peer, options }); if (requestError) throw requestError; return messages; }
  async getMe() { return me; }
  async getDialogs(options) { this.calls.push({ operation: 'getDialogs', options }); return dialogs; }
  async sendMessage(peer, options) { this.calls.push({ operation: 'sendMessage', peer, options }); return messages[0]; }
  api = { call: async request => { this.calls.push(request); return usernameResult; } };
}
mock.module('../lib/telegram/mtproto-peers.ts',{namedExports:{captureAccountPeer:()=>undefined,restoreAccountPeer:()=>{throw Error('unexpected cache')}}});
mock.module('teleproto', { namedExports: { TelegramClient: FakeClient } });
mock.module('teleproto/sessions', { namedExports: { StringSession: class { constructor() { if (sessionError) throw sessionError; } } } });
const { callMtproto, withMtproto, getMtprotoMe, listDialogs, sendMtprotoMessage, searchMtprotoMessages, listAccounts } = await import('../lib/telegram/mtproto.ts');
const { validateSafeRequest, publicUser, publicMessage, publicDialog, redactConfiguredSecrets } = await import('../lib/telegram/mtproto-policy.ts');
const keys = ['TELEGRAM_MTPROTO_ENABLED', 'TELEGRAM_ACCOUNTS_JSON', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'MCP_API_KEY'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
beforeEach(() => {
  for (const key of keys) delete process.env[key];
  process.env.TELEGRAM_MTPROTO_ENABLED = 'true';
  process.env.TELEGRAM_ACCOUNTS_JSON = JSON.stringify({ default: { session: fakeSession, apiId: 1, apiHash: fakeHash } });
  process.env.MCP_API_KEY = fakeMcpKey;
  clients.length = 0; connectError = undefined; sessionError = undefined; requestError = undefined; authorized = true; usernameResult = true; toJsonCalls = 0;
  messages = [{ id: 123n, date: 1, message: 'hello', out: false, senderId: 12n, chatId: -100n, replyTo: { replyToMsgId: 7 }, apiHash: fakeHash, accessHash: 999n, _client: { session: fakeSession }, toJSON() { toJsonCalls++; return { token: 'UNEXPECTED_CREDENTIAL' }; } }];
  me = { id: 12n, username: 'tester', firstName: 'Test', phone: 'FAKE_PHONE', apiHash: fakeHash, session: fakeSession, authKey: 'UNEXPECTED_CREDENTIAL', toJSON() { toJsonCalls++; return { token: 'UNEXPECTED_CREDENTIAL' }; } };
  dialogs = [{ id: -100n, name: 'Group', isGroup: true, unreadCount: 1, entity: { accessHash: 999n, session: fakeSession } }];
});
after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

const expectedMessage = { id: '123', date: 1, text: 'hello', outgoing: false, senderId: '12', chatId: '-100', replyToMessageId: 7 };

test('MTProto requires explicit enablement even when test credentials exist', async () => {
  for (const value of [undefined, '', 'false', '1', 'True']) {
    if (value === undefined) delete process.env.TELEGRAM_MTPROTO_ENABLED; else process.env.TELEGRAM_MTPROTO_ENABLED = value;
    await assert.rejects(getMtprotoMe(), /disabled/);
  }
  assert.equal(clients.length, 0);
});

test('missing or invalid personal API/session configuration fails before client creation', async () => {
  for (const config of [{ session: fakeSession }, { session: fakeSession, apiId: 1 }, { session: '', apiId: 1, apiHash: fakeHash }, { session: ' ', apiId: 1, apiHash: fakeHash }, { session: fakeSession, apiId: 0, apiHash: fakeHash }, { session: fakeSession, apiId: 1, apiHash: '' }]) {
    process.env.TELEGRAM_ACCOUNTS_JSON = JSON.stringify({ default: config });
    await assert.rejects(getMtprotoMe(), /missing valid|Invalid account/);
  }
  assert.equal(clients.length, 0);
});

test('account status reports valid configuration and explicit enablement separately', () => {
  process.env.TELEGRAM_MTPROTO_ENABLED = 'false';
  assert.deepEqual(listAccounts(), [{ alias: 'default', label: undefined, configured: true, enabled: false }]);
  process.env.TELEGRAM_ACCOUNTS_JSON = JSON.stringify({ default: { session: fakeSession } });
  assert.equal(listAccounts()[0].configured, false);
});

test('allowed history uses bounded getMessages and returns only safe message fields', async () => {
  assert.deepEqual(await callMtproto(undefined, 'messages.getHistory', { peer: 'me', limit: 1 }), { messages: [expectedMessage] });
  assert.deepEqual(clients[0].calls[0], { operation: 'getMessages', peer: 'me', options: { limit: 1, offsetId: 0 } });
  assert.equal(clients[0].options.timeout, 20);
  assert.equal(clients[0].options.requestRetries, 1);
  assert.equal(clients[0].options.connectionRetries, 1);
  assert.equal(clients[0].options.baseLogger.logLevel, 'none');
  assert.equal(clients[0].disconnected, true);
  assert.equal(toJsonCalls, 0);
});

test('allowed search constructs its own fixed request options', async () => {
  await callMtproto(undefined, 'messages.search', { peer: '@tester', q: 'needle', limit: 2, offsetId: 10 });
  assert.deepEqual(clients[0].calls[0], { operation: 'getMessages', peer: '@tester', options: { limit: 2, offsetId: 10, search: 'needle' } });
});

test('username availability only accepts a primitive username and a boolean result', async () => {
  assert.deepEqual(await callMtproto(undefined, 'bots.checkUsername', { username: 'test_bot' }), { available: true });
  assert.deepEqual(clients[0].calls[0], { _: 'bots.checkUsername', username: 'test_bot' });
  usernameResult = { token: 'UNEXPECTED_CREDENTIAL' };
  await assert.rejects(callMtproto(undefined, 'bots.checkUsername', { username: 'test_bot' }), /Unexpected result/);
});

test('authentication, wrappers, credentials and mutations are not allowlisted', async () => {
  for (const method of ['auth.exportAuthorization', 'auth.importBotAuthorization', 'invokeWithLayer', 'invokeAfterMsg', 'invokeWithTakeout', 'bots.createBot', 'bots.setBotInfo', 'messages.deleteHistory', 'users.getFullUser', 'Messages.getHistory']) {
    await assert.rejects(callMtproto(undefined, method, {}), /allowlist/);
  }
  assert.equal(clients.length, 0);
});

test('nested request trees, constructor fast paths, arrays and unknown fields are rejected', async () => {
  const bad = [
    { peer: 'me', _: 'auth.exportAuthorization' },
    { peer: 'me', query: { _: 'auth.exportAuthorization' } },
    { peer: 'me', classType: 'request' },
    { peer: 'me', constructor: { className: 'auth.ExportAuthorization' } },
    { peer: { _: 'inputPeerSelf', query: { _: 'auth.exportAuthorization' } } },
    { peer: [{ _: 'inputPeerSelf' }] },
    { peer: 'me', filter: { _: 'inputMessagesFilterEmpty' } },
    { peer: 'me', unknown: null },
    JSON.parse('{"peer":"me","__proto__":{"query":{"_":"auth.exportAuthorization"}}}'),
    [], null,
  ];
  for (const args of bad) await assert.rejects(callMtproto(undefined, 'messages.getHistory', args), /unsupported|plain object|peer must/);
  assert.equal(clients.length, 0);
});

test('nested values cannot hide inside fields of allowed methods', async () => {
  for (const args of [{ peer: 'me', q: { query: 'secret' } }, { peer: 'me', q: [] }, { peer: 'me', q: 'text', limit: {} }, { peer: 'https://example.test', q: '' }]) {
    await assert.rejects(callMtproto(undefined, 'messages.search', args));
  }
  await assert.rejects(callMtproto(undefined, 'bots.checkUsername', { username: { _: 'auth.exportAuthorization' } }));
  assert.equal(clients.length, 0);
});

test('limits, pagination and search input are bounded before connection', async () => {
  for (const args of [{ peer: 'me', limit: 0 }, { peer: 'me', limit: 101 }, { peer: 'me', offsetId: -1 }, { peer: 'me', limit: 1.5 }, { peer: 'me', offsetId: 2147483648 }]) {
    await assert.rejects(callMtproto(undefined, 'messages.getHistory', args));
  }
  await assert.rejects(callMtproto(undefined, 'messages.search', { peer: 'me', q: 'x'.repeat(4097) }));
  assert.equal(clients.length, 0);
});

test('all dedicated result paths project fields instead of returning TL objects', async () => {
  assert.deepEqual(await getMtprotoMe(), { id: '12', username: 'tester', firstName: 'Test' });
  assert.deepEqual(await listDialogs(), [{ id: '-100', name: 'Group', isGroup: true, unreadCount: 1 }]);
  assert.deepEqual(await sendMtprotoMessage(undefined, 'me', 'hello'), expectedMessage);
  assert.deepEqual(await searchMtprotoMessages(undefined, 'me', 'hello'), [expectedMessage]);
  assert.equal(toJsonCalls, 0);
});

test('configured credentials appearing in permitted text fields are redacted', async () => {
  messages[0].message = `${fakeSession} ${fakeHash} ${fakeMcpKey}`;
  const result = JSON.stringify(await searchMtprotoMessages(undefined, 'me', 'hello'));
  for (const secret of [fakeSession, fakeHash, fakeMcpKey]) assert(!result.includes(secret));
  assert(result.includes('[REDACTED]'));
});

test('credential redaction precedes truncation at every selected text boundary', async () => {
  const secret = 'FAKE_API_HASH_0123456789abcdef0123456789abcdef';
  for (const [make, inputField, outputField, max] of [
    [publicMessage, 'message', 'text', 65536], [publicUser, 'username', 'username', 64],
    [publicUser, 'firstName', 'firstName', 512], [publicUser, 'lastName', 'lastName', 512],
    [publicDialog, 'name', 'name', 512], [publicDialog, 'title', 'title', 512],
  ]) {
    const source = 'x'.repeat(max - secret.length + 1) + secret;
    const result = redactConfiguredSecrets(make({ id: 1, [inputField]: source }), [secret]);
    assert(!result[outputField].includes(secret.slice(0, -1)));
    assert(result[outputField].includes('[REDACTED]'));
    assert(result[outputField].length <= max);
  }
});

test('projection does not claim to scrub arbitrary secrets in user messages', async () => {
  messages[0].message = 'User-supplied text with an unknown token-like value';
  const result = await searchMtprotoMessages(undefined, 'me', 'hello');
  assert.equal(result[0].text, messages[0].message);
});

test('connection and request errors cannot echo credentials', async () => {
  connectError = new Error(`failed ${fakeSession} ${fakeHash}`);
  await assert.rejects(getMtprotoMe(), error => /withheld/.test(error.message) && !error.message.includes(fakeSession));
  assert.equal(clients[0].disconnected, true);
  connectError = undefined; requestError = new Error(`failed ${fakeHash}`);
  await assert.rejects(callMtproto(undefined, 'messages.getHistory', { peer: 'me' }), error => /withheld/.test(error.message) && !error.message.includes(fakeHash));
});

test('session-construction errors cannot expose the supplied session', async () => {
  sessionError = new Error(`invalid ${fakeSession}`);
  await assert.rejects(getMtprotoMe(), error => /withheld/.test(error.message) && !error.message.includes(fakeSession));
  assert.equal(clients.length, 0);
});

test('only fixed non-sensitive RPC error codes are surfaced', async () => {
  requestError = Object.assign(new Error(fakeHash), { errorMessage: 'CHAT_WRITE_FORBIDDEN' });
  await assert.rejects(callMtproto(undefined, 'messages.getHistory', { peer: 'me' }), /CHAT_WRITE_FORBIDDEN/);
  requestError.errorMessage = fakeHash;
  await assert.rejects(callMtproto(undefined, 'messages.getHistory', { peer: 'me' }), error => !error.message.includes(fakeHash));
});

test('unauthorized session is rejected and disconnected', async () => {
  authorized = false;
  await assert.rejects(withMtproto(undefined, async () => 'unused'), /not authorized/);
  assert.equal(clients[0].disconnected, true);
});

test('multiple accounts without a default require explicit identity', async () => {
  process.env.TELEGRAM_ACCOUNTS_JSON = JSON.stringify({ one: { session: fakeSession, apiId: 1, apiHash: fakeHash }, two: { session: fakeSession, apiId: 1, apiHash: fakeHash } });
  await assert.rejects(getMtprotoMe(), /specify an alias/);
  assert.equal(clients.length, 0);
});

test('defense-in-depth serializer never calls toJSON or getters', () => {
  let calls = 0;
  class Raw { toJSON() { calls++; return { token: 'SECRET' }; } }
  const object = { safe: 'ok', raw: new Raw(), get secret() { calls++; return 'SECRET'; } };
  assert.deepEqual(redactConfiguredSecrets(object, []), { safe: 'ok', raw: undefined });
  assert.equal(calls, 0);
  assert.equal(redactConfiguredSecrets({ self: { self: { self: {} } } }, [], 9), undefined);
});

test('deadline covers pending connect and late completion cannot execute the operation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let release,ran=false;
 const pending=new Promise(resolve=>{release=resolve});t.mock.method(FakeClient.prototype,'connect',()=>pending);
 const operation=withMtproto(undefined,async()=>{ran=true;return 'late'});const rejected=assert.rejects(operation,/timed out.*unconfirmed/);
 t.mock.timers.tick(30000);await rejected;assert.equal(clients[0].disconnected,true);
 release();await new Promise(setImmediate);assert.equal(ran,false);
});
test('deadline covers authorization, RPC and stalled cleanup without returning late results',async t=>{
 for(const stage of ['auth','rpc','cleanup']){
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=new Promise(()=>{});
  if(stage==='auth')t.mock.method(FakeClient.prototype,'isUserAuthorized',()=>pending);
  if(stage==='cleanup')t.mock.method(FakeClient.prototype,'disconnect',()=>pending);
  const operation=withMtproto(undefined,async()=>stage==='rpc'?pending:'complete');const rejected=assert.rejects(operation,/timed out/);
  await new Promise(setImmediate);t.mock.timers.tick(30000);await rejected;
  t.mock.restoreAll();t.mock.timers.reset();
 }
});
test('configuration revocation after connection prevents operation and disables background reconnect',async t=>{
 t.mock.method(FakeClient.prototype,'connect',async()=>{process.env.TELEGRAM_MTPROTO_ENABLED='false'});
 let ran=false;await assert.rejects(withMtproto(undefined,async()=>{ran=true}),/configuration changed/);
 assert.equal(ran,false);assert.equal(clients[0].disconnected,true);assert.equal(clients[0].options.autoReconnect,false);assert.equal(clients[0].options.floodSleepThreshold,0);
});

test('configuration change during cleanup blocks result release',async t=>{
 t.mock.method(FakeClient.prototype,'disconnect',async()=>{process.env.TELEGRAM_MTPROTO_ENABLED='false'});
 await assert.rejects(getMtprotoMe(),/configuration changed/);
});
