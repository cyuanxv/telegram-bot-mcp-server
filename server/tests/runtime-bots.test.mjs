import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {sealCredential} from '../lib/telegram/vault/crypto.ts';
import {resolveRuntimeBot,listRuntimeBots} from '../lib/telegram/vault/runtime-bots.ts';
const token='12345:'+randomBytes(24).toString('base64url');
function setup(){const key=randomBytes(32),env={TELEGRAM_VAULT_BOTS_ENABLED:'true',TELEGRAM_VAULT_OWNER_ID:'owner-A',TELEGRAM_VAULT_KEY_ID:'k',TELEGRAM_VAULT_KEY_BASE64:key.toString('base64')};const envelope=sealCredential({ownerId:'owner-A',alias:'reports',purpose:'bot_token'},{token},new Map([['k',key]]),'k',{revision:1,createdAt:Date.now()});const entry={alias:'reports',botId:12345,vaultRevision:1,revision:1,active:true};let opened=0,closed=0;const deps={env:()=>env,open:async()=>{opened++;return {directory:{loadActive:async(owner,alias)=>owner==='owner-A'&&alias==='reports'?{entry,envelope}:undefined,listActive:async()=>[entry]},close:async()=>{closed++}}}};return {env,entry,envelope,deps,counts:()=>({opened,closed})}}
test('runtime is opt-in and explicit alias only; environment default stays authoritative',async()=>{
 const s=setup();s.env.TELEGRAM_BOT_TOKEN='synthetic-default';assert.equal((await resolveRuntimeBot(undefined,s.deps)).config.token,'synthetic-default');assert.deepEqual(s.counts(),{opened:0,closed:0});
 s.env.TELEGRAM_VAULT_BOTS_ENABLED='false';await assert.rejects(resolveRuntimeBot('reports',s.deps),/bot_unavailable/);assert.deepEqual(await listRuntimeBots(s.deps),[{alias:'default',label:'Default bot'}]);assert.equal(s.counts().opened,0);
});
test('inventory exposes only aliases; credential resolution closes before release and does not cache',async()=>{
 const s=setup();assert.deepEqual(await listRuntimeBots(s.deps),[{alias:'reports',label:undefined}]);const a=await resolveRuntimeBot('reports',s.deps);assert.equal(a.config.token,token);await resolveRuntimeBot('reports',s.deps);assert.deepEqual(s.counts(),{opened:3,closed:3});
 s.env.TELEGRAM_BOTS_JSON=JSON.stringify({reports:'environment-priority'});assert.equal((await resolveRuntimeBot('reports',s.deps)).config.token,'environment-priority');assert.deepEqual(await listRuntimeBots(s.deps),[{alias:'reports',label:undefined}]);
});
test('missing activation, mismatched identity and wrong owner/key reject without exposing credentials',async()=>{
 const s=setup();await assert.rejects(resolveRuntimeBot('missing',s.deps),/bot_unavailable/);s.entry.botId=999;await assert.rejects(resolveRuntimeBot('reports',s.deps),/bot_identity_mismatch/);s.entry.botId=12345;s.env.TELEGRAM_VAULT_KEY_BASE64=randomBytes(32).toString('base64');await assert.rejects(resolveRuntimeBot('reports',s.deps),/credential_unavailable/);s.env.TELEGRAM_VAULT_OWNER_ID='owner-B';await assert.rejects(resolveRuntimeBot('reports',s.deps),/bot_unavailable/);
});
test('revocation, cancellation and resource failures before release fail closed',async()=>{
 for(const cause of ['revocation','cancel','close']){const s=setup(),controller=new AbortController();const original=s.deps.open;s.deps.signal=controller.signal;s.deps.open=async(...a)=>{const resource=await original(...a);resource.close=async()=>{if(cause==='revocation')s.env.TELEGRAM_VAULT_BOTS_ENABLED='false';if(cause==='cancel')controller.abort();if(cause==='close')throw Error(token)};return resource};await assert.rejects(resolveRuntimeBot('reports',s.deps),e=>!e.message.includes(token)&&/configuration_changed|runtime_unavailable/.test(e.message))}
});

test('persistent runtime verifies exact scope binding and method/destination before releasing credentials',async()=>{
 const s=setup();s.env.TELEGRAM_VAULT_SCOPE_STORE_ENABLED='true';s.entry.scopeRevision=2;
 const scope={alias:'reports',botId:12345,vaultRevision:1,revision:2,policy:{methods:['sendMessage'],chat_ids:['-123']}};
 const open=s.deps.open;s.deps.open=async(...a)=>({...await open(...a),scope:{get:async()=>scope}});
 const request={method:'sendMessage',params:{chat_id:-123,text:'test'}};
 assert.equal((await resolveRuntimeBot('reports',{...s.deps,request})).config.token,token);
 await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request:{...request,params:{chat_id:-999}}}),/scope_denied/);
 await assert.rejects(resolveRuntimeBot('reports',s.deps),/scope_unavailable/);
 scope.revision=3;await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request}),/scope_unavailable/);
 scope.revision=2;scope.vaultRevision=2;await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request}),/scope_unavailable/);
});

test('vault inbox connector requires active persistent binding and approved receiver chats without opening generic webhook calls',async()=>{
 const s=setup();s.env.TELEGRAM_VAULT_SCOPE_STORE_ENABLED='true';s.entry.scopeRevision=2;
 const scope={alias:'reports',botId:12345,vaultRevision:1,revision:2,policy:{methods:['getMe'],chat_ids:['-123']}};
 const open=s.deps.open;s.deps.open=async(...a)=>({...await open(...a),scope:{get:async()=>scope}});
 Object.assign(s.env,{TELEGRAM_WEBHOOK_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({reports:{secretToken:'synthetic_123456789012345678901234',allowedChatIds:['-123'],retainText:true,retentionDays:7}})});
 const request={method:'getWebhookInfo',params:{},purpose:'inbox_control'};
 assert.equal((await resolveRuntimeBot('reports',{...s.deps,request})).alias,'reports');
 await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request:{method:'getWebhookInfo',params:{}}}),/scope_denied/);
 await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request:{...request,method:'sendMessage',params:{chat_id:-123,text:'x'}}}),/scope_denied/);
 scope.policy.chat_ids=['-999'];await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request}),/scope_denied/);scope.policy.chat_ids=['-123'];
 s.entry.scopeRevision=3;await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request}),/scope_unavailable/);s.entry.scopeRevision=2;
 s.env.TELEGRAM_VAULT_SCOPE_STORE_ENABLED='false';await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request}),/scope_unavailable/);
});


test('deactivation and revision changes during scope lookup cannot release old credentials',async()=>{
 for(const change of ['missing','inactive','revision','botId','vaultRevision','scopeRevision','alias']){
  const s=setup();s.env.TELEGRAM_VAULT_SCOPE_STORE_ENABLED='true';s.entry.scopeRevision=2;
  const open=s.deps.open;let loads=0,closed=0;
  s.deps.open=async(...a)=>{
   const resource=await open(...a);const original=resource.directory.loadActive;
   return {...resource,directory:{...resource.directory,loadActive:async(...args)=>{
    loads++;if(loads===2){if(change==='missing')return undefined;if(change==='inactive')s.entry.active=false;else if(change==='alias')s.entry.alias='other';else s.entry[change]++;}
    return original(...args);
   }},scope:{get:async()=>({botId:12345,vaultRevision:1,revision:2,policy:{methods:['getMe'],chat_ids:[]}})},close:async()=>{closed++;await resource.close()}};
  };
  await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request:{method:'getMe',params:{}}}),/bot_state_changed/);
  assert.equal(loads,2);assert.equal(closed,1);
 }
});
test('final activation check also applies when persistent scope storage is disabled',async()=>{
 const s=setup(),open=s.deps.open;let loads=0;
 s.deps.open=async(...args)=>{const r=await open(...args),original=r.directory.loadActive;return {...r,directory:{...r.directory,loadActive:async(...a)=>++loads===1?original(...a):undefined}}};
 await assert.rejects(resolveRuntimeBot('reports',s.deps),/bot_state_changed/);assert.equal(loads,2);
});


test('runtime reads old-key credentials during an explicit bounded key transition',async()=>{
 const s=setup();const old=s.env.TELEGRAM_VAULT_KEY_BASE64;
 s.env.TELEGRAM_VAULT_KEY_ID='new';s.env.TELEGRAM_VAULT_KEY_BASE64=randomBytes(32).toString('base64');
 s.env.TELEGRAM_VAULT_PREVIOUS_KEYS_JSON=JSON.stringify({k:old});
 assert.equal((await resolveRuntimeBot('reports',s.deps)).config.token,token);
 delete s.env.TELEGRAM_VAULT_PREVIOUS_KEYS_JSON;
 await assert.rejects(resolveRuntimeBot('reports',s.deps),/key_unavailable|credential_unavailable/);
});

test('vault avatar binds persistent activation, individual permissions and own Bot identity',async()=>{
 const s=setup();Object.assign(s.env,{TELEGRAM_VAULT_SCOPE_STORE_ENABLED:'true',TELEGRAM_AVATAR_WRITE_ENABLED:'true',TELEGRAM_AVATAR_BOTS_JSON:'["reports"]'});s.entry.scopeRevision=2;
 const scope={botId:12345,vaultRevision:1,revision:2,policy:{methods:['getMe','getUserProfilePhotos','setMyProfilePhoto'],chat_ids:[]}};
 const open=s.deps.open;s.deps.open=async(...a)=>({...await open(...a),scope:{get:async()=>scope}});
 const request={method:'getUserProfilePhotos',params:{user_id:'12345',offset:0,limit:1},purpose:'avatar_control',expectedBotId:'12345'};
 assert.equal((await resolveRuntimeBot('reports',{...s.deps,request})).alias,'reports');
 for(const patch of [{purpose:undefined},{expectedBotId:'999'},{params:{user_id:'999',offset:0,limit:1}},{params:{user_id:'12345',offset:0,limit:10}},{method:'sendMessage',params:{chat_id:1,text:'x'}}])await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request:{...request,...patch}}),/scope_denied/);
 const write={...request,method:'setMyProfilePhoto',params:{photo:{type:'static',photo:'attach://avatar_file'}}};
 assert.equal((await resolveRuntimeBot('reports',{...s.deps,request:write})).alias,'reports');
 await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request:{...write,method:'removeMyProfilePhoto',params:{}}}),/scope_denied/);
 s.env.TELEGRAM_AVATAR_WRITE_ENABLED='false';await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request:write}),/scope_denied/);
 assert.equal((await resolveRuntimeBot('reports',{...s.deps,request})).alias,'reports');
 s.env.TELEGRAM_VAULT_SCOPE_STORE_ENABLED='false';await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request}),/scope_unavailable/);
});

test('stored callback answer requires its independent persistent permission and event chat context',async()=>{
 const s=setup();s.env.TELEGRAM_VAULT_SCOPE_STORE_ENABLED='true';s.entry.scopeRevision=2;
 const scope={alias:'reports',botId:12345,vaultRevision:1,revision:2,policy:{methods:['answerCallbackQuery'],chat_ids:['-123']}};
 const open=s.deps.open;s.deps.open=async(...a)=>({...await open(...a),scope:{get:async()=>scope}});
 Object.assign(s.env,{TELEGRAM_WORKFLOW_MCP_ENABLED:'true',TELEGRAM_CALLBACK_ANSWER_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({reports:{secretToken:'synthetic_callback_1234567890123456',allowedChatIds:['-123'],retainText:true,retentionDays:7,acceptCallbacks:true}})});
 const request={method:'answerCallbackQuery',purpose:'callback_answer',params:{chat_id:'-123',callback_query_id:'from-storage',text:'ok',show_alert:false,cache_time:0}};
 assert.equal((await resolveRuntimeBot('reports',{...s.deps,request})).alias,'reports');
 await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request:{...request,purpose:undefined}}),/scope_denied/);
 await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request:{...request,params:{...request.params,chat_id:'-999'}}}),/scope_denied/);
 scope.policy.methods=['sendMessage'];await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request}),/scope_denied/);
 scope.policy.methods=['answerCallbackQuery'];s.env.TELEGRAM_CALLBACK_ANSWER_ENABLED='false';await assert.rejects(resolveRuntimeBot('reports',{...s.deps,request}),/scope_denied/);
});
