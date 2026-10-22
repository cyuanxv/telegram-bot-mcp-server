import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {spawnSync} from 'node:child_process';
import {BusinessBackfill,backfillGuard} from '../lib/telegram/business-backfill.ts';
import {BusinessNoticeStore} from '../lib/telegram/business-notice-store.ts';
import {PostgresInboxStore} from '../lib/telegram/inbox/postgres-inbox.ts';
import {businessNotice} from '../lib/telegram/business-lifecycle.ts';
import {normalizedUpdate} from '../lib/telegram/inbox/normalize.ts';
const now=1000000,policy={secretToken:'synthetic_backfill_secret_1234567890',allowedChatIds:['-1','-2'],allowedBusinessConnectionIds:['c1','c2'],retainText:true,retentionDays:7};
const scope={bot_alias:'a',connection_id:'c1',chat_ids:['-1'],after_sequence:'0',through_sequence:'100'};
const notice=(u=1,conn='c1',chat=-1)=>businessNotice({update_id:u,deleted_business_messages:{business_connection_id:conn,chat:{id:chat},message_ids:[20]}},'a',policy,now);
const message=(u=1,conn='c1',chat=-1)=>normalizedUpdate({update_id:u,business_message:{message_id:20,business_connection_id:conn,date:1000,chat:{id:chat},text:'synthetic body'}},'a',policy,now);
async function setup(t){const pg=new PGlite();t.after(()=>pg.close());for(const m of ['002_telegram_inbox.sql','009_business_notices.sql','010_business_deletions.sql'])await pg.exec(readFileSync(new URL('../migrations/'+m,import.meta.url),'utf8'));const db={transaction:fn=>pg.transaction(tx=>fn({query:(s,v)=>tx.query(s,v)}))};return {pg,db,journal:new BusinessNoticeStore(db),inbox:new PostgresInboxStore(db),repair:new BusinessBackfill(db,scope,()=>{})};}
test('review-only plan and exact-scope apply include still-stored expired notices without exposing documents',async t=>{
 const {pg,journal,inbox,repair}=await setup(t);
 for(const [u,c,h] of [[1,'c1',-1],[2,'c2',-1],[3,'c1',-2]]){await journal.record(notice(u,c,h));await inbox.record(message(u,c,h));}
 const p=await repair.plan();assert.equal(p.notice_count,1);assert.equal(p.message_references,1);assert.equal(JSON.stringify(p).includes('synthetic body'),false);
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM telegram_inbox_events')).rows[0].n,3);
 const result=await repair.apply(p.digest);assert.equal(result.applied_notices,1);assert.equal(result.telegram_mutated,false);
 assert.deepEqual((await pg.query('SELECT update_id FROM telegram_inbox_events ORDER BY update_id')).rows.map(r=>r.update_id),['2','3']);
 assert.equal((await repair.apply(p.digest)).applied_notices,1);
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM telegram_business_deletions')).rows[0].n,1);
});
test('changed or purged reviewed records reject before deletion; future ranges remain separate',async t=>{
 const {pg,db,journal,inbox,repair}=await setup(t);await journal.record(notice());await inbox.record(message());
 const p=await repair.plan();await journal.record(notice(2));await assert.rejects(repair.apply(p.digest),/plan changed/);
 const bounded=new BusinessBackfill(db,{...scope,through_sequence:'1'},()=>{});const b=await bounded.plan();
 assert.equal(b.notice_count,1);await pg.query('DELETE FROM telegram_business_notices WHERE sequence=1');
 await assert.rejects(bounded.apply(b.digest),/plan changed/);assert.equal((await pg.query('SELECT count(*)::int AS n FROM telegram_inbox_events')).rows[0].n,1);
});
test('guard revocation after deletion rolls back the whole batch',async t=>{
 const {pg,db,journal,inbox}=await setup(t);await journal.record(notice());await inbox.record(message());let permitted=true;
 const wrapped={transaction:fn=>db.transaction(sql=>fn({query:async(s,v)=>{const r=await sql.query(s,v);if(s.startsWith('DELETE FROM public.telegram_inbox_events'))permitted=false;return r}}))};
 const repair=new BusinessBackfill(wrapped,scope,()=>{if(!permitted)throw Error('revoked')});const p=await repair.plan();await assert.rejects(repair.apply(p.digest),/revoked/);
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM telegram_inbox_events')).rows[0].n,1);assert.equal((await pg.query('SELECT count(*)::int AS n FROM telegram_business_deletions')).rows[0].n,0);
});
test('lost commit acknowledgement safely retries the same reviewed plan',async t=>{
 const {pg,db,journal}=await setup(t);await journal.record(notice());const regular=new BusinessBackfill(db,scope,()=>{}),p=await regular.plan();let lose=true;
 const repair=new BusinessBackfill({transaction:async fn=>{const r=await db.transaction(fn);if(lose){lose=false;throw Error('lost ack')}return r}},scope,()=>{});
 await assert.rejects(repair.apply(p.digest),/lost ack/);assert.equal((await repair.apply(p.digest)).applied_notices,1);
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM telegram_business_deletions')).rows[0].n,1);
});
test('bounded repair rejects more than 100 notices without mutation',async t=>{
 const {pg,journal,db}=await setup(t);for(let i=1;i<=101;i++)await journal.record(notice(i));
 await assert.rejects(new BusinessBackfill(db,{...scope,through_sequence:'101'},()=>{}).plan(),/100 notices/);
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM telegram_business_deletions')).rows[0].n,0);
});
test('repair requires explicit flags, static Bot, exact scope and unchanged receiver policy',()=>{
 const env={TELEGRAM_BOTS_JSON:'{"a":"synthetic"}',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({a:policy}),TELEGRAM_BUSINESS_NOTICES_ENABLED:'true',TELEGRAM_BUSINESS_NOTICE_BOTS_JSON:'["a"]'};
 assert.throws(()=>backfillGuard(scope,false,()=>env),/disabled/);env.TELEGRAM_BUSINESS_BACKFILL_ENABLED='true';
 const plan=backfillGuard(scope,false,()=>env);plan.guard();assert.throws(()=>backfillGuard(scope,true,()=>env),/disabled/);
 env.TELEGRAM_BUSINESS_DELETE_APPLY_ENABLED='true';const apply=backfillGuard(scope,true,()=>env);apply.guard();
 assert.throws(()=>backfillGuard({...scope,chat_ids:['-9']},true,()=>env),/scope denied/);
 assert.throws(()=>backfillGuard({...scope,chat_ids:['-1','-1']},false,()=>env),/Duplicate/);
 assert.throws(()=>backfillGuard({...scope,through_sequence:'0'},false,()=>env),/nonempty/);
 env.TELEGRAM_WEBHOOK_BOTS_JSON=JSON.stringify({a:{...policy,retainText:false}});assert.throws(()=>apply.guard(),/scope changed/);
});

test('returned plan cannot mutate the bound repair scope',async t=>{
 const {journal,repair}=await setup(t);await journal.record(notice());const p=await repair.plan(),digest=p.digest;
 p.scope.chat_ids.push('-2');p.scope.connection_id='c2';
 assert.equal((await repair.plan()).digest,digest);assert.equal((await repair.apply(digest)).applied_notices,1);
});
test('CLI rejects disabled access and malformed approval without reflecting input or opening a database',()=>{
 const run=(action,input)=>spawnSync(process.execPath,['--import','./tests/register-typescript.mjs','scripts/business-backfill-cli.ts',action],{cwd:new URL('../',import.meta.url),input:JSON.stringify(input),encoding:'utf8',env:{PATH:process.env.PATH,NODE_NO_WARNINGS:'1'},timeout:10000});
 for(const [action,input] of [['plan',{scope}],['apply',{scope,expected_digest:'secret_not_a_digest'}],['plan',{scope,unexpected:'secret_private_input'}]]){
   const result=run(action,input);assert.equal(result.status,1,result.stderr);assert.equal(result.stdout,'');
   assert.equal(result.stderr.includes('secret_'),false);assert.ok(JSON.parse(result.stderr).error.startsWith('Business repair failed'));
 }
});
