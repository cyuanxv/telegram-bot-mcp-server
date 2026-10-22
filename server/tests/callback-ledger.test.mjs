import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {PostgresCallbackAnswerStore} from '../lib/telegram/inbox/callback-answers.ts';
import {PostgresInboxStore} from '../lib/telegram/inbox/postgres-inbox.ts';
import {normalizedUpdate} from '../lib/telegram/inbox/normalize.ts';
const inboxSQL=readFileSync(new URL('../migrations/002_telegram_inbox.sql',import.meta.url),'utf8');
const ledgerSQL=readFileSync(new URL('../migrations/004_callback_answers.sql',import.meta.url),'utf8');
async function setup(t){
 const pg=new PGlite();t.after(()=>pg.close());await pg.exec(inboxSQL);await pg.exec(ledgerSQL);
 const db={transaction:fn=>pg.transaction(tx=>fn({query:(sql,values)=>tx.query(sql,values)}))};
 const inbox=new PostgresInboxStore(db);
 const event=normalizedUpdate({update_id:1,callback_query:{id:'query-secret',from:{id:42},message:{message_id:9,date:0,chat:{id:-123}},data:'payload'}},'reports',{secretToken:'synthetic_callback_secret_12345678',allowedChatIds:['-123'],retainText:true,retentionDays:7,acceptCallbacks:true},1000000);
 await inbox.record(event);const sequence=(await inbox.list({botAlias:'reports',chatIds:['-123'],now:1000000}))[0].sequence;
 return {pg,db,inbox,event,store:new PostgresCallbackAnswerStore(db),input:{key:'a'.repeat(64),fingerprint:'b'.repeat(64),sequence,createdAt:1000000}};
}
test('concurrent PostgreSQL claims dispatch once, reused across store instances, and bind reviewed content',async t=>{
 const {store,db,input}=await setup(t);const results=await Promise.all(Array.from({length:12},()=>store.claim(input)));
 assert.equal(results.filter(x=>x==='claimed').length,1);assert.equal(results.filter(x=>x==='inflight').length,11);
 const reopened=new PostgresCallbackAnswerStore(db);assert.equal(await reopened.claim(input),'inflight');
 await assert.rejects(reopened.claim({...input,fingerprint:'c'.repeat(64)}),/different answer/);
 await store.settle(input.key,input.fingerprint,'answered');assert.equal(await reopened.claim(input),'answered');
 await assert.rejects(store.settle(input.key,input.fingerprint,'unknown'),/unavailable/);
});
test('unknown result stays non-retryable and inbox cleanup cascades ledger without new timer',async t=>{
 const {store,input,pg,inbox,event}=await setup(t);await store.claim(input);await store.settle(input.key,input.fingerprint,'unknown');assert.equal(await store.claim(input),'unknown');
 const before=(await pg.query('SELECT * FROM public.telegram_callback_answers')).rows;assert.equal(before.length,1);assert.ok(!JSON.stringify(before).includes('query-secret'));assert.ok(!JSON.stringify(before).includes('payload'));
 await inbox.purgeExpired(event.expiresAt);assert.equal((await pg.query('SELECT * FROM public.telegram_callback_answers')).rows.length,0);
 await assert.rejects(store.claim(input));
});
test('missing inbox and invalid claim metadata never create orphan claims',async t=>{
 const {store,input,pg}=await setup(t);
 for(const patch of [{sequence:'999'},{sequence:'0'},{key:'bad'},{createdAt:-1}])await assert.rejects(store.claim({...input,...patch}));
 assert.equal((await pg.query('SELECT * FROM public.telegram_callback_answers')).rows.length,0);
});

test('readiness rejects a missing ledger and accepts its installed schema',async t=>{
 const {store,pg}=await setup(t);await store.assertReady();
 await pg.exec('DROP TABLE public.telegram_callback_answers');
 await assert.rejects(store.assertReady());
});
