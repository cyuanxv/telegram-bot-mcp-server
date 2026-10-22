import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {PostgresMediaLedger} from '../lib/telegram/delivery/media-store.ts';
async function setup(t){const pg=new PGlite();t.after(()=>pg.close());await pg.exec(readFileSync(new URL('../migrations/005_media_deliveries.sql',import.meta.url),'utf8'));const db={transaction:fn=>pg.transaction(tx=>fn({query:(sql,values)=>tx.query(sql,values)}))};return {pg,db,store:new PostgresMediaLedger(db)}}
const input={key:'a'.repeat(64),fingerprint:'b'.repeat(64),createdAt:1000};
test('PostgreSQL claim uniqueness and durable receipts span store instances',async t=>{
 const {db,store}=await setup(t);const claims=await Promise.all(Array.from({length:12},()=>store.claim(input)));assert.equal(claims.filter(r=>r.state==='claimed').length,1);
 const second=new PostgresMediaLedger(db);assert.equal((await second.claim(input)).state,'inflight');await store.settle(input.key,input.fingerprint,'sent',42);assert.deepEqual(await second.claim(input),{state:'sent',messageId:42});await assert.rejects(second.claim({...input,fingerprint:'c'.repeat(64)}),/different/);
});
test('unknown claims never reset; invalid SQL receipt cannot become sent',async t=>{
 const {store,pg}=await setup(t);await store.claim(input);await assert.rejects(pg.query("UPDATE public.telegram_media_deliveries SET state='sent' WHERE request_key=$1",[input.key]));
 await store.settle(input.key,input.fingerprint,'unknown');assert.equal((await store.claim(input)).state,'unknown');await assert.rejects(store.settle(input.key,input.fingerprint,'sent',9),/unavailable/);
});
test('capacity stops new keys while existing keys remain queryable',async t=>{
 const {store,pg}=await setup(t);await store.claim(input);
 await pg.exec("INSERT INTO public.telegram_media_deliveries(request_key,fingerprint,state,created_at) SELECT lpad(to_hex(n),64,'0'),repeat('b',64),'unknown',1000 FROM generate_series(1,9999) AS n");
 await assert.rejects(store.claim({...input,key:'c'.repeat(64)}),/capacity/);assert.equal((await store.claim(input)).state,'inflight');
});

test('status reads never create rows and persist unknown/sent across instances',async t=>{
 const {store,db,pg}=await setup(t);assert.equal(await store.get(input.key),undefined);
 assert.equal(Number((await pg.query('SELECT count(*) AS n FROM public.telegram_media_deliveries')).rows[0].n),0);
 await store.claim(input);assert.deepEqual(await new PostgresMediaLedger(db).get(input.key),{state:'inflight'});
 await store.settle(input.key,input.fingerprint,'unknown');assert.deepEqual(await store.get(input.key),{state:'unknown'});
});
