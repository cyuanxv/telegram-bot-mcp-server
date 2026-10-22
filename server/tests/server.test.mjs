import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { test, beforeEach, after, mock } from 'node:test';
import { dailySnapshot } from './report-compose-fixture.mjs';

const registered = new Map();
const mtCalls = [];
let delegatedRequests = 0;
let accountInventoryFailure=false;
mock.module('mcp-handler', { namedExports: { createMcpHandler(register) {
  register({ registerTool(name, config, callback) { registered.set(name, { config, callback }); } });
  return async () => { delegatedRequests++; return new Response('mock MCP transport'); };
} } });
const noMtproto = async () => { throw new Error('MTProto network is disabled in unit tests'); };
mock.module('../lib/telegram/mtproto.ts', { namedExports: {
  callMtproto: async (account, method, args) => { mtCalls.push({ account, method, args }); return {}; }, getMtprotoMe: noMtproto, listConfiguredAccounts: async () => {if(accountInventoryFailure)throw Error('account_inventory_unavailable');return []},
  listDialogs: noMtproto, searchMtprotoMessages: noMtproto, sendMtprotoMessage: noMtproto,
} });

const { POST } = await import('../app/api/mcp/route.ts');
const { callBotApi } = await import('../lib/telegram/bot-api.ts');
const { getBots, getChats, resolveBot, resolveChat, getAccounts } = await import('../lib/telegram/config.ts');
const keys = ['MCP_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_BOTS_JSON', 'TELEGRAM_CHATS_JSON', 'TELEGRAM_ACCOUNTS_JSON', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_MEDIA_BYTES_ENABLED', 'TELEGRAM_MEDIA_ALLOWED_DESTINATIONS_JSON'];
const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const calls = [];
const fakeToken = 'TEST_ONLY_FAKE_BOT_TOKEN';

beforeEach(() => {
  for (const key of keys) delete process.env[key];
  process.env.TELEGRAM_BOT_TOKEN = fakeToken;
  process.env.TELEGRAM_CHAT_ID = '-100001';
  delegatedRequests = 0;
  calls.length = 0;
  mtCalls.length = 0;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options, params: typeof options?.body === 'string' ? JSON.parse(options.body) : null });
    return Response.json({ ok: true, result: { message_id: 7 } });
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function invoke(name, args) {
  const tool = registered.get(name);
  return tool.callback(tool.config.inputSchema.parse(args));
}
function unpack(result) { return JSON.parse(result.content[0].text); }

test('registers the actual 51 tools without contacting Telegram', () => {
  assert.equal(registered.size, 51);
  assert.ok(registered.has('send_file_once'));
  assert.ok(registered.has('manage_bot_avatar'));
  assert(registered.has('inspect_default_inbox'));
  assert(registered.has('connect_default_inbox'));
  assert(registered.has('answer_inbox_callback'));
  assert(registered.has('business'));
  assert(registered.has('call_mtproto'));
  assert.equal(calls.length, 0);
});

test('compose_daily_report is a usable readonly tool with no config or transport dependency', async () => {
  process.env.TELEGRAM_BOTS_JSON = '{invalid-config-not-read';
  const result = unpack(await invoke('compose_daily_report', dailySnapshot()));
  assert.equal(result.metrics.openrouter_cost.value, 'USD 1.234567891');
  assert.equal(result.sent, false); assert.equal(result.persisted, false); assert.equal(result.enqueued, false);
  assert.equal(registered.get('compose_daily_report').config.annotations.readOnlyHint, true);
  assert.equal(calls.length, 0); assert.equal(mtCalls.length, 0);
});

test('fails closed when the MCP key is absent or blank', async () => {
  for (const value of [undefined, '', '   ']) {
    if (value === undefined) delete process.env.MCP_API_KEY; else process.env.MCP_API_KEY = value;
    assert.equal((await POST(new Request('https://unit.test/api/mcp'))).status, 503);
  }
  assert.equal(delegatedRequests, 0);
});

test('rejects missing or wrong auth and accepts the exact configured key', async () => {
  const testBearer = randomBytes(32).toString('hex');
  process.env.MCP_API_KEY = testBearer;
  for (const authorization of ['', 'Bearer wrong']) {
    assert.equal((await POST(new Request('https://unit.test/api/mcp', { headers: { authorization } }))).status, 401);
  }
  assert.equal(delegatedRequests, 0);
  assert.equal((await POST(new Request('https://unit.test/api/mcp', { headers: { authorization: `Bearer ${testBearer}` } }))).status, 200);
  assert.equal(delegatedRequests, 1);
});

test('preserves legacy defaults and resolves multiple bot/chat aliases', () => {
  process.env.TELEGRAM_BOTS_JSON = JSON.stringify({ support: { token: 'TEST_SUPPORT', label: 'Support' } });
  process.env.TELEGRAM_CHATS_JSON = JSON.stringify({ support: '-100002' });
  assert.equal(resolveBot().config.token, fakeToken);
  assert.equal(resolveBot('support').config.token, 'TEST_SUPPORT');
  assert.equal(resolveChat(), '-100001');
  assert.equal(resolveChat('support'), '-100002');
  assert.equal(resolveChat('@channel'), '@channel');
  assert.throws(() => resolveBot('missing'), /Unknown bot alias/);
});

test('malformed configured JSON is rejected instead of silently falling back', () => {
  for (const [key, read] of [['TELEGRAM_BOTS_JSON', getBots], ['TELEGRAM_CHATS_JSON', getChats], ['TELEGRAM_ACCOUNTS_JSON', getAccounts]]) {
    process.env[key] = '{broken';
    assert.throws(read, /configuration|JSON|object/i);
    delete process.env[key];
  }
});

test('configured maps reject null and arrays', () => {
  for (const value of ['null', '[]']) {
    process.env.TELEGRAM_BOTS_JSON = value;
    assert.throws(getBots, /configuration|object/i);
  }
});

test('send_message preserves optional false and reply/thread settings', async () => {
  const result = unpack(await invoke('send_message', { text: 'test', disable_notification: false, protect_content: false, message_thread_id: 2, reply_to_message_id: 3 }));
  assert.equal(result.result.message_id, 7);
  assert.deepEqual(calls[0].params, { chat_id: '-100001', text: 'test', disable_notification: false, protect_content: false, message_thread_id: 2, reply_parameters: { message_id: 3 } });
});

test('send_media cannot override the explicitly selected chat via params', async () => {
  await invoke('send_media', { method: 'sendPhoto', chat: '-100001', params: { photo: 'file_id', chat_id: '-100999' } });
  assert.equal(calls[0].params.chat_id, '-100001');
});

test('managed access cannot silently disable restrictions', async () => {
  const result = await invoke('managed_bot_access', { user_id: 42, action: 'set' });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

test('managed access uses the official added_user_ids field', async () => {
  await invoke('managed_bot_access', { user_id: 42, action: 'set', is_access_restricted: true, allowed_user_ids: [5] });
  assert.deepEqual(calls[0].params, { user_id: 42, is_access_restricted: true, added_user_ids: [5] });
});

test('token-returning Bot methods are blocked before a network call', async () => {
  for (const method of ['getManagedBotToken', 'replaceManagedBotToken', 'GETMANAGEDBOTTOKEN']) {
    await assert.rejects(callBotApi(undefined, method, { user_id: 42 }), /credential|secure|token/i);
  }
  assert.equal(calls.length, 0);
});

test('ambiguous bots without an explicit default require an alias', () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOTS_JSON = JSON.stringify({ one: 'FAKE_ONE', two: 'FAKE_TWO' });
  assert.throws(() => resolveBot(), /specify an alias/);
  assert.equal(resolveBot('two').config.token, 'FAKE_TWO');
});

test('inherited object property names cannot become chat destinations', () => {
  assert.equal(resolveChat('toString'), 'toString');
  assert.equal(resolveChat('__proto__'), '__proto__');
  assert.throws(() => resolveBot('toString'), /Unknown bot alias/);
});

test('server-side attachments are rejected before any network request', async () => {
  await assert.rejects(callBotApi(undefined, 'sendPhoto', {}, { photo: { url: 'http://127.0.0.1/private' } }), /attachment.*disabled/i);
  assert.equal(calls.length, 0);
});

test('fetch failures never expose the Bot token from the endpoint URL', async () => {
  globalThis.fetch = async url => { throw new Error(`failed ${url}`); };
  await assert.rejects(callBotApi(undefined, 'getMe'), error => !error.message.includes(fakeToken) && /network/.test(error.message));
});

test('Managed Bot mutations are unavailable before reaching the MTProto caller', async () => {
  const created = await invoke('create_managed_bot', { name: 'test', username: 'test_bot', manager_id: { _: 'inputUserSelf' }, via_deeplink: true });
  const edited = await invoke('edit_managed_bot', { bot: { _: 'inputUserSelf' }, lang_code: 'en', about: 'test' });
  assert.equal(created.isError, true);
  assert.equal(edited.isError, true);
  assert.equal(mtCalls.length, 0);
});

test('Bot API errors and rate-limit metadata survive without automatic retries', async () => {
  globalThis.fetch = async (...args) => { calls.push(args); return Response.json({ ok: false, description: 'Too Many Requests', error_code: 429, parameters: { retry_after: 30 } }, { status: 429 }); };
  await assert.rejects(callBotApi(undefined, 'sendMessage', {}), error => error.message === 'Too Many Requests' && error.telegram.parameters.retry_after === 30);
  assert.equal(calls.length, 1);
});

test('invalid method strings never initiate network requests', async () => {
  await assert.rejects(callBotApi(undefined, '../getMe'), /Invalid/);
  assert.equal(calls.length, 0);
});

test('Business passthrough retains the explicit business connection and chat', async () => {
  await invoke('business', { method: 'sendMessage', params: { business_connection_id: 'test-connection', chat_id: '-100001', text: 'test' } });
  assert.deepEqual(calls[0].params, { business_connection_id: 'test-connection', chat_id: '-100001', text: 'test' });
});


test('plan_report prepares Unicode-safe chunks without reading config or sending', async () => {
  process.env.TELEGRAM_BOTS_JSON = '{broken';
  const result = unpack(await invoke('plan_report', { text: '日报🙂'.repeat(1000), max_chunk_length: 100 }));
  assert.equal(result.sent, false);
  assert.equal(result.chunks.map(x => x.text).join(''), '日报🙂'.repeat(1000));
  assert.equal(calls.length, 0);
  assert.equal(registered.get('plan_report').config.annotations.readOnlyHint, true);
});

test('MCP exposes sanitized retry metadata without raw provider descriptions or automatic sends', async () => {
  globalThis.fetch = async () => { calls.push({}); return Response.json({ ok: false, description: fakeToken, error_code: 429, parameters: { retry_after: 45 }, extra: fakeToken }, { status: 429 }); };
  const result = await invoke('send_message', { text: 'report' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.retry_after_seconds, 45);
  assert.equal(result.structuredContent.error.delivery_unknown, false);
  assert.equal(result.structuredContent.error.automatic_retry_performed, false);
  assert(!JSON.stringify(result).includes(fakeToken));
  assert.equal(calls.length, 1);
});

test('byte upload MCP preserves explicit destination and rejects disabled or numeric targets', async () => {
  const args = { bot_alias: 'default', method: 'sendDocument', chat: '-100001', params: { chat_id: '-100999', document: 'attach://upload1' }, files: [{ field_name: 'upload1', filename: 'example.txt', base64: 'ZXhhbXBsZQ==' }] };
  const disabled = await invoke('send_media_bytes', args); assert.equal(disabled.isError, true); assert.equal(calls.length, 0);
  await assert.rejects(invoke('send_media_bytes', { ...args, chat: 9007199254740992 }));
  process.env.TELEGRAM_MEDIA_BYTES_ENABLED = 'true'; process.env.TELEGRAM_MEDIA_ALLOWED_DESTINATIONS_JSON = JSON.stringify([{ botAlias: 'default', chatId: '-100001' }]);
  const sent = await invoke('send_media_bytes', args); assert.equal(sent.isError, undefined); assert.equal(calls.length, 1);
  assert.equal(calls[0].options.body.get('chat_id'), '-100001');
});

test('workflow MCP tools exist and are default-disabled before real storage or sends', async () => {
  delete process.env.TELEGRAM_WORKFLOW_MCP_ENABLED;
  const id = '00000000-0000-4000-8000-000000000000';
  for (const [name, args] of [['draft_report', { bot_alias: 'reports', chat: '-100001', text: 'test', idempotency_key: 'test' }], ['get_report_status', { id }], ['enqueue_report', { id, fingerprint: 'a'.repeat(64) }], ['dispatch_report_chunk', { id, fingerprint: 'a'.repeat(64) }], ['recover_report', { id }], ['read_inbox', { bot_alias: 'reports' }]]) {
    const result = await invoke(name, args); assert.equal(result.isError, true); assert.match(result.content[0].text, /disabled/);
  }
  assert.equal(calls.length, 0);
});


test('Business inspection projects only connection state and known rights, without writes or user data', async () => {
  globalThis.fetch = async (url, options) => {
    calls.push({url:String(url),params:JSON.parse(options.body)});
    return Response.json({ok:true,result:{id:'connection_A',date:123,is_enabled:true,rights:{can_reply:true,can_read_messages:true,unknown_secret:'hidden'},user:{id:42,first_name:'private'},user_chat_id:99}});
  };
  const result=unpack(await invoke('inspect_business_connection',{bot_alias:'default',business_connection_id:'connection_A'}));
  assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/getBusinessConnection'));
  assert.deepEqual(calls[0].params,{business_connection_id:'connection_A'});
  assert.equal(result.rights.can_reply,true);assert.equal(result.rights.can_transfer_stars,false);
  assert.equal(result.message_history_access_verified,false);assert.equal(result.sent,false);
  assert.equal(JSON.stringify(result).includes('private'),false);assert.equal(JSON.stringify(result).includes('hidden'),false);
  assert.equal(Object.hasOwn(result,'user_chat_id'),false);
  assert.equal(registered.get('inspect_business_connection').config.annotations.readOnlyHint,true);
});

test('Business inspection distinguishes unavailable rights and disabled connection', async () => {
  globalThis.fetch=async()=>Response.json({ok:true,result:{id:'x',date:0,is_enabled:false}});
  const result=unpack(await invoke('inspect_business_connection',{bot_alias:'default',business_connection_id:'x'}));
  assert.equal(result.is_enabled,false);assert.equal(result.rights_available,false);
  assert.ok(Object.values(result.rights).every(x=>x===null));
});

test('Business inspection rejects malformed or mismatched responses without exposing them', async () => {
  for(const patch of [{id:'wrong'},{is_enabled:'yes'},{date:-1},{rights:[]},{rights:{can_reply:'secret'}}]){
    globalThis.fetch=async()=>Response.json({ok:true,result:{id:'x',date:1,is_enabled:true,...patch,user:{first_name:'private'}}});
    const result=await invoke('inspect_business_connection',{bot_alias:'default',business_connection_id:'x'});
    assert.equal(result.isError,true);assert.equal(JSON.stringify(result).includes('private'),false);assert.equal(JSON.stringify(result).includes('secret'),false);
  }
});

test('Business inspection rejects extra write parameters and unconfigured aliases before network', async () => {
  await assert.rejects(invoke('inspect_business_connection',{bot_alias:'default',business_connection_id:'x',method:'sendMessage'}));
  await assert.rejects(invoke('inspect_business_connection',{bot_alias:'default',business_connection_id:''}));
  const result=await invoke('inspect_business_connection',{bot_alias:'missing',business_connection_id:'x'});
  assert.equal(result.isError,true);assert.equal(calls.length,0);
});

test('account listing awaits cloud inventory and reports unavailable storage as a tool error',async()=>{
 assert.deepEqual(unpack(await invoke('list_accounts',{})),{accounts:[]});
 accountInventoryFailure=true;
 try{const result=await invoke('list_accounts',{});assert.equal(result.isError,true);assert.equal(result.content[0].text,'account_inventory_unavailable')}finally{accountInventoryFailure=false}
});
