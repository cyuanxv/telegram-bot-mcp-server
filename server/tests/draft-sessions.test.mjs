import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {DraftSessions} from '../lib/telegram/draft-sessions.ts';
const hash='a'.repeat(64),other='b'.repeat(64);
async function setup(t){
 const pg=new PGlite();t.after(()=>pg.close());await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon,authenticated,service_role');
 await pg.exec(readFileSync(new URL('../migrations/011_draft_sessions.sql',import.meta.url),'utf8'));
 const db={transaction:fn=>pg.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))};let now=1000;
 return {pg,db,store:new DraftSessions(db,()=>now),advance:()=>{now+=60001},input:{ownerId:'owner',id:randomUUID(),botAlias:'reports',chatId:'12345',draftId:17}};
}
test('persistent preview serializes revisions and sequence; one committed claim wins, no text stored',async t=>{
 const {store,pg,input}=await setup(t);const s=await store.create(input);assert.deepEqual(await store.create(input),s);
 assert.equal(await store.get('other',input.id),undefined);await assert.rejects(store.create({...input,chatId:'999'}),/state_changed/);
 const claims=await Promise.allSettled([store.claimPreview('owner',input.id,1,1,hash),store.claimPreview('owner',input.id,1,1,other)]);
 assert.equal(claims.filter(v=>v.status==='fulfilled').length,1);const active=await store.get('owner',input.id);assert.equal(active.state,'previewing');
 await assert.rejects(store.claimPreview('owner',input.id,active.revision,2,other),/state_changed/);
 await assert.rejects(store.settlePreview('owner',input.id,active.revision,randomUUID(),true),/state_changed/);
 const settled=await store.settlePreview('owner',input.id,active.revision,active.claim,true);
 await assert.rejects(store.claimPreview('owner',input.id,settled.revision,3,other),/state_changed/);
 const next=await store.claimPreview('owner',input.id,settled.revision,2,other);assert.equal(next.sequence,2);
 const doc=(await pg.query('SELECT document FROM telegram_draft_sessions')).rows[0].document;
 assert.equal('text' in doc,false);assert.equal('token' in doc,false);
});
test('crash recovery quarantines preview and final handoff is irreversible with exact stable key',async t=>{
 const {store,input,advance}=await setup(t);await store.create(input);const claim=await store.claimPreview('owner',input.id,1,1,hash);
 await assert.rejects(store.recoverPreview('owner',input.id,claim.revision),/still_in_flight/);advance();
 const unknown=await store.recoverPreview('owner',input.id,claim.revision);assert.equal(unknown.state,'unknown');
 await assert.rejects(store.settlePreview('owner',input.id,claim.revision,claim.claim,true),/state_changed/);
 await assert.rejects(store.prepareFinal('owner',input.id,unknown.revision,hash),/state_changed/);
 const stopped=await store.stop('owner',input.id,unknown.revision);await assert.rejects(store.claimPreview('owner',input.id,stopped.revision,2,hash),/state_changed/);
 const second={...input,id:randomUUID(),draftId:18};await store.create(second);const final=await store.prepareFinal('owner',second.id,1,other);
 assert.equal((await store.get('owner',second.id)).reportKey,final.reportKey);assert.equal(final.state,'final_pending');
 await assert.rejects(store.prepareFinal('owner',second.id,final.revision,hash),/state_changed/);
 await assert.rejects(store.linkReport('owner',second.id,final.revision,'wrong',randomUUID()),/state_changed/);
 const reportId=randomUUID();const linked=await store.linkReport('owner',second.id,final.revision,final.reportKey,reportId);assert.equal(linked.reportId,reportId);assert.equal(linked.state,'final_linked');assert.equal('delivered' in linked,false);
 await assert.rejects(store.claimPreview('owner',second.id,linked.revision,1,hash),/state_changed/);
});
test('lost commit acknowledgement stays ambiguous and state readback prevents another preview claim',async t=>{
 const {store,db,input}=await setup(t);await store.create(input);
 const unreliable=new DraftSessions({transaction:async fn=>{await db.transaction(fn);throw Error('private-driver-secret')}},()=>1000);
 await assert.rejects(unreliable.claimPreview('owner',input.id,1,1,hash),e=>e.message==='Draft session: storage_unconfirmed');
 const active=await store.get('owner',input.id);assert.equal(active.state,'previewing');assert.equal(active.revision,2);
 await assert.rejects(store.claimPreview('owner',input.id,1,1,hash),/state_changed/);
 const broken=new DraftSessions({transaction:fn=>db.transaction(sql=>fn({query:(q,p)=>{if(q.startsWith('UPDATE'))throw Error('private');return sql.query(q,p)}}))});
 await assert.rejects(broken.settlePreview('owner',input.id,2,active.claim,true),/storage_unconfirmed/);assert.equal((await store.get('owner',input.id)).state,'previewing');
});
test('migration strips default API grants and enables RLS without policies',async t=>{
 const {pg}=await setup(t);
 for(const role of ['anon','authenticated','service_role']){const r=await pg.query("SELECT has_table_privilege($1,'public.telegram_draft_sessions','SELECT,INSERT,UPDATE,DELETE') AS allowed",[role]);assert.equal(r.rows[0].allowed,false)}
 const r=await pg.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.telegram_draft_sessions'::regclass");assert.equal(r.rows[0].relrowsecurity,true);
});

test('preview identity is reserved across owners and stopped sessions',async t=>{
 const {store,input}=await setup(t);await store.create(input);
 await assert.rejects(store.create({...input,id:randomUUID()}),/state_changed/);
 await assert.rejects(store.create({...input,ownerId:'other',id:randomUUID()}),/state_changed/);
 await store.stop(input.ownerId,input.id,1);
 await assert.rejects(store.create({...input,id:randomUUID()}),/state_changed/);
 assert.equal((await store.create({...input,id:randomUUID(),draftId:18})).state,'ready');
});
