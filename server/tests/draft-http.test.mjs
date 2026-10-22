import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';import {PGlite} from '@electric-sql/pglite';
import {handleDraftWorkflow} from '../lib/telegram/draft-http.ts';import {DraftSessions} from '../lib/telegram/draft-sessions.ts';import {AsyncReportQueue} from '../lib/telegram/delivery/async-queue.ts';import {PostgresQueueStore} from '../lib/telegram/delivery/postgres-store.ts';
const auth='synthetic-stream-auth-'.repeat(3);
const config=()=>({TELEGRAM_DRAFT_WORKFLOW_ENABLED:'true',TELEGRAM_DRAFT_WORKFLOW_AUTH:auth,TELEGRAM_VAULT_OWNER_ID:'owner',TELEGRAM_DRAFT_PREVIEW_ENABLED:'true',TELEGRAM_DRAFT_PREVIEW_TARGETS_JSON:'[{"bot_alias":"reports","chat":"test"}]',TELEGRAM_CHATS_JSON:'{"test":"12345"}'});
const request=(v,headers={})=>new Request('https://private.test/drafts',{method:'POST',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json',...headers},body:JSON.stringify(v)});
const create=()=>({action:'create',id:randomUUID(),bot_alias:'reports',chat:'test',draft_id:7,confirm:true});
async function setup(t){
 const pg=new PGlite();t.after(()=>pg.close());for(const n of ['001_delivery_reports.sql','011_draft_sessions.sql'])await pg.exec(readFileSync(new URL('../migrations/'+n,import.meta.url),'utf8'));
 const db={transaction:fn=>pg.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))};const sessions=new DraftSessions(db),reports=new AsyncReportQueue(new PostgresQueueStore(db));const env=config();let closed=0;const calls=[];
 const options={env:()=>env,open:async()=>({sessions,reports,close:async()=>{closed++}}),call:async(alias,method,params,_attachments,o)=>{o.guard();calls.push({method,params});return {bot:alias,result:method==='getChat'?{id:12345,type:'private'}:true}}};
 return {env,options,pg,sessions,reports,calls,closed:()=>closed,invoke:async v=>{const r=await handleDraftWorkflow(request(v),options);return {status:r.status,body:await r.json()}}};
}
test('disabled, invalid auth and client-controlled owner cannot open storage',async()=>{
 const open=async()=>assert.fail('must not open'),env=config(),v=create();
 assert.equal((await handleDraftWorkflow(request(v),{env:()=>({}),open})).status,503);
 assert.equal((await handleDraftWorkflow(request(v,{authorization:'Bearer wrong'}),{env:()=>env,open})).status,401);
 for(const invalid of [{...v,ownerId:'other'},{...v,confirm:false},{...v,token:'secret'},{...v,chat:'x'.repeat(600000)}])assert.equal((await handleDraftWorkflow(request(invalid),{env:()=>env,open})).status,400);
});
test('HTTP workflow persists preview before sending, returns metadata, and finalizes one report without dispatch',async t=>{
 const s=await setup(t),v=create();assert.equal((await s.invoke(v)).body.state,'ready');
 const preview=await s.invoke({action:'preview',id:v.id,revision:1,sequence:1,text:'partial private body',confirm:true});assert.equal(preview.status,200);assert.equal(preview.body.state,'previewed');
 assert.deepEqual(s.calls.map(c=>c.method),['getChat','sendMessageDraft']);assert.equal(s.calls[1].params.chat_id,'12345');
 const status=await s.invoke({action:'status',id:v.id});assert.equal(status.body.revision,preview.body.revision);assert.ok(!JSON.stringify(status.body).includes('private body'));
 const final=await s.invoke({action:'finalize',id:v.id,revision:preview.body.revision,text:'final body',confirm:true});assert.equal(final.body.report_state,'draft');assert.equal(final.body.dispatch_performed,false);
 const repeat=await s.invoke({action:'finalize',id:v.id,revision:final.body.revision,text:'final body',confirm:true});assert.equal(repeat.body.report_id,final.body.report_id);assert.equal(s.calls.length,2);
 const job=await s.reports.get(final.body.report_id);assert.equal(job.chunks[0].attempts,0);assert.ok(s.closed()>=5);
});
test('destination remap and owner changes cannot resume a saved session',async t=>{
 const s=await setup(t),v=create();await s.invoke(v);s.env.TELEGRAM_CHATS_JSON='{"test":"999"}';assert.equal((await s.invoke({action:'preview',id:v.id,revision:1,sequence:1,text:'x',confirm:true})).status,503);assert.equal(s.calls.length,0);
 s.env.TELEGRAM_CHATS_JSON='{"test":"12345"}';s.env.TELEGRAM_VAULT_OWNER_ID='other';assert.equal((await s.invoke({action:'status',id:v.id})).status,503);assert.equal(s.calls.length,0);
});
test('revocation during preflight prevents preview; unknown state blocks finalization and permits stop',async t=>{
 const s=await setup(t),v=create();await s.invoke(v);let sends=0;
 s.options.call=async(alias,method)=>{if(method==='getChat'){s.env.TELEGRAM_DRAFT_PREVIEW_ENABLED='false';return {bot:alias,result:{id:12345,type:'private'}}}sends++;return {bot:alias,result:true}};
 const p=await s.invoke({action:'preview',id:v.id,revision:1,sequence:1,text:'x',confirm:true});assert.equal(p.status,503);assert.equal(sends,0);
 s.env.TELEGRAM_DRAFT_PREVIEW_ENABLED='true';const current=await s.invoke({action:'status',id:v.id});assert.equal(current.body.state,'unknown');
 assert.equal((await s.invoke({action:'finalize',id:v.id,revision:current.body.revision,text:'final',confirm:true})).status,503);
 assert.equal((await s.invoke({action:'stop',id:v.id,revision:current.body.revision,confirm:true})).body.state,'stopped');
 assert.equal((await s.invoke({action:'preview',id:v.id,revision:current.body.revision+1,sequence:2,text:'x',confirm:true})).status,503);assert.equal(sends,0);
});
test('lost create acknowledgement exposes no errors and same identity can be read back without another session',async t=>{
 const s=await setup(t),v=create(),original=s.sessions.create.bind(s.sessions);let lose=true;
 s.sessions.create=async i=>{const r=await original(i);if(lose){lose=false;throw Error('private driver token')}return r};
 const first=await s.invoke(v);assert.equal(first.status,503);assert.equal(first.body.status,'draft_operation_unconfirmed');assert.ok(!JSON.stringify(first.body).includes('token'));
 assert.equal((await s.invoke(v)).body.state,'ready');assert.equal((await s.pg.query('SELECT count(*) AS n FROM telegram_draft_sessions')).rows[0].n,1);assert.equal(s.calls.length,0);
});

test('standalone HTTP workflow reaches database through all steps without final Telegram send',async t=>{
 const s=await setup(t),v=create();
 const {action,...identity}=v;
 const call=async(action,args)=>{const result=await s.invoke({action,...args});assert.equal(result.status,200);return result.body};
 assert.equal((await call('create',identity)).state,'ready');
 const preview=await call('preview',{id:v.id,revision:1,sequence:1,text:'preview text',confirm:true});assert.equal(preview.state,'previewed');
 const status=await call('status',{id:v.id});assert.equal(status.revision,preview.revision);assert.equal(status.chat_id,'12345');
 const final=await call('finalize',{id:v.id,revision:status.revision,text:'final text',confirm:true});assert.equal(final.report_state,'draft');assert.equal(final.dispatch_performed,false);
 assert.equal((await s.reports.get(final.report_id)).chunks[0].attempts,0);assert.deepEqual(s.calls.map(c=>c.method),['getChat','sendMessageDraft']);
});

test('stop during private-chat preflight prevents preview dispatch and remains readable',async t=>{
 const s=await setup(t),v=create();await s.invoke(v);let release,entered,sends=0;
 const waiting=new Promise(resolve=>{entered=resolve});const pending=new Promise(resolve=>{release=resolve});
 s.options.call=async(alias,method,params,attachments,o)=>{
  if(method==='getChat'){entered();await pending;return {bot:alias,result:{id:12345,type:'private'}}}
  await o.beforeSend();o.guard();sends++;return {bot:alias,result:true};
 };
 const preview=s.invoke({action:'preview',id:v.id,revision:1,sequence:1,text:'x',confirm:true});
 await waiting;const active=await s.invoke({action:'status',id:v.id});assert.equal(active.body.state,'previewing');
 const stopped=await s.invoke({action:'stop',id:v.id,revision:active.body.revision,confirm:true});
 assert.equal(stopped.status,200);assert.equal(stopped.body.state,'stopped');
 release();assert.equal((await preview).status,503);assert.equal(sends,0);
 const status=await s.invoke({action:'status',id:v.id});assert.equal(status.body.state,'stopped');assert.equal(status.body.revision,stopped.body.revision);
});
