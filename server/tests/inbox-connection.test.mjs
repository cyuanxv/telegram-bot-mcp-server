import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDefaultInbox, connectDefaultInbox, inspectBotInbox, connectBotInbox } from '../lib/telegram/inbox/connection.ts';
const endpoint='https://backend.example.invalid/api/telegram/webhook/default';
const env={TELEGRAM_WEBHOOK_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({default:{secretToken:'synthetic_1234567890123456789012345',allowedChatIds:['-100123'],retainText:true,retentionDays:7}})};
const response=(url='',pending=0)=>({bot:'default',result:{url,pending_update_count:pending}});
test('inspection projects status without exposing private URLs',async()=>{
 const result=await inspectDefaultInbox(async()=>response('https://private.invalid/secret-token'));
 assert.equal(result.webhook,'other_service');assert.ok(!JSON.stringify(result).includes('secret-token'));
});
test('existing webhook and pending backlog are preserved without registration',async()=>{
 for(const r of [response(endpoint),response('https://other.invalid'),response('',3),{bot:'default',result:{url:''}}]){
  const calls=[];await connectDefaultInbox(()=>env,async(m)=>{calls.push(m);return r});
  assert.deepEqual(calls,['getWebhookInfo']);
 }
});
test('registration validates policy before network and rechecks after inspection',async()=>{
 let calls=0;await assert.rejects(connectDefaultInbox(()=>({}),async()=>{calls++}),/configured/);assert.equal(calls,0);
 let live={...env};await assert.rejects(connectDefaultInbox(()=>live,async()=>{live={};return response()}),/configuration changed/);
});
test('registration sends fixed scope once and verifies readback',async()=>{
 const calls=[];const result=await connectDefaultInbox(()=>env,async(m,p)=>{calls.push({m,p});return m==='setWebhook'?{bot:'default',result:true}:response(calls.length===1?'':endpoint)});
 assert.equal(result.status,'registered');assert.equal(calls.filter(x=>x.m==='setWebhook').length,1);
 const params=calls[1].p;assert.equal(params.url,endpoint);assert.equal(params.drop_pending_updates,false);assert.ok(!params.allowed_updates.includes('business_message'));
});
test('uncertain registration never retries',async()=>{
 const calls=[];await assert.rejects(connectDefaultInbox(()=>env,async m=>{calls.push(m);if(m==='setWebhook')throw Error('uncertain');return response()}));
 assert.deepEqual(calls,['getWebhookInfo','setWebhook']);
});

test('production adapter handles the actual normalized Bot API envelope',async t=>{
 const oldFetch=globalThis.fetch,oldToken=process.env.TELEGRAM_BOT_TOKEN,oldBots=process.env.TELEGRAM_BOTS_JSON;
 t.after(()=>{globalThis.fetch=oldFetch;for(const [k,v] of [['TELEGRAM_BOT_TOKEN',oldToken],['TELEGRAM_BOTS_JSON',oldBots]]){if(v===undefined)delete process.env[k];else process.env[k]=v}});
 process.env.TELEGRAM_BOT_TOKEN='synthetic-token';delete process.env.TELEGRAM_BOTS_JSON;
 let calls=0;globalThis.fetch=async(url,opts)=>{calls++;assert.ok(url.endsWith('/getWebhookInfo'));assert.equal(opts.method,'POST');return Response.json({ok:true,result:{url:'',pending_update_count:0}})};
 assert.deepEqual(await inspectDefaultInbox(),{destination:'default',webhook:'absent',pending_updates:0,delivery_error_recorded:false,last_delivery_error_at_unix_seconds:null});assert.equal(calls,1);
});


test('delivery diagnostics expose only bounded time and presence, never provider text',async()=>{
 const r=await inspectDefaultInbox(async()=>({bot:'default',result:{url:endpoint,pending_update_count:2,last_error_date:1791680000,last_error_message:'https://private.invalid/secret-token unauthorized'}}));
 assert.equal(r.delivery_error_recorded,true);assert.equal(r.last_delivery_error_at_unix_seconds,1791680000);assert.equal(r.pending_updates,2);assert.ok(!JSON.stringify(r).includes('secret-token'));assert.ok(!JSON.stringify(r).includes('unauthorized'));
});
test('malformed diagnostic timestamps and counts remain unknown without coercion',async()=>{
 for(const value of ['123',-1,1.5,Number.MAX_SAFE_INTEGER+1,null]){
  const r=await inspectDefaultInbox(async()=>({bot:'default',result:{url:endpoint,pending_update_count:value,last_error_date:value,last_error_message:{secret:'never returned'}}}));
  assert.equal(r.last_delivery_error_at_unix_seconds,null);assert.equal(r.pending_updates,null);assert.equal(r.delivery_error_recorded,false);
 }
});

test('new webhook registration includes callbacks only when explicitly enabled',async()=>{
 for(const acceptCallbacks of [undefined,false,true]){
  const p=JSON.parse(env.TELEGRAM_WEBHOOK_BOTS_JSON);p.default.acceptCallbacks=acceptCallbacks;
  const configured={...env,TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify(p)};const calls=[];
  await connectDefaultInbox(()=>configured,async(m,a)=>{calls.push({m,a});return m==='setWebhook'?{bot:'default',result:true}:response(calls.length===1?'':endpoint)});
  assert.equal(calls[1].a.allowed_updates.includes('callback_query'),acceptCallbacks===true);assert.equal(calls[1].a.drop_pending_updates,false);
 }
});


test('selected Bot uses its own endpoint and secret without changing default scope',async()=>{
 const policies=JSON.parse(env.TELEGRAM_WEBHOOK_BOTS_JSON);policies.reports={...policies.default,secretToken:'other_secret_12345678901234567890',allowedChatIds:['-100456']};
 const configured={...env,TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify(policies)},calls=[];const url=endpoint.replace('/default','/reports');
 const result=await connectBotInbox('reports',()=>configured,async(m,p)=>{calls.push({m,p});return {bot:'reports',result:m==='setWebhook'?true:{url:calls.length===1?'':url,pending_update_count:0}}});
 assert.equal(result.destination,'reports');assert.equal(result.status,'registered');assert.equal(calls[1].p.url,url);assert.equal(calls[1].p.secret_token,policies.reports.secretToken);assert.equal(calls[1].p.drop_pending_updates,false);assert.ok(!JSON.stringify(result).includes('other_secret'));
});
test('wrong Bot envelope and another Bot endpoint cannot be mistaken for selected Bot registration',async()=>{
 await assert.rejects(inspectBotInbox('reports',async()=>response(endpoint)),/Invalid webhook status/);
 const result=await inspectBotInbox('reports',async()=>({bot:'reports',result:{url:endpoint,pending_update_count:0}}));assert.equal(result.webhook,'other_service');
});
test('unknown aliases, URL path aliases and cancellation make no registration request',async()=>{
 let calls=0;const call=async()=>{calls++;return response()};
 for(const alias of ['../default','..','.','default?x','default/other',''])await assert.rejects(inspectBotInbox(alias,call),/Invalid inbox Bot alias/);
 await assert.rejects(connectBotInbox('reports',()=>env,call),/configured/);
 await assert.rejects(connectBotInbox('default',()=>env,call,AbortSignal.abort()),/cancelled/);assert.equal(calls,0);
});
test('changed Bot credentials during inspection prevent registration even with unchanged receiver policy',async()=>{
 let live={...env,TELEGRAM_BOT_TOKEN:'first'},calls=[];await assert.rejects(connectBotInbox('default',()=>live,async m=>{calls.push(m);live={...live,TELEGRAM_BOT_TOKEN:'second'};return response()}),/configuration changed/);assert.deepEqual(calls,['getWebhookInfo']);
});
test('revocation after registration does not trigger a retry or cleanup write',async()=>{
 let live={...env},calls=[];await assert.rejects(connectBotInbox('default',()=>live,async m=>{calls.push(m);if(m==='setWebhook'){live={};return {bot:'default',result:true}}return response()}),/inspect before retrying/);assert.deepEqual(calls,['getWebhookInfo','setWebhook']);
});

test('explicit own-webhook subscription sync adds approved types without dropping backlog',async()=>{
 const settings={...env,TELEGRAM_INBOX_SYNC_APPROVED_UPDATES:'true'};const p=JSON.parse(settings.TELEGRAM_WEBHOOK_BOTS_JSON);p.default.acceptCallbacks=true;p.default.acceptDraftStops=true;settings.TELEGRAM_WEBHOOK_BOTS_JSON=JSON.stringify(p);
 let subscribed=['message','edited_message','channel_post','edited_channel_post'],calls=[];
 const result=await connectDefaultInbox(()=>settings,async(m,p)=>{calls.push(m);if(m==='setWebhook'){assert.equal(p.url,endpoint);assert.equal(p.drop_pending_updates,false);subscribed=p.allowed_updates;return {bot:'default',result:true}}return {bot:'default',result:{url:endpoint,pending_update_count:2,allowed_updates:subscribed}}});
 assert.equal(result.status,'subscriptions_synced');assert.ok(subscribed.includes('callback_query'));assert.ok(subscribed.includes('stopped_message_generation'));assert.equal(calls.filter(x=>x==='setWebhook').length,1);
 assert.equal((await connectDefaultInbox(()=>settings,async()=>({bot:'default',result:{url:endpoint,pending_update_count:0,allowed_updates:['business_message']}}))).status,'subscriptions_outside_policy_preserved');
 let count=0;const preserved=await connectDefaultInbox(()=>settings,async(m)=>{count++;assert.equal(m,'getWebhookInfo');return {bot:'default',result:{url:'https://other.invalid',allowed_updates:[]}}});assert.equal(preserved.changed,false);assert.equal(count,1);
});
