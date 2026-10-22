import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {BusinessNoticeStore} from '../lib/telegram/business-notice-store.ts';
import {PostgresInboxStore} from '../lib/telegram/inbox/postgres-inbox.ts';
import {businessNotice} from '../lib/telegram/business-lifecycle.ts';
import {normalizedUpdate} from '../lib/telegram/inbox/normalize.ts';
import {businessDeletionGate} from '../lib/telegram/business-deletions.ts';
const now=1000000,policy={secretToken:'synthetic_deletion_secret_12345678901',allowedChatIds:['-1','-2'],allowedBusinessConnectionIds:['c1','c2'],retainText:true,retentionDays:7};
const gate=()=>({enabled:true,guard(){}});
const wrap=pg=>({transaction:fn=>pg.transaction(tx=>fn({query:(s,v)=>tx.query(s,v)}))});
const message=(updateId=1,{bot='a',conn='c1',chat=-1,id=20,kind='business_message',time=now}={})=>normalizedUpdate({update_id:updateId,[kind]:{message_id:id,date:1000,chat:{id:chat},...(conn?{business_connection_id:conn}:{}),text:'test body '+updateId}},bot,policy,time);
const notice=(updateId=50,ids=[20])=>businessNotice({update_id:updateId,deleted_business_messages:{business_connection_id:'c1',chat:{id:-1},message_ids:ids}},'a',policy,now);
async function setup(t,{markers=true}={}){const pg=new PGlite();t.after(()=>pg.close());for(const m of ['002_telegram_inbox.sql','009_business_notices.sql',...(markers?['010_business_deletions.sql']:[])])await pg.exec(readFileSync(new URL('../migrations/'+m,import.meta.url),'utf8'));const db=wrap(pg);return {pg,db,inbox:new PostgresInboxStore(db,undefined,gate),journal:new BusinessNoticeStore(db,gate)};}
const query={botAlias:'a',chatIds:['-1'],businessConnectionIds:['c1'],now};
test('deletion atomically removes all retained versions only for exact Bot/connection/chat/message',async t=>{
 const {inbox,journal,pg}=await setup(t);
 for(const e of [message(),message(2,{kind:'edited_business_message'}),message(3,{id:21}),message(4,{conn:'c2'}),message(5,{chat:-2}),message(6,{bot:'b'}),message(7,{conn:null,kind:'message'})])await inbox.record(e);
 assert.equal(await journal.record(notice()),'stored');
 const remaining=(await pg.query("SELECT update_id FROM public.telegram_inbox_events ORDER BY update_id")).rows.map(r=>r.update_id);assert.deepEqual(remaining,['3','4','5','6','7']);
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM public.telegram_business_deletions')).rows[0].n,1);
 assert.equal(await inbox.record(message(8)),'ignored_deleted');assert.equal(await journal.record(notice()),'duplicate');
 assert.equal(await journal.record(notice(50,[21])),'conflict');assert.equal((await inbox.list(query)).length,2);
});
test('deletion before message and expiry of the short notice log never resurrect the body',async t=>{
 const {inbox,journal,pg}=await setup(t);await journal.record(notice());
 await pg.query('DELETE FROM public.telegram_business_notices WHERE expires_at <= $1',[now+8*86400000]);
 assert.equal(await inbox.record(message(90,{time:now+9*86400000})),'ignored_deleted');
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM public.telegram_inbox_events')).rows[0].n,0);
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM public.telegram_business_deletions')).rows[0].n,1);
});
test('final deletion snapshot hides rows already fetched and suppresses an old writer replay',async t=>{
 const {inbox,journal,db}=await setup(t);await inbox.record(message());const fetched=await inbox.list(query);assert.equal(fetched.length,1);
 await journal.record(notice());assert.deepEqual(await inbox.filterBusinessDeleted(fetched),[]);
 await new PostgresInboxStore(db).record(message(91));assert.deepEqual(await inbox.list(query),[]);
 await assert.rejects(new PostgresInboxStore(db).filterBusinessDeleted(fetched),/disabled/);
});
test('disabled deletion path needs no new marker table and does not remove existing content',async t=>{
 const {db}=await setup(t,{markers:false});const off=()=>({enabled:false,guard(){}}),inbox=new PostgresInboxStore(db,undefined,off),journal=new BusinessNoticeStore(db,off);
 await inbox.record(message());await journal.record(notice());assert.equal((await inbox.list(query)).length,1);
 assert.equal(await inbox.record(message(2)),'stored');
});
test('database failure rolls back notice, marker and body removal together',async t=>{
 const {pg,inbox}=await setup(t);await inbox.record(message());
 const failDb={transaction:fn=>pg.transaction(tx=>fn({query:async(s,v)=>{const r=await tx.query(s,v);if(s.startsWith('DELETE FROM public.telegram_inbox_events'))throw Error('synthetic failure');return r}}))};
 await assert.rejects(new BusinessNoticeStore(failDb,gate).record(notice()));
 for(const table of ['telegram_business_notices','telegram_business_deletions'])assert.equal((await pg.query('SELECT count(*)::int AS n FROM public.'+table)).rows[0].n,0);
 assert.equal((await inbox.list(query)).length,1);
});
test('lost commit receipt is idempotent; a repeat may safely apply a previously log-only notice',async t=>{
 const {pg,db,inbox}=await setup(t);await inbox.record(message());await new BusinessNoticeStore(db).record(notice());
 assert.equal((await inbox.list(query)).length,1);let lose=true;
 const lost={transaction:async fn=>{const r=await db.transaction(fn);if(lose){lose=false;throw Error('lost ack')}return r}};
 const journal=new BusinessNoticeStore(lost,gate);await assert.rejects(journal.record(notice()));assert.equal(await journal.record(notice()),'duplicate');
 assert.equal((await inbox.list(query)).length,0);assert.equal((await pg.query('SELECT count(*)::int AS n FROM public.telegram_business_deletions')).rows[0].n,1);
});
test('deletion gate changes during a transaction roll back all changes',async t=>{
 const {pg,inbox}=await setup(t);await inbox.record(message());
 const env={TELEGRAM_BOT_TOKEN:'synthetic',TELEGRAM_BOTS_JSON:'{"a":"synthetic"}',TELEGRAM_BUSINESS_NOTICES_ENABLED:'true',TELEGRAM_BUSINESS_NOTICE_BOTS_JSON:'["a"]',TELEGRAM_BUSINESS_DELETE_APPLY_ENABLED:'true'};
 const db={transaction:fn=>pg.transaction(tx=>fn({query:async(s,v)=>{const r=await tx.query(s,v);if(s.startsWith('INSERT INTO public.telegram_business_deletions'))env.TELEGRAM_BUSINESS_DELETE_APPLY_ENABLED='false';return r}}))};
 await assert.rejects(new BusinessNoticeStore(db,businessDeletionGate(()=>env)).record(notice()),/policy changed/);assert.equal((await inbox.list(query)).length,1);
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM public.telegram_business_deletions')).rows[0].n,0);
});
test('marker capacity rejects atomically while exact retries remain usable',async t=>{
 const {pg,inbox,journal}=await setup(t);await inbox.record(message());
 await pg.query("INSERT INTO public.telegram_business_deletions SELECT 'a','other','-1',n::text,0 FROM generate_series(1,100000) AS n");
 await assert.rejects(journal.record(notice()),/capacity/);
 assert.equal((await inbox.list(query)).length,1);
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM public.telegram_business_notices')).rows[0].n,0);
 await pg.query("DELETE FROM public.telegram_business_deletions WHERE connection_id='other' AND message_id='1'");
 assert.equal(await journal.record(notice()),'stored');assert.equal(await journal.record(notice()),'duplicate');
});
test('marker schema accepts a 256 character connection ID but rejects 257',async t=>{
 const {pg}=await setup(t);
 await pg.query("INSERT INTO public.telegram_business_deletions VALUES ('a',$1,'-1','1',0)",['c'.repeat(256)]);
 await assert.rejects(pg.query("INSERT INTO public.telegram_business_deletions VALUES ('a',$1,'-1','1',0)",['c'.repeat(257)]));
});
