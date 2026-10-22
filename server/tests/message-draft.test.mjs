import test from 'node:test';
import assert from 'node:assert/strict';
import {sendMessageDraft} from '../lib/telegram/message-draft.ts';
import {assertBotScopePolicy} from '../lib/telegram/vault/bot-scope.ts';
const input={bot_alias:'reports',chat:'owner',draft_id:19,text:'partial',confirm:true};
const env=()=>({TELEGRAM_DRAFT_PREVIEW_ENABLED:'true',TELEGRAM_DRAFT_PREVIEW_TARGETS_JSON:'[{"bot_alias":"reports","chat":"owner"}]',TELEGRAM_CHATS_JSON:'{"owner":"12345"}'});
const forbidden=()=>assert.fail('must not call Telegram');
test('draft preview rejects missing approval, disabled or unlisted scopes, raw recipients and invalid snapshots',async()=>{
 await assert.rejects(sendMessageDraft(input,{env:()=>({}),call:forbidden}),/disabled/);
 for(const patch of [{confirm:false},{chat:'12345'},{draft_id:0},{draft_id:Number.MAX_SAFE_INTEGER+1},{text:'x'.repeat(4097)},{text:'\ud800'},{can_stop:true}])await assert.rejects(sendMessageDraft({...input,...patch},{env,call:forbidden}));
 for(const patch of [{TELEGRAM_DRAFT_PREVIEW_TARGETS_JSON:'[]'},{TELEGRAM_CHATS_JSON:'{"owner":"-12345"}'},{TELEGRAM_DRAFT_PREVIEW_TARGETS_JSON:'[{"bot_alias":"reports","chat":"owner","token":"private"}]'}])await assert.rejects(sendMessageDraft(input,{env:()=>({...env(),...patch}),call:forbidden}));
});
test('draft preview confirms private destination and projects ephemeral acknowledgement without final send',async()=>{
 for(const text of ['', '😀'.repeat(4096)]){
  const calls=[];const r=await sendMessageDraft({...input,text},{env,call:async(alias,method,params)=>{calls.push({method,params});return {bot:alias,result:method==='getChat'?{id:12345,type:'private',secret:'redact'}:true}}});
  assert.equal(r.status,'preview_acknowledged');assert.equal(r.persisted,false);assert.equal(r.final_message_sent,false);
  assert.deepEqual(calls.map(c=>c.method),['getChat','sendMessageDraft']);assert.deepEqual(calls[1].params,{chat_id:'12345',draft_id:19,text});assert.equal(JSON.stringify(r).includes(text||'redact'),text!==''&&text==='partial');
 }
});
test('wrong chat, changed config and cancellation prevent preview; unknown write never retries',async()=>{
 for(const kind of ['group','wrong_id','changed','abort']){
  const config=env(),ac=new AbortController();let count=0;
  await assert.rejects(sendMessageDraft(input,{env:()=>config,signal:ac.signal,call:async(alias,method)=>{count++;assert.equal(method,'getChat');if(kind==='changed')config.TELEGRAM_DRAFT_PREVIEW_ENABLED='false';if(kind==='abort')ac.abort();return {bot:alias,result:{id:kind==='wrong_id'?999:12345,type:kind==='group'?'group':'private'}}}}));assert.equal(count,1);
 }
 for(const kind of ['throw','wrong_bot','false']){
  let count=0;const r=await sendMessageDraft(input,{env,call:async(alias,method)=>{if(method==='getChat')return {bot:alias,result:{id:12345,type:'private'}};count++;if(kind==='throw')throw Error('secret');return {bot:kind==='wrong_bot'?'other':alias,result:kind==='false'?false:true}}});
  assert.deepEqual(r,{status:'preview_unconfirmed',persisted:false,final_message_sent:false,retry_automatically:false});assert.equal(count,1);
 }
});
test('draft permission is independent of sendMessage and limited to approved private numeric targets',()=>{
 const policy={methods:['sendMessageDraft'],chat_ids:['12345','-42']},params={chat_id:'12345',draft_id:1,text:''};
 assert.doesNotThrow(()=>assertBotScopePolicy(policy,'sendMessageDraft',params));
 assert.doesNotThrow(()=>assertBotScopePolicy(policy,'sendMessageDraft',{...params,can_stop:true,keep_on_stop:false}));
 for(const patch of [{chat_id:'-42'},{chat_id:'999'},{draft_id:0},{text:'x'.repeat(4097)},{can_stop:'true'},{keep_on_stop:true},{message_thread_id:0}])assert.throws(()=>assertBotScopePolicy(policy,'sendMessageDraft',{...params,...patch}));
 assert.throws(()=>assertBotScopePolicy({methods:['sendMessage'],chat_ids:['12345']},'sendMessageDraft',params));
 assert.throws(()=>assertBotScopePolicy(policy,'sendMessage',params));
});

test('native stop button requires approved receiver and verified subscription before preview',async()=>{
 const config={...env(),TELEGRAM_DRAFT_STOP_EVENTS_ENABLED:'true',TELEGRAM_DRAFT_WORKFLOW_ENABLED:'true',TELEGRAM_WEBHOOK_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({reports:{secretToken:'s'.repeat(40),allowedChatIds:['12345'],retainText:false,retentionDays:7,acceptDraftStops:true}})};
 let sends=0;const call=async(bot,method,params,attachments,o)=>{
  if(method==='getChat')return {bot,result:{id:12345,type:'private'}};
  await o.beforeSend();sends++;assert.equal(params.can_stop,true);assert.equal(params.keep_on_stop,false);return {bot,result:true};
 };
 const info={url:'https://backend.example.invalid/api/telegram/webhook/reports',allowed_updates:['stopped_message_generation']};
 for(const patch of [{url:'https://other.invalid/webhook'},{allowed_updates:[]},{allowed_updates:undefined}]){
  await assert.rejects(sendMessageDraft(input,{env:()=>config,call,stopButton:true,beforeSend:async()=>{},control:async()=>({bot:'reports',result:{...info,...patch}})}),/webhook not ready/);
 }
 assert.equal(sends,0);
 const r=await sendMessageDraft(input,{env:()=>config,call,stopButton:true,beforeSend:async()=>{},control:async()=>({bot:'reports',result:info})});assert.equal(r.status,'preview_acknowledged');assert.equal(sends,1);
 config.TELEGRAM_DRAFT_STOP_EVENTS_ENABLED='false';await assert.rejects(sendMessageDraft(input,{env:()=>config,call,stopButton:true,beforeSend:async()=>{},control:forbidden}),/not approved/);assert.equal(sends,1);
});
