import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes,randomUUID} from 'node:crypto';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';
import {sealLoginState,openLoginState} from '../lib/telegram/vault/account-login-state.ts';import {AccountLoginStore,LOGIN_TTL_MS} from '../lib/telegram/vault/account-login-store.ts';
const now=1000000;const state={phase:'prepared',apiId:1,apiHash:randomBytes(16).toString('hex'),phone:'+12345678901'};
function data(){const keys=new Map([['key',randomBytes(32)]]),c={ownerId:'owner',id:randomUUID(),alias:'personal',revision:1,expiresAt:now+LOGIN_TTL_MS};return {keys,c,envelope:sealLoginState(c,state,keys,'key')}}
async function setup(t){const pg=new PGlite();t.after(()=>pg.close());await pg.exec(readFileSync(new URL('../migrations/014_account_login.sql',import.meta.url),'utf8'));const store=new AccountLoginStore({transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))});return {pg,store,...data()}}
test('login encryption binds owner/challenge/alias/revision/expiry; code and password cannot be persisted',()=>{
 const s=data();assert.deepEqual(openLoginState(s.c,s.envelope,s.keys,now),state);assert.ok(!JSON.stringify(s.envelope).includes(state.phone));assert.ok(!JSON.stringify(s.envelope).includes(state.apiHash));
 for(const patch of [{ownerId:'other'},{id:randomUUID()},{alias:'other'},{revision:2},{expiresAt:s.c.expiresAt+1}])assert.throws(()=>openLoginState({...s.c,...patch},s.envelope,s.keys,now));
 assert.throws(()=>openLoginState(s.c,s.envelope,s.keys,s.c.expiresAt));for(const patch of [{code:'12345'},{password:randomBytes(16).toString('hex')}])assert.throws(()=>sealLoginState(s.c,{...state,...patch},s.keys,'key'));
});
test('creation is idempotent, one pending challenge per alias, expiry bounded and owner isolated',async t=>{
 const s=await setup(t);await s.store.create(s.c,s.envelope,now);assert.equal((await s.store.create(s.c,s.envelope,now)).revision,1);assert.equal(await s.store.get('other',s.c.id),undefined);
 await assert.rejects(s.store.create({...s.c,id:randomUUID()},s.envelope,now));await assert.rejects(s.store.create({...s.c,expiresAt:now+LOGIN_TTL_MS+1},s.envelope,now));
 const stored=(await s.pg.query('SELECT * FROM telegram_account_login')).rows;assert.ok(!JSON.stringify(stored).includes(state.apiHash));
});
test('single-use claims serialize requests and completion advances encrypted revision',async t=>{
 const s=await setup(t);await s.store.create(s.c,s.envelope,now);const first=randomUUID(),second=randomUUID();
 const outcomes=await Promise.allSettled([s.store.claim('owner',s.c.id,1,first,now),s.store.claim('owner',s.c.id,1,second,now)]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 const claimed=await s.store.get('owner',s.c.id);assert.equal(claimed.attempts,1);await assert.rejects(s.store.claim('owner',s.c.id,1,claimed.claim,now));
 const next={...s.c,revision:2},secret={...state,phase:'code_required',session:'synthetic-session',phoneCodeHash:'synthetic-hash',delivery:'app'},sealed=sealLoginState(next,secret,s.keys,'key');
 await s.store.settle('owner',s.c.id,1,claimed.claim,sealed,now);const settled=await s.store.get('owner',s.c.id);assert.equal(settled.revision,2);assert.deepEqual(openLoginState(settled,settled.envelope,s.keys,now),secret);await assert.rejects(s.store.settle('owner',s.c.id,1,claimed.claim,sealed,now));
});
test('cancellation wipes encrypted state and invalidates late results; expiration blocks work and purge deletes rows',async t=>{
 const s=await setup(t);await s.store.create(s.c,s.envelope,now);const claim=randomUUID();await s.store.claim('owner',s.c.id,1,claim,now);await s.store.cancel('owner',s.c.id);assert.equal((await s.store.get('owner',s.c.id)).envelope,null);await assert.rejects(s.store.settle('owner',s.c.id,1,claim,s.envelope,now));
 const next={...s.c,id:randomUUID()};await s.store.create(next,sealLoginState(next,state,s.keys,'key'),now);await assert.rejects(s.store.claim('owner',next.id,1,randomUUID(),next.expiresAt));await s.store.purgeExpired(next.expiresAt);assert.equal(await s.store.get('owner',next.id),undefined);
});
test('five-step cap survives request reconstruction and no expired claim is automatically retried',async t=>{
 const s=await setup(t);await s.store.create(s.c,s.envelope,now);
 for(let revision=1;revision<=5;revision++){const claim=randomUUID();await s.store.claim('owner',s.c.id,revision,claim,now);await s.store.settle('owner',s.c.id,revision,claim,sealLoginState({...s.c,revision:revision+1},state,s.keys,'key'),now)}
 await assert.rejects(s.store.claim('owner',s.c.id,6,randomUUID(),now));assert.equal((await s.store.get('owner',s.c.id)).attempts,5);
});
