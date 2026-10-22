import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
let resolve;
process.env.TELEGRAM_VAULT_BOT_SCOPES_JSON=JSON.stringify({reports:{methods:["getMe","sendMessage"],chat_ids:["-123"]}});
mock.module('../lib/telegram/vault/runtime-bots.ts',{namedExports:{resolveRuntimeBot:(...args)=>resolve(...args)}});
const {callBotApi}=await import('../lib/telegram/bot-api.ts');
test('Bot API awaits resolved vault identity then dispatches once without exposing token',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});let calls=0;
 resolve=async(alias,options)=>{assert.equal(alias,'reports');assert.ok(options.signal);return {alias,config:{token:'synthetic-runtime-token'}}};
 globalThis.fetch=async(url)=>{calls++;assert.equal(url,'https://api.telegram.org/botsynthetic-runtime-token/getMe');return Response.json({ok:true,result:{id:12345}})};
 assert.deepEqual(await callBotApi('reports','getMe'),{bot:'reports',result:{id:12345}});assert.equal(calls,1);
});
test('revoked resolution and cancellation prevent Telegram dispatch',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});globalThis.fetch=async()=>assert.fail('must not send');
 resolve=async()=>{throw Error('Credential vault: bot_unavailable')};await assert.rejects(callBotApi('reports','sendMessage',{text:'test',chat_id:-123}),/bot_unavailable/);
 const controller=new AbortController();resolve=async()=>{controller.abort();return {alias:'reports',config:{token:'synthetic'}}};await assert.rejects(callBotApi('reports','sendMessage',{chat_id:-123}, {},{signal:controller.signal}),/cancelled/);
});
test('credential lookup shares the absolute deadline; a stalled resolver cannot start a late send',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});t.mock.timers.enable({apis:['setTimeout']});
 let resume,signal;resolve=async(alias,options)=>{signal=options.signal;return new Promise(r=>{resume=()=>r({alias,config:{token:'synthetic'}})})};globalThis.fetch=async()=>assert.fail('must not send after timeout');
 const pending=callBotApi('reports','sendMessage',{chat_id:-123});const rejected=assert.rejects(pending,e=>e.details?.code==='timeout');
 t.mock.timers.tick(30000);await rejected;assert.equal(signal.aborted,true);resume();await Promise.resolve();await Promise.resolve();
});

test('scope rejects before credential lookup and rechecks policy before actual fetch',async t=>{
 const original=globalThis.fetch,policy=process.env.TELEGRAM_VAULT_BOT_SCOPES_JSON;t.after(()=>{globalThis.fetch=original;process.env.TELEGRAM_VAULT_BOT_SCOPES_JSON=policy});
 globalThis.fetch=async()=>assert.fail('must not send');resolve=async()=>assert.fail('must not decrypt');
 await assert.rejects(callBotApi('reports','sendMessage',{chat_id:-999}),/scope denied/);
 resolve=async(alias)=>{delete process.env.TELEGRAM_VAULT_BOT_SCOPES_JSON;return {alias,config:{token:'synthetic'}}};
 await assert.rejects(callBotApi('reports','sendMessage',{chat_id:-123}),/scope denied/);
});


test('profile scope is checked before lookup and revoked scope prevents the write dispatch',async t=>{
 const original=globalThis.fetch,policy=process.env.TELEGRAM_VAULT_BOT_SCOPES_JSON;
 t.after(()=>{globalThis.fetch=original;process.env.TELEGRAM_VAULT_BOT_SCOPES_JSON=policy});
 const allow=()=>{process.env.TELEGRAM_VAULT_BOT_SCOPES_JSON=JSON.stringify({reports:{methods:['setMyName'],chat_ids:[]}})};
 let calls=0;allow();
 resolve=async()=>assert.fail('invalid fields must not decrypt');
 await assert.rejects(callBotApi('reports','setMyName',{name:'test',chat_id:123}),/scope denied/);
 resolve=async(alias)=>({alias,config:{token:'synthetic'}});
 globalThis.fetch=async(url,init)=>{calls++;assert.equal(url,'https://api.telegram.org/botsynthetic/setMyName');assert.deepEqual(JSON.parse(init.body),{name:'test'});return Response.json({ok:true,result:true})};
 assert.equal((await callBotApi('reports','setMyName',{name:'test'})).result,true);assert.equal(calls,1);
 resolve=async(alias)=>{delete process.env.TELEGRAM_VAULT_BOT_SCOPES_JSON;return {alias,config:{token:'synthetic'}}};
 await assert.rejects(callBotApi('reports','setMyName',{name:'test'}),/scope denied/);assert.equal(calls,1);
});

test('avatar transport sends internal purpose and expected identity, rejecting changes before multipart fetch',async t=>{
 const {callBotAvatarApi,callBotAvatarBytes}=await import('../lib/telegram/bot-api.ts');
 const {createHash}=await import('node:crypto');const bytes=Buffer.from([255,216,255,0,255,217]);const upload={kind:'static',base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
 const keys=['TELEGRAM_VAULT_BOTS_ENABLED','TELEGRAM_VAULT_SCOPE_STORE_ENABLED','TELEGRAM_AVATAR_WRITE_ENABLED','TELEGRAM_AVATAR_BOTS_JSON'];const before=Object.fromEntries(keys.map(k=>[k,process.env[k]])),old=globalThis.fetch;
 t.after(()=>{globalThis.fetch=old;for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k]}});
 Object.assign(process.env,{TELEGRAM_VAULT_BOTS_ENABLED:'true',TELEGRAM_VAULT_SCOPE_STORE_ENABLED:'true',TELEGRAM_AVATAR_WRITE_ENABLED:'true',TELEGRAM_AVATAR_BOTS_JSON:'["reports"]'});
 let calls=0;globalThis.fetch=async(_url,options)=>{calls++;assert.ok(options.body instanceof FormData);return Response.json({ok:true,result:true})};
 resolve=async(alias,options)=>{assert.equal(options.request.purpose,'avatar_control');assert.equal(options.request.expectedBotId,'12345');return {alias,config:{token:'12345:synthetic'}}};
 assert.equal((await callBotAvatarBytes('reports',upload,{expectedBotId:'12345'})).result,true);assert.equal(calls,1);
 resolve=async(alias)=>({alias,config:{token:'999:synthetic'}});await assert.rejects(callBotAvatarBytes('reports',upload,{expectedBotId:'12345'}),/identity changed/);assert.equal(calls,1);
 resolve=async(alias)=>{process.env.TELEGRAM_AVATAR_WRITE_ENABLED='false';return {alias,config:{token:'12345:synthetic'}}};await assert.rejects(callBotAvatarBytes('reports',upload,{expectedBotId:'12345'}),/disabled/);assert.equal(calls,1);
 await assert.rejects(callBotAvatarApi('reports','sendMessage',{chat_id:1,text:'x'}),/denied/);assert.equal(calls,1);
});


test('report queue accepts vault configuration but still resolves permissions for every send',async t=>{
 const {BotApiDeliveryTransport}=await import('../lib/telegram/delivery/bot-transport.ts');
 const {ReportQueue}=await import('../lib/telegram/delivery/queue.ts');
 const {MemoryQueueStore}=await import('../lib/telegram/delivery/store.ts');
 const before={...process.env};t.after(()=>{for(const k of Object.keys(process.env))if(k.startsWith('TELEGRAM_'))delete process.env[k];for(const [k,v]of Object.entries(before))if(k.startsWith('TELEGRAM_'))process.env[k]=v});
 for(const k of Object.keys(process.env))if(k.startsWith('TELEGRAM_'))delete process.env[k];
 Object.assign(process.env,{TELEGRAM_BOTS_JSON:'{}',TELEGRAM_VAULT_OWNER_ID:'test-owner',TELEGRAM_VAULT_BOT_SCOPES_JSON:JSON.stringify({reports:{methods:['sendMessage'],chat_ids:['-123']}})});
 const q=new ReportQueue(new MemoryQueueStore()),transport=new BotApiDeliveryTransport();
 const draft=(key,chatId='-123')=>{const j=q.draft({botAlias:'reports',chatId,text:'synthetic report',idempotencyKey:key});q.enqueue(j.id,j.fingerprint);return j};
 let sends=0,lookups=0;t.mock.method(globalThis,'fetch',async(_url,init)=>{sends++;assert.equal(JSON.parse(init.body).chat_id,'-123');return Response.json({ok:true,result:{message_id:45,chat:{id:-123}}})});
 resolve=async(alias,options)=>{lookups++;assert.equal(options.request.method,'sendMessage');assert.equal(options.request.params.chat_id,'-123');return {alias,config:{token:'synthetic'}}};
 const j=draft('vault-disabled');await assert.rejects(q.dispatchNext(j.id,j.fingerprint,transport),/no delivery was attempted/);assert.equal(q.get(j.id).chunks[0].attempts,0);
 process.env.TELEGRAM_VAULT_BOTS_ENABLED='true';
 const wrong=draft('wrong-target','-999');await assert.rejects(q.dispatchNext(wrong.id,wrong.fingerprint,transport),/no delivery was attempted/);assert.equal(lookups,0);
 assert.equal((await q.dispatchNext(j.id,j.fingerprint,transport)).state,'delivered');assert.equal(sends,1);assert.equal(lookups,1);
 // Persistent policy mode delegates the final check to the real resolver;
 // a revoked binding must never reach Telegram or be automatically retried.
 process.env.TELEGRAM_VAULT_SCOPE_STORE_ENABLED='true';resolve=async()=>{throw Error('revoked')};
 const revoked=draft('revoked-vault');assert.equal((await q.dispatchNext(revoked.id,revoked.fingerprint,transport)).state,'unknown');assert.equal(sends,1);
 await assert.rejects(q.dispatchNext(revoked.id,revoked.fingerprint,transport));assert.equal(sends,1);
});

test('stored callback channel binds internal chat but sends only Telegram answer fields',async t=>{
 const {callStoredCallbackAnswer}=await import('../lib/telegram/bot-api.ts');const before={...process.env};
 t.after(()=>{for(const k of Object.keys(process.env))if(k.startsWith('TELEGRAM_'))delete process.env[k];for(const[k,v]of Object.entries(before))if(k.startsWith('TELEGRAM_'))process.env[k]=v});
 Object.assign(process.env,{TELEGRAM_VAULT_SCOPE_STORE_ENABLED:'true',TELEGRAM_WORKFLOW_MCP_ENABLED:'true',TELEGRAM_CALLBACK_ANSWER_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({reports:{secretToken:'synthetic_callback_1234567890123456',allowedChatIds:['-123'],retainText:true,retentionDays:7,acceptCallbacks:true}})});
 const params={callback_query_id:'from-storage',text:'ok',show_alert:false,cache_time:0};let calls=0;
 resolve=async(alias,options)=>{assert.equal(options.request.purpose,'callback_answer');assert.equal(options.request.params.chat_id,'-123');return {alias,config:{token:'synthetic'}}};
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls++;assert.match(url,/answerCallbackQuery$/);assert.deepEqual(JSON.parse(options.body),params);return Response.json({ok:true,result:true})});
 assert.equal((await callStoredCallbackAnswer('reports',params,{chatId:'-123'})).result,true);assert.equal(calls,1);
 await assert.rejects(callStoredCallbackAnswer('reports',params,{chatId:'-999'}));
 resolve=async alias=>{process.env.TELEGRAM_CALLBACK_ANSWER_ENABLED='false';return {alias,config:{token:'synthetic'}}};
 await assert.rejects(callStoredCallbackAnswer('reports',params,{chatId:'-123'}));assert.equal(calls,1);
});
