import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { businessNotice } from '../lib/telegram/business-lifecycle.ts';
import { BusinessNoticeStore } from '../lib/telegram/business-notice-store.ts';
import { businessNoticeEnabled } from '../lib/telegram/business-notice-config.ts';
import { readBusinessNotices } from '../lib/telegram/business-notice-read.ts';
const policy={secretToken:'synthetic_business_webhook_secret_12345678',allowedChatIds:['-123','-456'],allowedBusinessConnectionIds:['conn1','conn2'],retainText:false,retentionDays:7};
const now=1000000000;
const environment=()=>({TELEGRAM_BOT_TOKEN:'synthetic-only',TELEGRAM_WEBHOOK_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({default:policy}),TELEGRAM_BUSINESS_NOTICES_ENABLED:'true',TELEGRAM_BUSINESS_NOTICE_BOTS_JSON:'["default"]',TELEGRAM_BUSINESS_NOTICE_READ_ENABLED:'true'});
const args={bot_alias:'default',business_connection_id:'conn1'};
const raw=(id=1,connection='conn1')=>({update_id:id,business_connection:{id:connection,is_enabled:false,date:100,rights:{can_reply:false}}});
const deletion=(id,chat,ids=[20])=>({update_id:id,deleted_business_messages:{business_connection_id:'conn1',chat:{id:chat},message_ids:ids}});
async function setup(t){const pg=new PGlite();t.after(()=>pg.close());await pg.exec(readFileSync(new URL('../migrations/009_business_notices.sql',import.meta.url),'utf8'));const store=new BusinessNoticeStore({transaction:fn=>pg.transaction(tx=>fn({query:(s,v)=>tx.query(s,v)}))});return {pg,store,open:async()=>({store,close(){}})};}
test('notification query enforces Bot, connection, chat and expiration filters with stable pagination',async t=>{
 const {store}=await setup(t);
 for(const [update,alias,time] of [[raw(1),'default',now],[raw(2),'other',now],[raw(3,'conn2'),'default',now],[deletion(4,-456),'default',now],[deletion(5,-123),'default',now],[raw(6),'default',now-8*86400000]])await store.record(businessNotice(update,alias,policy,time));
 const q={botAlias:'default',connectionId:'conn1',chatIds:['-123'],now,limit:1};
 const first=await store.list(q);assert.equal(first[0].event.updateId,'1');
 const second=await store.list({...q,afterSequence:first[0].sequence});assert.equal(second[0].event.updateId,'5');
 assert.deepEqual(await store.list({...q,afterSequence:second[0].sequence}),[]);
 await assert.rejects(store.list({...q,chatIds:[]}));await assert.rejects(store.list({...q,limit:101}));await assert.rejects(store.list({...q,afterSequence:'9223372036854775808'}));
});
test('owner workflow shows disabled notices as observations, bounds deletion IDs and never changes records',async t=>{
 const {store,pg,open}=await setup(t);await store.record(businessNotice(raw(),'default',policy,now));
 await store.record(businessNotice(deletion(2,-123,Array.from({length:101},(_,i)=>i+1)),'default',policy,now));
 const r=await readBusinessNotices(args,{env:environment,now:()=>now,open});
 assert.equal(r.notification_log_only,true);assert.equal(r.current_permissions_verified,false);assert.equal(r.sent,false);
 assert.equal(r.notices[0].observed_enabled,false);assert.equal(r.notices[1].message_count,101);assert.equal(r.notices[1].message_ids.length,100);assert.equal(r.notices[1].message_ids_truncated,true);
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM public.telegram_business_notices')).rows[0].n,2);
 const next=await readBusinessNotices({...args,after_sequence:r.next_after_sequence},{env:environment,now:()=>now,open});assert.equal(next.notices.length,0);assert.equal(next.next_after_sequence,r.next_after_sequence);
});
test('separate read switch, static Bot restriction and configured connection checked before opening storage',async()=>{
 let opened=0;const open=async()=>{opened++;throw Error('must not open')};
 for(const change of [{TELEGRAM_BUSINESS_NOTICES_ENABLED:'false'},{TELEGRAM_BUSINESS_NOTICE_READ_ENABLED:'false'},{TELEGRAM_BOT_TOKEN:undefined},{TELEGRAM_BUSINESS_NOTICE_BOTS_JSON:'["other"]'}])await assert.rejects(readBusinessNotices(args,{env:()=>({...environment(),...change}),open}),/disabled/);
 await assert.rejects(readBusinessNotices({...args,business_connection_id:'unknown'},{env:environment,open}),/scope denied/);
 await assert.rejects(readBusinessNotices({...args,chat_ids:['-999']},{env:environment,open}));assert.equal(opened,0);
 for(const value of ['null','{}','["default","default"]','[1]','not-json'])assert.equal(businessNoticeEnabled('default',{...environment(),TELEGRAM_BUSINESS_NOTICE_BOTS_JSON:value}),false);
});
test('scope removal and abort during database read prevent release, close storage, sanitize provider errors',async()=>{
 for(const revoke of ['policy','read','abort']){
  const env=environment(),ac=new AbortController();let closed=0;
  const open=async()=>({store:{list:async()=>{if(revoke==='policy')env.TELEGRAM_WEBHOOK_BOTS_JSON=JSON.stringify({default:{...policy,allowedBusinessConnectionIds:[]}});else if(revoke==='read')env.TELEGRAM_BUSINESS_NOTICE_READ_ENABLED='false';else ac.abort();return []}},close(){closed++}});
  await assert.rejects(readBusinessNotices(args,{env:()=>env,now:()=>now,signal:ac.signal,open}),/unavailable or scope changed/);assert.equal(closed,1);
 }
 await assert.rejects(readBusinessNotices(args,{env:environment,open:async()=>{throw Error('postgres://private')}}),e=>!e.message.includes('private'));
});
test('expiry during query hides notification but advances cursor to avoid repeating expired rows',async t=>{
 const {store}=await setup(t);const e=businessNotice(raw(),'default',policy,now);await store.record(e);let tick=0;
 const result=await readBusinessNotices(args,{env:environment,now:()=>tick++===0?e.expiresAt-1:e.expiresAt,open:async()=>({store,close(){}})});
 assert.deepEqual(result.notices,[]);assert.equal(result.next_after_sequence,'1');
});

test('revocation during asynchronous storage close is checked before returning notices',async()=>{
 const env=environment();let closes=0;
 await assert.rejects(readBusinessNotices(args,{env:()=>env,now:()=>now,open:async()=>({store:{list:async()=>[]},close:async()=>{closes++;env.TELEGRAM_BUSINESS_NOTICE_READ_ENABLED='false'}})}),/unavailable or scope changed/);
 assert.equal(closes,1);
});
