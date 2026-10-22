import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {loadVaultKeyring} from '../lib/telegram/vault/keyring.ts';
import {rewrapCredential} from '../lib/telegram/vault/rewrap.ts';
import {sealCredential,openCredential} from '../lib/telegram/vault/crypto.ts';
const context={ownerId:'owner-A',alias:'reports',purpose:'bot_token'};
const old=randomBytes(32),current=randomBytes(32);
const env={TELEGRAM_VAULT_KEY_ID:'new',TELEGRAM_VAULT_KEY_BASE64:current.toString('base64'),TELEGRAM_VAULT_PREVIOUS_KEYS_JSON:JSON.stringify({old:old.toString('base64')})};
test('keyring reads previous records and disposal erases retained byte buffers',()=>{
 const ring=loadVaultKeyring(env);assert.equal(ring.activeKeyId,'new');assert.equal(ring.keys.size,2);
 const refs=[...ring.keys.values()];ring.dispose();assert.equal(ring.keys.size,0);assert.ok(refs.every(b=>b.every(v=>v===0)));
 assert.notEqual(old.toString('base64'),Buffer.alloc(32).toString('base64'));
 for(const raw of ['[]','null','bad',JSON.stringify({new:old.toString('base64')}),JSON.stringify({old:'bad'}),JSON.stringify(Object.fromEntries(Array.from({length:5},(_,i)=>['k'+i,old.toString('base64')]))),' '.repeat(2049)])assert.throws(()=>loadVaultKeyring({...env,TELEGRAM_VAULT_PREVIOUS_KEYS_JSON:raw}),/key_unavailable/);
});
test('rewrap preserves identity, content and expiry with fresh encryption and incremented revision',()=>{
 const ring=loadVaultKeyring(env);try{
 const before=sealCredential(context,{token:'synthetic'},ring.keys,'old',{revision:1,createdAt:1000,expiresAt:5000});
 const after=rewrapCredential(context,before,ring.keys,'new',2000);
 assert.equal(after.keyId,'new');assert.equal(after.revision,2);assert.equal(after.createdAt,1000);assert.equal(after.expiresAt,5000);assert.notEqual(after.nonce,before.nonce);
 assert.deepEqual(openCredential(context,after,new Map([['new',current]]),2000),{token:'synthetic'});
 assert.throws(()=>openCredential(context,after,new Map([['old',old]]),2000));
 assert.throws(()=>rewrapCredential(context,before,ring.keys,'old',2000),/invalid_rotation/);
 assert.throws(()=>rewrapCredential({...context,ownerId:'other'},before,ring.keys,'new',2000));
 assert.throws(()=>rewrapCredential(context,before,ring.keys,'new',5000));
 }finally{ring.dispose()}
});
