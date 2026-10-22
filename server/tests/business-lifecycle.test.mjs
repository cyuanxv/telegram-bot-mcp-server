import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { businessNotice, checkedBusinessNotice } from '../lib/telegram/business-lifecycle.ts';
import { BusinessNoticeStore } from '../lib/telegram/business-notice-store.ts';
import { receiveBusinessNotice } from '../lib/telegram/business-notice-receiver.ts';
import { handleWebhook } from '../lib/telegram/inbox/receiver.ts';
const policy={secretToken:'synthetic_business_webhook_secret_12345678',allowedChatIds:['-123'],allowedBusinessConnectionIds:['conn1'],retainText:false,retentionDays:7};
const connection=(update_id=12,enabled=true)=>({update_id,business_connection:{id:'conn1',is_enabled:enabled,date:100,rights:{can_reply:true},user:{id:998,first_name:'DO NOT STORE'},user_chat_id:999}});
const deleted=(update_id=13,ids=[21,20])=>({update_id,deleted_business_messages:{business_connection_id:'conn1',chat:{id:-123,title:'DO NOT STORE'},message_ids:ids}});
const event=(update=connection(),now=1000)=>businessNotice(update,'default',policy,now);
const wrap=pg=>({transaction:fn=>pg.transaction(tx=>fn({query:(s,v)=>tx.query(s,v)}))});
async function setup(t){const pg=new PGlite();t.after(()=>pg.close());await pg.exec(readFileSync(new URL('../migrations/009_business_notices.sql',import.meta.url),'utf8'));return {pg,store:new BusinessNoticeStore(wrap(pg))};}

test('connection observations project only reviewed fields, distinguish unknown rights, and canonicalize JSONB order',()=>{
 const e=event();assert.equal(e.observation.enabled,true);assert.equal(e.observation.rights.can_reply,true);assert.equal(e.observation.rights.can_read_messages,false);
 assert.ok(!JSON.stringify(e).includes('DO NOT STORE'));assert.ok(!JSON.stringify(e).includes('998'));
 const raw=connection();delete raw.business_connection.rights;assert.equal(event(raw).observation.rights,null);
 raw.business_connection.rights={can_reply:'true'};assert.throws(()=>event(raw));
 const reverse=v=>Array.isArray(v)?v.map(reverse):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reverse(x)])):v;
 assert.deepEqual(checkedBusinessNotice(reverse(e)),e);
 const injected=structuredClone(e);injected.observation.raw_profile='private';assert.throws(()=>checkedBusinessNotice(injected));
});
test('connection and chat scope enforced before any journal write; malformed or mixed updates rejected',()=>{
 assert.equal(businessNotice(connection(),'default',{...policy,allowedBusinessConnectionIds:[]},1000),undefined);
 assert.equal(businessNotice(deleted(),'default',{...policy,allowedChatIds:['-999']},1000),undefined);
 assert.throws(()=>event({...connection(),message:{text:'mixed'}}));
 assert.throws(()=>event(deleted(13,[20,20])));assert.throws(()=>event(deleted(13,[Number.MAX_SAFE_INTEGER+1])));
 assert.throws(()=>event(deleted(13,[])));assert.throws(()=>event(deleted(13,Array.from({length:10001},(_,i)=>i+1))));
 const e=event(deleted(13,['9007199254740993','20']));assert.deepEqual(e.observation.messageIds,['20','9007199254740993']);
 assert.equal(event(deleted(13,[20,21])).fingerprint,event(deleted(13,[21,20])).fingerprint);
});
test('journal durably deduplicates concurrent notices, records changed payload conflicts, and preserves disabled notifications',async t=>{
 const {pg,store}=await setup(t);const r=await Promise.all(Array.from({length:10},()=>store.record(event())));
 assert.equal(r.filter(x=>x==='stored').length,1);assert.equal(r.filter(x=>x==='duplicate').length,9);
 assert.equal(await store.record(event(connection(12,false))),'conflict');
 assert.equal(await store.record(event(connection(11,false))),'stored');
 assert.equal(await store.record(event(deleted())),'stored');
 // All observations survive. A lower ID / later arrival is NOT inferred to supersede authorization.
 const rows=(await pg.query('SELECT document FROM public.telegram_business_notices ORDER BY sequence')).rows;
 assert.deepEqual(rows.map(r=>r.document.updateId),['12','11','13']);
 assert.equal(rows[1].document.observation.enabled,false);
 assert.deepEqual(checkedBusinessNotice(rows[0].document),event());
});
test('journal rollback and caller mutation cannot commit unvalidated content',async t=>{
 const {pg}=await setup(t);const database={transaction:fn=>pg.transaction(async tx=>{await fn({query:(s,v)=>tx.query(s,v)});throw Error('commit failed')})};
 await assert.rejects(new BusinessNoticeStore(database).record(event()));assert.equal((await pg.query('SELECT count(*)::int AS n FROM public.telegram_business_notices')).rows[0].n,0);
 let release;const barrier=new Promise(r=>release=r), e=event();
 const pending=new BusinessNoticeStore({transaction:async fn=>{await barrier;return wrap(pg).transaction(fn)}}).record(e);e.observation.enabled=false;release();
 assert.equal(await pending,'stored');assert.equal((await pg.query('SELECT document FROM public.telegram_business_notices')).rows[0].document.observation.enabled,true);
 await assert.rejects(pg.query("UPDATE public.telegram_business_notices SET document=document-'connectionId'"));
});
test('disabled and unapproved receivers do not open storage; guard changes and errors fail without private details',async()=>{
 let opened=0,closed=0,enabled=true;const open=async()=>{opened++;return{store:{record:async()=> 'stored'},close:()=>{closed++}}};
 assert.equal(await receiveBusinessNotice(connection(),'default',policy,()=>false,open),undefined);
 assert.equal(await receiveBusinessNotice(connection(),'default',{...policy,allowedBusinessConnectionIds:[]},()=>true,open),undefined);assert.equal(opened,0);
 const r=await receiveBusinessNotice(connection(),'default',policy,()=>enabled,async()=>{enabled=false;return {store:{record:async()=>{throw Error('must not write')}},close:()=>{closed++}}});
 assert.equal(r.status,503);assert.equal(closed,1);
 const bad=await receiveBusinessNotice(connection(),'default',policy,()=>true,async()=>{throw Error('postgres://secret')});assert.equal(bad.status,503);assert.ok(!(await bad.text()).includes('secret'));
});
test('authenticated webhook routes lifecycle notices with durable duplicate retry after lost acknowledgement',async t=>{
 const {store,pg}=await setup(t);let lose=true;
 const handler=raw=>receiveBusinessNotice(raw,'default',policy,()=>true,async()=>({store:{record:async e=>{const r=await store.record(e);if(lose){lose=false;throw Error('lost acknowledgement')}return r}},close(){}}),1000);
 const req=(secret=policy.secretToken)=>new Request('https://example.invalid/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify(connection())});
 const open=async()=>{throw Error('ordinary inbox must not open')};
 assert.equal((await handleWebhook(req('wrong'),'default',{bots:{default:policy}},open,1000,handler)).status,401);
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM public.telegram_business_notices')).rows[0].n,0);
 assert.equal((await handleWebhook(req(),'default',{bots:{default:policy}},open,1000,handler)).status,503);
 const repeated=await handleWebhook(req(),'default',{bots:{default:policy}},open,1000,handler);assert.equal(repeated.status,200);assert.equal((await repeated.json()).status,'business_duplicate');
});
