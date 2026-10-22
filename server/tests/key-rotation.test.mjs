import test from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';import {randomBytes} from 'node:crypto';
import {KeyRotation,rotationScope} from '../lib/telegram/vault/key-rotation.ts';
import {sealCredential,openCredential} from '../lib/telegram/vault/crypto.ts';
const keys=new Map([['old',randomBytes(32)],['new',randomBytes(32)]]);
const scope={ownerId:'owner-A',aliases:['b','a'],fromKeyId:'old',toKeyId:'new'};
async function setup(t){
 const pg=new PGlite();await pg.exec(readFileSync(new URL('../migrations/003_credential_vault.sql',import.meta.url),'utf8'));t.after(()=>pg.close());
 for(const ownerId of ['owner-A','other'])for(const alias of ['a','b','c']){
  const e=sealCredential({ownerId,alias,purpose:'bot_token'},{token:'synthetic-private-marker'},keys,'old',{revision:1,createdAt:1000});
  await pg.query("INSERT INTO public.telegram_credential_vault(owner_id,alias,purpose,revision,envelope) VALUES($1,$2,'bot_token',1,$3::jsonb)",[ownerId,alias,JSON.stringify(e)]);
 }
 const db={transaction:fn=>pg.transaction(tx=>fn({query:(...args)=>tx.query(...args)}))};return {pg,db};
}
test('rotation plans exact owners and aliases; reviewed batch commits without plaintext output',async t=>{
 const {pg,db}=await setup(t),r=new KeyRotation(db,scope,()=>{});const plan=await r.plan();
 assert.equal(plan.count,2);assert.deepEqual(plan.scope.aliases,['a','b']);assert.equal(plan.credentials_verified,false);assert.ok(!JSON.stringify(plan).includes('ciphertext'));
 const out=await r.apply(plan.digest,keys,2000);assert.equal(out.count,2);assert.ok(!JSON.stringify(out).includes('synthetic-private-marker'));
 const rows=(await pg.query('SELECT owner_id,alias,revision,envelope FROM public.telegram_credential_vault')).rows;
 for(const row of rows){const changed=row.owner_id==='owner-A'&&['a','b'].includes(row.alias);assert.equal(Number(row.revision),changed?2:1);assert.equal(row.envelope.keyId,changed?'new':'old');assert.equal(openCredential({ownerId:row.owner_id,alias:row.alias,purpose:'bot_token'},row.envelope,keys,2000).token,'synthetic-private-marker')}
 await assert.rejects(r.apply(plan.digest,keys,2000),/rotation_state_changed/);
});
test('drift and missing scope deny before writing, later failure rolls back entire batch',async t=>{
 const {pg,db}=await setup(t),r=new KeyRotation(db,scope,()=>{});const plan=await r.plan();
 await assert.rejects(r.apply('0'.repeat(64),keys,2000),/rotation_state_changed/);
 await assert.rejects(new KeyRotation(db,{...scope,aliases:['missing']},()=>{}).plan(),/rotation_state_changed/);
 let updates=0;const failing={transaction:fn=>pg.transaction(tx=>fn({query:async(sql,args)=>{if(sql.startsWith('UPDATE')&&++updates===2)throw Error('synthetic failure');return tx.query(sql,args)}}))};
 await assert.rejects(new KeyRotation(failing,scope,()=>{}).apply(plan.digest,keys,2000));assert.equal(updates,2);
 assert.equal(Number((await pg.query('SELECT max(revision) AS n FROM public.telegram_credential_vault')).rows[0].n),1);
 const badKeys=new Map([['old',randomBytes(32)],['new',keys.get('new')]]);await assert.rejects(r.apply(plan.digest,badKeys,2000));assert.equal((await r.plan()).digest,plan.digest);
});
test('scope copies inputs and rejects broad, duplicate or malformed selectors',()=>{
 for(const patch of [{aliases:[]},{aliases:['a','a']},{aliases:['../a']},{aliases:Array.from({length:101},(_,i)=>'a'+i)},{toKeyId:'old'},{ownerId:''},{extra:true}])assert.throws(()=>rotationScope({...scope,...patch}));
 const value=rotationScope(scope);value.aliases.push('other');assert.deepEqual(scope.aliases,['b','a']);
});


test('metadata inspection distinguishes source, target, other and missing without fetching ciphertext',async t=>{
 const {pg,db}=await setup(t);const calls=[];
 const captured={transaction:fn=>db.transaction(sql=>fn({query:(q,p)=>{calls.push(q);return sql.query(q,p)}}))};
 const r=new KeyRotation(captured,{...scope,aliases:['a','b','c','missing']},()=>{});
 const before=await r.inspect();assert.deepEqual(before.records.map(r=>r.key_state),['source','source','source','missing']);
 assert.ok(calls.every(q=>!q.includes('SELECT alias,revision,envelope FROM')&&!q.includes('ciphertext')));
 const batch=new KeyRotation(db,{...scope,aliases:['a']},()=>{});await batch.apply((await batch.plan()).digest,keys,2000);
 const extra=new Map([...keys,['third',randomBytes(32)]]);const other=new KeyRotation(db,{...scope,aliases:['c'],toKeyId:'third'},()=>{});await other.apply((await other.plan()).digest,extra,2000);
 const after=await r.inspect();assert.deepEqual(after.records.map(r=>r.key_state),['target','source','other','missing']);assert.equal(after.records[0].revision,2);assert.equal(after.credentials_verified,false);
 assert.ok(!JSON.stringify(after).includes('synthetic-private-marker'));
 await pg.query("UPDATE public.telegram_credential_vault SET envelope=jsonb_set(envelope,'{keyId}','\"bad key\"'::jsonb) WHERE owner_id='owner-A' AND alias='a'");
 await assert.rejects(r.inspect(),/invalid_metadata/);
});
