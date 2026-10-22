import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sendFileOnce,getFileSendStatus} from '../lib/telegram/delivery/media-send.ts';
const bytes=Buffer.from('synthetic file');
const input={bot_alias:'default',chat:'reports',kind:'document',filename:'test.txt',content_type:'text/plain',base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),idempotency_key:'test:1'};
function setup({failSend=false,failSettle=false,failCommit=false}={}){
 const env={TELEGRAM_WORKFLOW_MCP_ENABLED:'true',TELEGRAM_MEDIA_DEDUP_ENABLED:'true',TELEGRAM_MEDIA_BYTES_ENABLED:'true',TELEGRAM_MEDIA_ALLOWED_DESTINATIONS_JSON:JSON.stringify([{botAlias:'default',chatId:'123'}])};
 const rows=new Map();let sends=0,closed=0;
 const ledger={get:async k=>rows.get(k),claim:async x=>{if(failCommit)throw Error('commit lost');const prior=rows.get(x.key);if(prior){if(prior.fingerprint!==x.fingerprint)throw Error('conflict');return prior}rows.set(x.key,{...x,state:'inflight'});return {state:'claimed'}},settle:async(k,f,s,id)=>{if(failSettle)throw Error('db unavailable');rows.set(k,{fingerprint:f,state:s,messageId:id})}};
 const deps={env:()=>env,registry:()=>({bots:['default'],chats:{reports:'123'}}),open:async guard=>{guard();return {mediaLedger:ledger,close:async()=>{closed++}}},call:async()=>{assert.ok(closed>0);sends++;if(failSend)throw Error('private transport detail');return {bot:'default',result:{message_id:44,chat:{id:123}}}}};
 return {env,rows,deps,count:()=>sends};
}
test('committed file claim survives repeated and concurrent calls with at most one upload',async()=>{
 const f=setup();const results=await Promise.all(Array.from({length:12},()=>sendFileOnce(input,f.deps)));assert.equal(f.count(),1);assert.ok(results.some(r=>r.sent===true));
 const again=await sendFileOnce(input,f.deps);assert.equal(again.reused,true);assert.equal(again.message_id,44);assert.equal(f.count(),1);
 await assert.rejects(sendFileOnce({...input,caption:'changed'},f.deps),/key conflict/);assert.equal(f.count(),1);
});
test('lost upload or settlement stays occupied and never retries',async()=>{
 for(const settings of [{failSend:true},{failSettle:true}]){const f=setup(settings);await sendFileOnce(input,f.deps);const again=await sendFileOnce(input,f.deps);assert.equal(again.status,'delivery_unconfirmed');assert.equal(f.count(),1)}
});
test('failed claim acknowledgement never uploads',async()=>{const f=setup({failCommit:true});await assert.rejects(sendFileOnce(input,f.deps),/no new upload/);assert.equal(f.count(),0)});
test('hash and field errors are rejected before claiming or uploading',async()=>{
 for(const patch of [{sha256:'0'.repeat(64)},{filename:'../bad'},{business_connection_id:'x'},{kind:'sticker',caption:'x'}]){const f=setup();await assert.rejects(sendFileOnce({...input,...patch},f.deps));assert.equal(f.rows.size,0);assert.equal(f.count(),0)}
});
test('revocation after claim closes resources and prevents dispatch',async()=>{
 const f=setup();const open=f.deps.open;f.deps.open=async guard=>{const r=await open(guard);return {...r,close:async()=>{await r.close();f.env.TELEGRAM_MEDIA_DEDUP_ENABLED='false'}}};
 await assert.rejects(sendFileOnce(input,f.deps),/disabled/);assert.equal(f.count(),0);assert.equal(f.rows.size,1);
});
test('default-disabled path refuses before storage',async()=>{const f=setup();delete f.env.TELEGRAM_MEDIA_DEDUP_ENABLED;await assert.rejects(sendFileOnce(input,f.deps),/disabled/);assert.equal(f.rows.size,0)});

test('status returns persisted receipt with upload disabled and does not claim or send',async()=>{
 const f=setup();await sendFileOnce(input,f.deps);f.env.TELEGRAM_MEDIA_DEDUP_ENABLED='false';f.env.TELEGRAM_MEDIA_BYTES_ENABLED='false';
 const r=await getFileSendStatus({bot_alias:input.bot_alias,idempotency_key:input.idempotency_key},f.deps);assert.equal(r.status,'sent');assert.equal(r.message_id,44);assert.equal(f.count(),1);assert.equal(f.rows.size,1);
 const missing=await getFileSendStatus({bot_alias:'default',idempotency_key:'unused'},f.deps);assert.equal(missing.status,'not_found');assert.equal(f.rows.size,1);
});
test('status hides state after revocation and never releases a receipt to another bot',async()=>{
 const f=setup();await sendFileOnce(input,f.deps);
 await assert.rejects(getFileSendStatus({bot_alias:'other',idempotency_key:input.idempotency_key},f.deps),/Unconfigured/);
 const open=f.deps.open;f.deps.open=async guard=>{const r=await open(guard);return {...r,close:async()=>{await r.close();f.env.TELEGRAM_WORKFLOW_MCP_ENABLED='false'}}};
 await assert.rejects(getFileSendStatus({bot_alias:'default',idempotency_key:input.idempotency_key},f.deps),/disabled/);assert.equal(f.count(),1);
});

test('wrong destination and missing or mismatched topic never become persisted success',async()=>{
 for(const result of [{message_id:44},{message_id:44,chat:{id:999},message_thread_id:7},{message_id:44,chat:{id:123}},{message_id:44,chat:{id:123},message_thread_id:8}]){
  const f=setup();let sends=0;f.deps.call=async()=>{sends++;return {bot:'default',result}};
  const r=await sendFileOnce({...input,message_thread_id:7},f.deps);assert.equal(r.sent,null);assert.equal([...f.rows.values()][0].state,'unknown');
  await sendFileOnce({...input,message_thread_id:7},f.deps);assert.equal(sends,1);
 }
 const f=setup();f.deps.call=async()=>({bot:'default',result:{message_id:44,chat:{id:123},message_thread_id:7}});assert.equal((await sendFileOnce({...input,message_thread_id:7},f.deps)).sent,true);
});
test('file formatting is part of persistent identity and cannot be changed on replay',async()=>{
 const f=setup();await sendFileOnce({...input,caption:'<b>hello</b>',parse_mode:'HTML'},f.deps);
 await assert.rejects(sendFileOnce({...input,caption:'<b>hello</b>',parse_mode:'MarkdownV2'},f.deps),/key conflict/);assert.equal(f.count(),1);
 const g=setup();await assert.rejects(sendFileOnce({...input,parse_mode:'HTML'},g.deps),/Invalid/);assert.equal(g.count(),0);
});
