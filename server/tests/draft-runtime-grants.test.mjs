import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';
import {DraftSessions} from '../lib/telegram/draft-sessions.ts';
test('draft runtime can execute actual locked workflow only for fixed owner and cannot remove reservations',async t=>{
 const pg=new PGlite();t.after(()=>pg.close());await pg.exec('CREATE ROLE telegram_runtime');
 for(const f of ['011_draft_sessions.sql','011_draft_sessions-runtime.example.sql'])await pg.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const db={transaction:fn=>pg.transaction(async tx=>{await tx.exec('SET LOCAL ROLE telegram_runtime');return fn({query:(q,p)=>tx.query(q,p)})})};
 const store=new DraftSessions(db),owner='telegram-cloud-owner',identity={ownerId:owner,id:randomUUID(),botAlias:'default',chatId:'123',draftId:1};
 const created=await store.create(identity);assert.equal(created.state,'ready');
 const claim=await store.claimPreview(owner,identity.id,1,1,'a'.repeat(64));assert.equal(claim.state,'previewing');
 assert.equal(await store.stopFromTelegram({ownerId:owner,botAlias:'default',chatId:'123',draftId:1}),'stopped');
 assert.equal((await store.get(owner,identity.id)).state,'stopped');
 await assert.rejects(store.create({...identity,id:randomUUID(),draftId:2,ownerId:'other'}),/storage_unconfirmed/);
 const admin=new DraftSessions({transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))});
 const other={...identity,ownerId:'other',id:randomUUID(),draftId:2};await admin.create(other);
 assert.equal(await store.get('other',other.id),undefined);
 await assert.rejects(db.transaction(sql=>sql.query('DELETE FROM telegram_draft_sessions')));
 await assert.rejects(db.transaction(sql=>sql.query('TRUNCATE telegram_draft_sessions')));
 assert.equal((await admin.get(owner,identity.id)).state,'stopped');assert.equal((await admin.get('other',other.id)).state,'ready');
});
