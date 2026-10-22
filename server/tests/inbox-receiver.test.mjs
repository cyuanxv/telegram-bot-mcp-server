import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxConfig, inboxPolicyGuard } from '../lib/telegram/inbox/config.ts';
import { decimalId, normalizedUpdate, validateInboxEvent } from '../lib/telegram/inbox/normalize.ts';
import { handleWebhook, readWebhookBody, webhookSecretMatches } from '../lib/telegram/inbox/receiver.ts';
const secret = 'synthetic_webhook_secret_1234567890';
const policy = { secretToken: secret, allowedChatIds: ['-10012345'], retainText: true, retentionDays: 7 };
const config = { bots: { reports: policy } };
const update = { update_id: 10, message: { message_id: 20, date: 1000, chat: { id: -10012345 }, from: { id: 123 }, text: 'sensitive example text' } };
function request(body = update, headers = {}, method = 'POST') { return new Request('https://example.invalid/api/telegram/webhook/reports', { method, headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret, ...headers }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) }); }
function storeFactory(result = 'stored') { let calls = 0, closes = 0, captured; return { open: async () => { calls++; return { store: { record: async event => { captured = event; return result; } }, close: () => closes++ }; }, calls: () => calls, closes: () => closes, captured: () => captured }; }

test('receiver is default-off and does not open storage', async () => {
  const s = storeFactory(); assert.equal((await handleWebhook(request(), 'reports', undefined, s.open)).status, 503); assert.equal(s.calls(), 0);
});
test('constant-time digest comparison handles exact token, mismatches, overlong and merged headers', () => {
  assert.equal(webhookSecretMatches(secret, secret), true);
  for (const value of [null, '', 'wrong', 'x'.repeat(257), `${secret},${secret}`]) assert.equal(webhookSecretMatches(value, secret), false);
});
test('auth and method failures happen before parsing or storage', async () => {
  const s = storeFactory();
  assert.equal((await handleWebhook(request('{broken', { 'x-telegram-bot-api-secret-token': 'wrong' }), 'reports', config, s.open)).status, 401);
  assert.equal((await handleWebhook(request(), 'other', config, s.open)).status, 401);
  assert.equal((await handleWebhook(request(undefined, {}, 'GET'), 'reports', config, s.open)).status, 405);
  assert.equal(s.calls(), 0);
});
test('approved scoped update is projected and acknowledged only after persistence', async () => {
  const s = storeFactory(); const result = await handleWebhook(request(), 'reports', config, s.open, 1000000);
  assert.equal(result.status, 200); assert.equal((await result.json()).status, 'stored'); assert.equal(s.closes(), 1);
  assert.equal(s.captured().text, update.message.text); assert.equal(s.captured().senderId, '123');
  assert.equal(s.captured().chatId, '-10012345'); assert.equal(s.captured().expiresAt, 1000000 + 7 * 86400000);
});
test('scope rejects are acknowledged as ignored without storing unapproved chat data', async () => {
  const s = storeFactory(); const unapproved = structuredClone(update); unapproved.message.chat.id = -100999;
  const result = await handleWebhook(request(unapproved), 'reports', config, s.open); assert.equal((await result.json()).status, 'ignored'); assert.equal(s.calls(), 0);
});
test('unsupported update types are ignored and conflicting supported types are rejected', async () => {
  const s = storeFactory();
  assert.equal((await (await handleWebhook(request({ update_id: 11, callback_query: { data: 'not interpreted' } }), 'reports', config, s.open)).json()).status, 'ignored');
  assert.equal((await handleWebhook(request({ ...update, edited_message: update.message }), 'reports', config, s.open)).status, 400); assert.equal(s.calls(), 0);
});
test('metadata-only policy never retains text, captions or raw third-party fields', () => {
  const event = normalizedUpdate({ ...update, message: { ...update.message, extraSecret: 'provider-private', entities: [{ type: 'phone_number' }] } }, 'reports', { ...policy, retainText: false }, 1000000);
  assert.equal(event.text, undefined); assert.ok(!JSON.stringify(event).includes('sensitive')); assert.ok(!JSON.stringify(event).includes('provider-private'));
});
test('decimal parser preserves string 64-bit IDs and rejects rounded JSON numbers', () => {
  assert.equal(decimalId('9223372036854775807'), '9223372036854775807');
  assert.equal(decimalId('-9223372036854775808', 'chat'), '-9223372036854775808');
  for (const value of [9007199254740993, '9223372036854775808', '-9223372036854775809', '01', '1e3', '-0', '0', 1.5]) assert.throws(() => decimalId(value));
  const large = normalizedUpdate({ update_id: '9223372036854775807', message: { ...update.message, message_id: '9007199254740993' } }, 'reports', policy, 1000000);
  assert.equal(large.updateId, '9223372036854775807'); assert.equal(large.messageId, '9007199254740993');
});
test('unsafe numeric IDs and malformed dates/body text fail before storage', async () => {
  const s = storeFactory();
  for (const body of [{ ...update, update_id: '9223372036854775808' }, { ...update, message: { ...update.message, date: -1 } }, { ...update, message: { ...update.message, text: '\ud800' } }]) assert.equal((await handleWebhook(request(body), 'reports', config, s.open)).status, 400);
  assert.equal(s.calls(), 0);
});
test('raw body budget rejects declared oversized, actual oversized, compressed and invalid UTF-8 payloads', async () => {
  const s = storeFactory();
  for (const [r, status] of [[request('a', { 'content-length': '1048577' }), 413], [request('x'.repeat(1048577)), 413], [request('{}', { 'content-encoding': 'gzip' }), 415], [request('{}', { 'content-type': 'text/plain' }), 415]]) assert.equal((await handleWebhook(r, 'reports', config, s.open)).status, status);
  const badUtf8 = new Request('https://example.invalid', { method: 'POST', headers: { 'content-type': 'application/json' }, body: new Uint8Array([0xff]) });
  await assert.rejects(readWebhookBody(badUtf8)); assert.equal(s.calls(), 0);
});
test('stalled body and infinite zero-length chunks are bounded and cancelled', async () => {
  let cancelled = false;
  const stalled = new Request('https://example.invalid', { method: 'POST', headers: { 'content-type': 'application/json' }, body: new ReadableStream({ cancel() { cancelled = true; } }), duplex: 'half' });
  await assert.rejects(readWebhookBody(stalled, 20, 5)); assert.equal(cancelled, true);
  let reads = 0;
  const empty = new Request('https://example.invalid', { method: 'POST', headers: { 'content-type': 'application/json' }, body: new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array()); } }), duplex: 'half' });
  await assert.rejects(readWebhookBody(empty)); assert.ok(reads <= 8195);
});
test('persistence failure is sanitized and never acknowledged as received', async () => {
  const result = await handleWebhook(request(), 'reports', config, async () => { throw new Error('postgres://private-secret'); });
  assert.equal(result.status, 503); assert.ok(!(await result.text()).includes('private-secret'));
});
test('duplicate acknowledgments and conflicting-ID rejections do not expose payloads', async () => {
  for (const [outcome, status] of [['duplicate', 200], ['conflict', 409]]) { const result = await handleWebhook(request(), 'reports', config, storeFactory(outcome).open); assert.equal(result.status, status); assert.ok(!(await result.text()).includes(update.message.text)); }
});
test('configuration requires explicit retention scope and per-bot chat/text settings', () => {
  assert.equal(inboxConfig({}), undefined);
  assert.throws(() => inboxConfig({ TELEGRAM_WEBHOOK_ENABLED: 'true' }), /retention/);
  const env = { TELEGRAM_WEBHOOK_ENABLED: 'true', TELEGRAM_WEBHOOK_RETENTION_APPROVED: 'true', TELEGRAM_WEBHOOK_BOTS_JSON: JSON.stringify({ reports: policy }) };
  assert.equal(inboxConfig(env).bots.reports.retentionDays, 7);
  for (const patch of [{ secretToken: 'short' }, { retentionDays: 31 }, { retainText: undefined }, { allowedChatIds: [-10012345] }, { allowedChatIds: ['-10012345', '-10012345'] }]) assert.throws(() => inboxConfig({ ...env, TELEGRAM_WEBHOOK_BOTS_JSON: JSON.stringify({ reports: { ...policy, ...patch } }) }));
});
test('event fingerprint survives JSON key reorder while refusing modified or unknown fields', () => {
  const event = normalizedUpdate(update, 'reports', policy, 1000000);
  validateInboxEvent(Object.fromEntries(Object.entries(event).reverse()));
  assert.throws(() => validateInboxEvent({ ...event, text: 'changed' }));
  assert.throws(() => validateInboxEvent({ ...event, rawSecret: 'not allowed' }));
});
test('Business updates require a separately scoped connection, not just the same chat ID', async () => {
  const payload = { update_id: 11, business_message: { ...update.message, business_connection_id: 'connection_A' } };
  const ignored = storeFactory(); assert.equal((await (await handleWebhook(request(payload), 'reports', config, ignored.open)).json()).status, 'ignored'); assert.equal(ignored.calls(), 0);
  const approved = { bots: { reports: { ...policy, allowedBusinessConnectionIds: ['connection_A'] } } };
  const s = storeFactory(); assert.equal((await handleWebhook(request(payload), 'reports', approved, s.open)).status, 200); assert.equal(s.captured().businessConnectionId, 'connection_A');
  const missing = { update_id: 12, business_message: update.message }; assert.equal((await handleWebhook(request(missing), 'reports', approved, s.open)).status, 400);
});

test('raw JSON integer ID lexemes retain all 64 bits and fractional/exponent tokens are rejected', async () => {
  const s = storeFactory();
  const raw = '{"update_id":9223372036854775807,"message":{"message_id":9007199254740993,"date":1000,"chat":{"id":-10012345},"text":"example"}}';
  assert.equal((await handleWebhook(request(raw), 'reports', config, s.open, 1000000)).status, 200);
  assert.equal(s.captured().updateId, '9223372036854775807'); assert.equal(s.captured().messageId, '9007199254740993');
  for (const token of ['9007199254740991.1', '9007199254740990.5', '1.0000000000000001', '1e3', '9223372036854775808']) {
    const invalid = raw.replace('9223372036854775807', token); const probe = storeFactory();
    assert.equal((await handleWebhook(request(invalid), 'reports', config, probe.open, 1000000)).status, 400); assert.equal(probe.calls(), 0);
  }
});

test('default inbox onboarding requires explicit retention and never widens JSON scope', t => {
 const keys=['TELEGRAM_CHAT_ID','TELEGRAM_CHATS_JSON','TELEGRAM_BOT_TOKEN','TELEGRAM_BOTS_JSON'];
 const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k]}});
 delete process.env.TELEGRAM_CHATS_JSON;delete process.env.TELEGRAM_BOTS_JSON;
 process.env.TELEGRAM_CHAT_ID='-100555';process.env.TELEGRAM_BOT_TOKEN='synthetic-token';
 const env={TELEGRAM_CHAT_ID:'-100555',TELEGRAM_BOT_TOKEN:'synthetic-token',TELEGRAM_WEBHOOK_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_INBOX_ALLOW_DEFAULT_DESTINATION:'true',TELEGRAM_INBOX_DEFAULT_WEBHOOK_SECRET:'synthetic_secret_12345678901234567890',TELEGRAM_INBOX_DEFAULT_RETAIN_TEXT:'true',TELEGRAM_INBOX_DEFAULT_RETENTION_DAYS:'7'};
 assert.deepEqual(inboxConfig(env).bots.default.allowedChatIds,['-100555']);
 assert.equal(inboxConfig(env).bots.default.retentionDays,7);
 for(const patch of [{TELEGRAM_WEBHOOK_RETENTION_APPROVED:'false'},{TELEGRAM_INBOX_ALLOW_DEFAULT_DESTINATION:'false'},{TELEGRAM_INBOX_DEFAULT_RETAIN_TEXT:undefined},{TELEGRAM_INBOX_DEFAULT_RETENTION_DAYS:'31'},{TELEGRAM_INBOX_DEFAULT_RETENTION_DAYS:'7.0'},{TELEGRAM_INBOX_DEFAULT_WEBHOOK_SECRET:'short'}])assert.throws(()=>inboxConfig({...env,...patch}));
 const selected=inboxConfig({...env,TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({reports:policy})});
 assert.equal(selected.bots.default,undefined);assert.ok(selected.bots.reports);
 env.TELEGRAM_CHAT_ID='-100556';assert.deepEqual(inboxConfig(env).bots.default.allowedChatIds,['-100556']);
 delete env.TELEGRAM_CHAT_ID;assert.throws(()=>inboxConfig(env),/not configured/);
});

const callback = {update_id:50,callback_query:{id:'opaque-query-id',from:{id:333,first_name:'not retained'},message:{message_id:20,date:0,chat:{id:-10012345},text:'original message must not leak'},data:'button:yes',chat_instance:'not retained'}};
test('callbacks require explicit opt-in, are scoped before storage and never retain original message or profile',async()=>{
 const off=storeFactory();assert.equal((await (await handleWebhook(request(callback),'reports',config,off.open)).json()).status,'ignored');assert.equal(off.calls(),0);
 const on={bots:{reports:{...policy,acceptCallbacks:true}}}, s=storeFactory();
 assert.equal((await handleWebhook(request(callback),'reports',on,s.open,1000000)).status,200);
 const e=s.captured();assert.equal(e.updateType,'callback_query');assert.equal(e.senderId,'333');assert.equal(e.callbackQueryId,'opaque-query-id');assert.equal(e.text,'button:yes');assert.equal(e.messageDate,0);assert.equal(e.expiresAt,1000000+7*86400000);validateInboxEvent(e);
 assert.ok(!JSON.stringify(e).includes('original message'));assert.ok(!JSON.stringify(e).includes('not retained'));
 for(const q of [{...callback.callback_query,message:undefined,inline_message_id:'inline'},{...callback.callback_query,game_short_name:'game'},{...callback.callback_query,message:{...callback.callback_query.message,business_connection_id:'unapproved'}},{...callback.callback_query,message:{...callback.callback_query.message,chat:{id:-999}}}]){const store=storeFactory();assert.equal((await (await handleWebhook(request({...callback,callback_query:q}),'reports',on,store.open)).json()).status,'ignored');assert.equal(store.calls(),0)}
});
test('callback data is UTF8-byte bounded and metadata-only policy drops it',()=>{
 const enabled={...policy,acceptCallbacks:true};
 const event=normalizedUpdate(callback,'reports',{...enabled,retainText:false},1000000);assert.equal(event.text,undefined);validateInboxEvent(event);
 for(const data of ['', '😀'.repeat(17),'\ud800',32])assert.throws(()=>normalizedUpdate({...callback,callback_query:{...callback.callback_query,data}},'reports',enabled,1000000));
 const valid=normalizedUpdate({...callback,callback_query:{...callback.callback_query,data:'😀'.repeat(16)}},'reports',enabled,1000000);validateInboxEvent(valid);
 assert.throws(()=>validateInboxEvent({...valid,callbackQueryId:'changed'}),/fingerprint/);
 assert.throws(()=>validateInboxEvent({...valid,callbackQueryId:undefined}));
 assert.throws(()=>normalizedUpdate({...callback,message:update.message},'reports',enabled,1000000),/Ambiguous/);
});
test('callback opt-in must be a boolean and is preserved in explicit per-bot policy',()=>{
 const base={TELEGRAM_WEBHOOK_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true'};
 for(const acceptCallbacks of [true,false])assert.equal(inboxConfig({...base,TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({reports:{...policy,acceptCallbacks}})}).bots.reports.acceptCallbacks,acceptCallbacks);
 assert.throws(()=>inboxConfig({...base,TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({reports:{...policy,acceptCallbacks:'true'}})}));
});


function guardedConfig(){return {TELEGRAM_WEBHOOK_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({reports:policy})}}
test('receiver guard binds one Bot and notices revocation, retention and secret changes',()=>{
 const original=guardedConfig();let live={...original};const guard=inboxPolicyGuard(()=>live,'reports',inboxConfig(live).bots.reports);guard();
 for(const patch of [{TELEGRAM_WEBHOOK_ENABLED:'false'},{TELEGRAM_WEBHOOK_RETENTION_APPROVED:'false'},...[{retainText:false},{retentionDays:1},{secretToken:'different_123456789012345678901234'},{allowedChatIds:['-999']}].map(p=>({TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({reports:{...policy,...p}})}))]){live={...original,...patch};assert.throws(guard)}
 live={...original,TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({reports:policy,other:{...policy,allowedChatIds:['-999']}})};guard();
 assert.throws(inboxPolicyGuard(()=>original,'unknown',undefined));assert.throws(inboxPolicyGuard(()=>original,'reports',inboxConfig(original).bots.reports,AbortSignal.abort()),/cancelled/);
});
test('revocation while resource opens prevents record and always closes it',async()=>{
 let live=guardedConfig(),records=0,closes=0;const cfg=inboxConfig(live),guard=inboxPolicyGuard(()=>live,'reports',cfg.bots.reports);
 const r=await handleWebhook(request(),'reports',cfg,async()=>{live={};return {store:{record:async()=>{records++}},close:async()=>{closes++}}},1000000,undefined,guard);
 assert.equal(r.status,503);assert.equal(records,0);assert.equal(closes,1);
});
test('handler returning unhandled after revocation cannot fall through into inbox persistence',async()=>{
 let live=guardedConfig();const cfg=inboxConfig(live),s=storeFactory(),guard=inboxPolicyGuard(()=>live,'reports',cfg.bots.reports);
 const r=await handleWebhook(request(),'reports',cfg,s.open,1000000,async()=>{live={};return undefined},guard);assert.equal(r.status,503);assert.equal((await r.json()).status,'receiver_policy_changed');assert.equal(s.calls(),0);
});
test('guarded SQL rolls back a pending inbox insert when policy changes before commit',async()=>{
 const {PgPoolDatabase}=await import('../lib/telegram/delivery/pg-pool-adapter.ts');const {PostgresInboxStore}=await import('../lib/telegram/inbox/postgres-inbox.ts');
 let live=guardedConfig(),released=0;const cfg=inboxConfig(live),guard=inboxPolicyGuard(()=>live,'reports',cfg.bots.reports),commands=[];
 const client={release:()=>{released++},query:async(q)=>{commands.push(q);if(q.startsWith('INSERT'))live={};return {rows:q.startsWith('SELECT COUNT')?[{n:'0'}]:[],command:q==='COMMIT'?'COMMIT':undefined}}};
 const store=new PostgresInboxStore(new PgPoolDatabase({connect:async()=>client},{guard}));
 const r=await handleWebhook(request(),'reports',cfg,async()=>({store,close:async()=>{}}),1000000,undefined,guard);assert.equal(r.status,503);assert.ok(commands.some(q=>q.startsWith('INSERT')));assert.ok(commands.includes('ROLLBACK'));assert.ok(!commands.includes('COMMIT'));assert.equal(released,1);
});

 test('explicit default inbox destinations reuse secret and require exact valid scope',()=>{
 const env={TELEGRAM_CHAT_ID:'-100555',TELEGRAM_BOT_TOKEN:'synthetic-token',TELEGRAM_WEBHOOK_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_INBOX_ALLOW_DEFAULT_DESTINATION:'true',TELEGRAM_INBOX_DEFAULT_WEBHOOK_SECRET:'synthetic_secret_12345678901234567890',TELEGRAM_INBOX_DEFAULT_RETAIN_TEXT:'true',TELEGRAM_INBOX_DEFAULT_RETENTION_DAYS:'7'};
 const key='TELEGRAM_INBOX_DEFAULT_ALLOWED_CHAT_IDS_JSON';
 assert.deepEqual(inboxConfig({...env,[key]:'["-100555","123"]'}).bots.default.allowedChatIds,['-100555','123']);
 for(const value of ['null','{}','[]','["123"]','["-100555","-100555"]','["-100555",123]','["-100555","*"]','bad'])assert.throws(()=>inboxConfig({...env,[key]:value}));
 const explicit={default:{secretToken:env.TELEGRAM_INBOX_DEFAULT_WEBHOOK_SECRET,allowedChatIds:['-100555'],retainText:true,retentionDays:7}};
 assert.deepEqual(inboxConfig({...env,[key]:'["-100555","123"]',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify(explicit)}).bots.default.allowedChatIds,['-100555']);
 });
