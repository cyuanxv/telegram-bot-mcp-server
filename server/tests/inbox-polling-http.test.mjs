import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';import {handlePolling} from '../lib/telegram/inbox/polling-http.ts';
const auth=randomBytes(32).toString('hex');
function config(){return {TELEGRAM_POLLING_ENABLED:'true',TELEGRAM_POLLING_AUTH:auth,TELEGRAM_VAULT_OWNER_ID:'telegram-cloud-owner',TELEGRAM_POLLING_BOT_ALIAS:'default',TELEGRAM_POLLING_BOT_ID:'456',TELEGRAM_BOT_TOKEN:'456:'+randomBytes(32).toString('hex'),TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({default:{secretToken:randomBytes(24).toString('hex'),allowedChatIds:['123'],retainText:true,retentionDays:7}})}}
const req=(extra={})=>new Request('https://test.invalid/api/internal/inbox/poll',{method:'POST',headers:{authorization:'Bearer '+auth},...extra});
test('disabled, unauthenticated, body input and webhook mode are stopped before external calls',async()=>{
 let calls=0;const fetcher=async()=>{calls++;throw Error('no call')};
 assert.equal((await handlePolling(req(),{env:()=>({}),fetcher})).status,503);
 const env=config();assert.equal((await handlePolling(req({headers:{authorization:'wrong'}}),{env:()=>env,fetcher})).status,401);
 assert.equal((await handlePolling(req({body:'{}'}),{env:()=>env,fetcher})).status,400);
 assert.equal((await handlePolling(req(),{env:()=>({...env,TELEGRAM_WEBHOOK_ENABLED:'true'}),fetcher})).status,503);assert.equal(calls,0);
});
test('live identity mismatch is sanitized and never opens database or polls',async()=>{
 const calls=[];let opened=0;const response=await handlePolling(req(),{env:()=>config(),open:async()=>{opened++;throw Error('unexpected')},fetcher:async url=>{calls.push(url.split('/').at(-1));return Response.json({ok:true,result:{id:999,is_bot:true}})}});
 assert.equal(response.status,503);assert.deepEqual(calls,[]);assert.equal(opened,0);
 // Stable configuration permits getMe; wrong identity still prevents storage.
 const env=config();const second=await handlePolling(req(),{env:()=>env,open:async()=>{opened++;throw Error('unexpected')},fetcher:async url=>{calls.push(url.split('/').at(-1));return Response.json({ok:true,result:{id:999,is_bot:true}})}});
 assert.equal(second.status,503);assert.deepEqual(calls,['getMe']);assert.equal(opened,0);assert.ok(!(await second.text()).includes('999'));
});
test('configured cloud invocation records one batch and exposes counts only',async t=>{
 const pg=new PGlite();t.after(()=>pg.close());for(const name of ['002_telegram_inbox.sql','015_polling_cursors.sql'])await pg.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const env=config(),calls=[];let closed=0;
 const response=await handlePolling(req(),{env:()=>env,open:async()=>({database:{transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))},close:async()=>{closed++}}),fetcher:async(url,options)=>{
  const method=url.split('/').at(-1);calls.push(method);assert.equal(options.redirect,'error');
  const result=method==='getMe'?{id:456,is_bot:true}:method==='getWebhookInfo'?{url:''}:[{update_id:1,message:{message_id:2,date:1,chat:{id:123},text:'private incoming text'}}];
  if(method==='getUpdates')assert.deepEqual(JSON.parse(options.body),{offset:0,limit:100,timeout:20,allowed_updates:['message','edited_message','channel_post','edited_channel_post']});
  return Response.json({ok:true,result});
 }});
 assert.equal(response.status,200);const body=await response.json();assert.equal(body.stored,1);assert.equal(body.automatic_reply,false);assert.equal(closed,1);assert.deepEqual(calls,['getMe','getWebhookInfo','getUpdates']);assert.ok(!JSON.stringify(body).includes('private incoming text'));
});
