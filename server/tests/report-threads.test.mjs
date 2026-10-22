import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {ReportQueue} from '../lib/telegram/delivery/queue.ts';import {MemoryQueueStore,checkJob} from '../lib/telegram/delivery/store.ts';import {draftJob,reportFingerprint,enqueueJob} from '../lib/telegram/delivery/state.ts';import {BotApiDeliveryTransport} from '../lib/telegram/delivery/bot-transport.ts';
const input={botAlias:'default',chatId:'12345',text:'final',idempotencyKey:'stream-final-test'};
test('legacy fingerprint stays unchanged; thread changes require a different approved fingerprint',()=>{
 const legacy=createHash('sha256').update(JSON.stringify({version:1,format:'plain_text',botAlias:'default',chatId:'12345',chunks:['final']})).digest('hex');
 assert.equal(reportFingerprint('default','12345',['final']),legacy);
 const job=draftJob({...input,threadId:7},()=>1000);assert.notEqual(job.fingerprint,legacy);
 assert.throws(()=>enqueueJob({...job,threadId:8},job.fingerprint,()=>1000),/fingerprint/);
 for(const threadId of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,null])assert.throws(()=>draftJob({...input,threadId},()=>1000));
 assert.throws(()=>checkJob({...job,threadId:0}));
 const q=new ReportQueue(new MemoryQueueStore());q.draft({...input,threadId:7});assert.throws(()=>q.draft({...input,threadId:8}),/different content or destination/);
});
test('queue retains thread receipts and wrong or absent thread acknowledgements stay unknown without retry',async()=>{
 for(const receiptThread of [7,8,undefined]){
  const q=new ReportQueue(new MemoryQueueStore()),job=q.draft({...input,threadId:7});q.enqueue(job.id,job.fingerprint);let calls=0;
  const out=await q.dispatchNext(job.id,job.fingerprint,{send:async request=>{calls++;assert.equal(request.threadId,7);return {chatId:request.chatId,messageId:42,...(receiptThread===undefined?{}:{threadId:receiptThread})}}});
  assert.equal(out.state,receiptThread===7?'delivered':'unknown');assert.equal(calls,1);
  if(receiptThread!==7){assert.throws(()=>q.confirmUnknownDelivery(job.id,job.fingerprint,{chunkIndex:1,attemptId:out.chunks[0].attemptId,receipt:{chatId:'12345',messageId:42,threadId:8},evidenceReference:'manual'}),/destination/);await assert.rejects(q.dispatchNext(job.id,job.fingerprint,{send:()=>assert.fail()}));}
  else assert.equal(out.chunks[0].receipt.threadId,7);
 }
});
test('Bot transport emits exact thread and verifies Telegram thread readback',async t=>{
 const oldFetch=globalThis.fetch,oldToken=process.env.TELEGRAM_BOT_TOKEN,oldBots=process.env.TELEGRAM_BOTS_JSON;t.after(()=>{globalThis.fetch=oldFetch;for(const [key,value] of [['TELEGRAM_BOT_TOKEN',oldToken],['TELEGRAM_BOTS_JSON',oldBots]]){if(value===undefined)delete process.env[key];else process.env[key]=value}});delete process.env.TELEGRAM_BOTS_JSON;process.env.TELEGRAM_BOT_TOKEN='synthetic';
 const transport=new BotApiDeliveryTransport();let count=0;let returned=7;
 globalThis.fetch=async(_url,options)=>{count++;assert.equal(JSON.parse(options.body).message_thread_id,7);return Response.json({ok:true,result:{message_id:42,chat:{id:12345},message_thread_id:returned}})};
 const request={botAlias:'default',chatId:'12345',threadId:7,text:'final',attemptId:'x'};assert.deepEqual(await transport.send(request),{chatId:'12345',messageId:42,threadId:7});
 returned=8;await assert.rejects(transport.send(request),/outcome is unknown/);returned=undefined;await assert.rejects(transport.send(request),/outcome is unknown/);assert.equal(count,3);
});
