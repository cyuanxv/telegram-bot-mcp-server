import test,{mock} from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
let inventory,resolve;
mock.module('../lib/telegram/vault/runtime-bots.ts',{namedExports:{listRuntimeBots:(...a)=>inventory(...a),resolveRuntimeBot:(...a)=>resolve(...a)}});
const {sendFileOnce,getFileSendStatus}=await import('../lib/telegram/delivery/media-send.ts');
const bytes=Buffer.from('synthetic');
const input={bot_alias:'child',chat:'test',kind:'document',filename:'test.txt',content_type:'text/plain',base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),idempotency_key:'test'};
function setup(t){
 const before={...process.env};t.after(()=>{for(const k of Object.keys(process.env))if(k.startsWith('TELEGRAM_'))delete process.env[k];for(const[k,v]of Object.entries(before))if(k.startsWith('TELEGRAM_'))process.env[k]=v});
 for(const k of Object.keys(process.env))if(k.startsWith('TELEGRAM_'))delete process.env[k];
 Object.assign(process.env,{TELEGRAM_BOTS_JSON:'{}',TELEGRAM_CHATS_JSON:'{"test":"123"}',TELEGRAM_VAULT_BOTS_ENABLED:'true',TELEGRAM_VAULT_SCOPE_STORE_ENABLED:'true',TELEGRAM_WORKFLOW_MCP_ENABLED:'true',TELEGRAM_MEDIA_DEDUP_ENABLED:'true',TELEGRAM_MEDIA_BYTES_ENABLED:'true',TELEGRAM_MEDIA_ALLOWED_DESTINATIONS_JSON:'[{"botAlias":"child","chatId":"123"}]'});
 let row,active=true,sends=0,lookups=0;
 inventory=async()=>active?[{alias:'child'}]:[];
 resolve=async(alias,opts)=>{lookups++;assert.equal(opts.request.method,'sendDocument');assert.equal(opts.request.params.chat_id,'123');if(!active)throw Error('revoked');return {alias,config:{token:'synthetic'}}};
 t.mock.method(globalThis,'fetch',async(_url,opts)=>{sends++;assert.ok(opts.body instanceof FormData);return Response.json({ok:true,result:{message_id:42,chat:{id:123}}})});
 const ledger={claim:async v=>{if(row)return row;row={...v,state:'inflight'};return {state:'claimed'}},settle:async(_k,_f,state,messageId)=>{row={...row,state,messageId}},get:async()=>row};
 const deps={open:async guard=>{guard();return {mediaLedger:ledger,close:async()=>{}}}};
 return {deps,ledger,revoke:()=>{active=false},counts:()=>({sends,lookups})};
}
test('directory-only Bot uploads through runtime credentials and returns stored receipt',async t=>{
 const s=setup(t);assert.equal((await sendFileOnce(input,s.deps)).sent,true);assert.deepEqual(s.counts(),{sends:1,lookups:1});assert.equal((await getFileSendStatus({bot_alias:'child',idempotency_key:'test'},s.deps)).message_id,42);
 s.revoke();await assert.rejects(getFileSendStatus({bot_alias:'child',idempotency_key:'test'},s.deps),/Unconfigured/);
});
test('activation loss after claim prevents actual upload; final inventory loss hides status',async t=>{
 const s=setup(t),claim=s.ledger.claim;s.ledger.claim=async v=>{const r=await claim(v);s.revoke();return r};
 assert.equal((await sendFileOnce(input,s.deps)).status,'delivery_unconfirmed');assert.equal(s.counts().sends,0);
 const fresh=setup(t);await sendFileOnce(input,fresh.deps);const get=fresh.ledger.get;fresh.ledger.get=async()=>{const r=await get();fresh.revoke();return r};
 await assert.rejects(getFileSendStatus({bot_alias:'child',idempotency_key:'test'},fresh.deps),/Unconfigured/);
});

test('media configuration revocation during credential resolution stops the multipart fetch',async t=>{
 const s=setup(t),original=resolve;
 resolve=async(...args)=>{const result=await original(...args);process.env.TELEGRAM_MEDIA_BYTES_ENABLED='false';return result};
 const result=await sendFileOnce(input,s.deps);assert.equal(result.status,'delivery_unconfirmed');assert.equal(s.counts().sends,0);
});

test('directory Bot callback message uses dedicated webhook control before scoped send',async t=>{
 const s=setup(t);const {sendCallbackMessage}=await import('../lib/telegram/inbox/send-callback.ts');
 Object.assign(process.env,{TELEGRAM_CALLBACK_SEND_ENABLED:'true',TELEGRAM_CALLBACK_ANSWER_ENABLED:'true',TELEGRAM_WEBHOOK_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({child:{secretToken:'synthetic_callback_1234567890123456',allowedChatIds:['123'],retainText:true,retentionDays:7,acceptCallbacks:true}})});
 const methods=[];resolve=async(alias,opts)=>{methods.push(opts.request.method);if(opts.request.method==='getWebhookInfo')assert.equal(opts.request.purpose,'inbox_control');else{assert.equal(opts.request.method,'sendMessage');assert.equal(opts.request.params.chat_id,'123')}return {alias,config:{token:'synthetic'}}};
 t.mock.method(globalThis,'fetch',async url=>Response.json({ok:true,result:String(url).endsWith('/getWebhookInfo')?{url:'https://backend.example.invalid/api/telegram/webhook/child',allowed_updates:['callback_query']}:{message_id:88,chat:{id:123}}}));
 const result=await sendCallbackMessage({bot_alias:'child',chat:'test',text:'test',buttons:[[{text:'ok',data:'ok'}]]},{open:async guard=>{guard();return {callbackAnswers:{assertReady:async()=>{}},close:async()=>{}}}});
 assert.equal(result.sent,true);assert.deepEqual(methods,['getWebhookInfo','sendMessage']);
});
