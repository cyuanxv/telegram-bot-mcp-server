import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';import {PGlite} from '@electric-sql/pglite';
import {DraftSessions} from '../lib/telegram/draft-sessions.ts';import {DraftWorkflow} from '../lib/telegram/draft-workflow.ts';import {AsyncReportQueue} from '../lib/telegram/delivery/async-queue.ts';import {PostgresQueueStore} from '../lib/telegram/delivery/postgres-store.ts';
async function setup(t){const pg=new PGlite();t.after(()=>pg.close());for(const name of ['001_delivery_reports.sql','011_draft_sessions.sql'])await pg.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));const db={transaction:fn=>pg.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))};const sessions=new DraftSessions(db),reports=new AsyncReportQueue(new PostgresQueueStore(db));const identity={ownerId:'owner',id:randomUUID(),botAlias:'reports',chatId:'12345',draftId:7};await sessions.create(identity);const calls=[];const deps={ownerId:'owner',sessions,reports,guard:()=>{},preview:async(s,text)=>{const stored=await sessions.get('owner',s.id);assert.equal(stored.state,'previewing');assert.equal(stored.claim,s.claim);calls.push(text);return {acknowledged:true}}};return {pg,db,sessions,reports,identity,calls,deps,flow:new DraftWorkflow(deps)}}
test('preview commits claim before transport, orders snapshots and links actual report without dispatch',async t=>{
 const s=await setup(t),v={id:s.identity.id,revision:1,sequence:1,text:'part',confirm:true};
 const first=await s.flow.preview(v);assert.equal(first.state,'previewed');assert.deepEqual(s.calls,['part']);
 await assert.rejects(s.flow.preview(v),/state changed/);assert.equal(s.calls.length,1);
 const final=await s.flow.prepareFinal({id:v.id,revision:first.revision,text:'complete 😀\n'.repeat(700),confirm:true});
 assert.equal(final.state,'final_linked');assert.equal(final.report_state,'draft');assert.equal(final.dispatch_performed,false);
 const job=await s.reports.get(final.report_id);assert.equal(job.chunks.map(c=>c.text).join(''),'complete 😀\n'.repeat(700));assert.ok(job.chunks.length>1);assert.ok(job.chunks.every(c=>c.attempts===0));
 const repeated=await s.flow.prepareFinal({id:v.id,revision:final.revision,text:'complete 😀\n'.repeat(700),confirm:true});assert.equal(repeated.report_id,final.report_id);assert.equal((await s.pg.query('SELECT count(*) AS n FROM telegram_delivery_reports')).rows[0].n,1);
 await assert.rejects(s.flow.prepareFinal({id:v.id,revision:final.revision,text:'changed',confirm:true}),/content or state changed/);
});
test('lost claim commit never sends; uncertain provider acknowledgement quarantines and prevents finalization',async t=>{
 const s=await setup(t);const lost=new DraftSessions({transaction:async fn=>{const value=await s.db.transaction(fn);if(value?.state==='previewing')throw Error('commit response lost');return value}});
 const flow=new DraftWorkflow({...s.deps,sessions:lost});await assert.rejects(flow.preview({id:s.identity.id,revision:1,sequence:1,text:'part',confirm:true}),/storage_unconfirmed/);assert.equal(s.calls.length,0);
 const other={...s.identity,id:randomUUID(),draftId:8};await s.sessions.create(other);
 const unknown=new DraftWorkflow({...s.deps,preview:async()=>{throw Error('provider secret')}});
 const r=await unknown.preview({id:other.id,revision:1,sequence:1,text:'part',confirm:true});assert.equal(r.state,'unknown');assert.equal(r.retry_automatically,false);
 await assert.rejects(unknown.prepareFinal({id:other.id,revision:r.revision,text:'final',confirm:true}),/state changed/);
});
test('report write with lost acknowledgement resumes same idempotency key without another report',async t=>{
 const s=await setup(t);let lose=true;
 const flow=new DraftWorkflow({...s.deps,reports:{get:id=>s.reports.get(id),draft:async input=>{const r=await s.reports.draft(input);if(lose){lose=false;throw Error('lost')}return r}}});
 await assert.rejects(flow.prepareFinal({id:s.identity.id,revision:1,text:'final',confirm:true}));
 const pending=await s.sessions.get('owner',s.identity.id);assert.equal(pending.state,'final_pending');
 const result=await flow.prepareFinal({id:pending.id,revision:pending.revision,text:'final',confirm:true});assert.equal(result.state,'final_linked');assert.equal((await s.pg.query('SELECT count(*) AS n FROM telegram_delivery_reports')).rows[0].n,1);
});
test('invalid report binding, revoked access, wrong owner and thread binding never become false delivery success',async t=>{
 const s=await setup(t);
 const denied=new DraftWorkflow({...s.deps,guard:()=>{throw Error('revoked')}});await assert.rejects(denied.preview({id:s.identity.id,revision:1,sequence:1,text:'x',confirm:true}));assert.equal(s.calls.length,0);
 const other=new DraftWorkflow({...s.deps,ownerId:'other'});await assert.rejects(other.prepareFinal({id:s.identity.id,revision:1,text:'final',confirm:true}));
 const threaded={...s.identity,id:randomUUID(),draftId:8,threadId:5};await s.sessions.create(threaded);const linked=await s.flow.prepareFinal({id:threaded.id,revision:1,text:'final',confirm:true});assert.equal((await s.reports.get(linked.report_id)).threadId,5);await s.reports.enqueue(linked.report_id,linked.report_fingerprint);const sent=await s.reports.dispatchNext(linked.report_id,linked.report_fingerprint,{send:async request=>{assert.equal(request.threadId,5);return {chatId:request.chatId,messageId:42,threadId:5}}});assert.equal(sent.state,'delivered');
 const bad=new DraftWorkflow({...s.deps,reports:{get:id=>s.reports.get(id),draft:async i=>({...await s.reports.draft(i),fingerprint:'0'.repeat(64)})}});await assert.rejects(bad.prepareFinal({id:s.identity.id,revision:1,text:'final',confirm:true}),/mismatch/);assert.equal((await s.sessions.get('owner',s.identity.id)).state,'final_pending');
});

test('stop during in-flight preview survives late success and prevents further work',async t=>{
 const s=await setup(t);let release,entered;
 const waiting=new Promise(resolve=>{entered=resolve});
 const pending=new Promise(resolve=>{release=resolve});
 const flow=new DraftWorkflow({...s.deps,preview:async()=>{entered();await pending;return {acknowledged:true}}});
 const running=flow.preview({id:s.identity.id,revision:1,sequence:1,text:'part',confirm:true});
 const rejected=assert.rejects(running,/state_changed/);
 await waiting;
 const active=await s.sessions.get('owner',s.identity.id);
 await assert.rejects(s.sessions.stop('other',active.id,active.revision),/state_changed/);
 await assert.rejects(s.sessions.stop('owner',active.id,1),/state_changed/);
 const stopped=await s.sessions.stop('owner',active.id,active.revision);
 assert.equal(stopped.state,'stopped');assert.equal(stopped.claim,undefined);
 release();await rejected;
 assert.deepEqual(await s.sessions.get('owner',active.id),stopped);
 await assert.rejects(flow.preview({id:active.id,revision:stopped.revision,sequence:2,text:'next',confirm:true}),/state_changed/);
 await assert.rejects(flow.prepareFinal({id:active.id,revision:stopped.revision,text:'final',confirm:true}),/state changed/);
 assert.equal((await s.pg.query('SELECT count(*) AS n FROM telegram_delivery_reports')).rows[0].n,0);
});
