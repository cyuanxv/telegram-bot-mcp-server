import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {BotDirectory} from '../lib/telegram/vault/bot-directory.ts';
import {PostgresCredentialVault} from '../lib/telegram/vault/postgres-vault.ts';
import {sealCredential} from '../lib/telegram/vault/crypto.ts';
const context={ownerId:'owner-A',alias:'reports',purpose:'bot_token'},keys=new Map([['k',randomBytes(32)]]);
const seal=revision=>sealCredential(context,{token:'12345:'+randomBytes(24).toString('base64url')},keys,'k',{revision,createdAt:Date.now()});
async function setup(t){const pg=new PGlite();t.after(()=>pg.close());for(const file of ['003_credential_vault.sql','006_bot_directory.sql'])await pg.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));const db={transaction:fn=>pg.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))};return {pg,vault:new PostgresCredentialVault(db),directory:new BotDirectory(db)}}
const change={alias:'reports',botId:12345,vaultRevision:1,active:true};
test('staged credentials stay inactive until explicit version-bound activation',async t=>{
 const {vault,directory}=await setup(t);await vault.save(seal(1),0);
 assert.equal(await directory.loadActive('owner-A','reports'),undefined);
 const result=await directory.set('owner-A',change,0);assert.equal(result.revision,1);assert.equal((await directory.loadActive('owner-A','reports')).entry.botId,12345);
 assert.equal(await directory.loadActive('owner-B','reports'),undefined);assert.deepEqual(await directory.list('owner-B'),[]);
 await directory.set('owner-A',{...change,active:false},1);assert.equal(await directory.loadActive('owner-A','reports'),undefined);assert.deepEqual(await directory.listActive('owner-A'),[]);
});
test('credential rotation invalidates active binding and cannot change bot identity under same alias',async t=>{
 const {vault,directory}=await setup(t);await vault.save(seal(1),0);await directory.set('owner-A',change,0);await vault.save(seal(2),1);
 assert.equal(await directory.loadActive('owner-A','reports'),undefined);assert.deepEqual(await directory.listActive('owner-A'),[]);
 await assert.rejects(directory.set('owner-A',change,1),/revision_conflict/);
 await assert.rejects(directory.set('owner-A',{...change,vaultRevision:2,botId:999},1),/revision_conflict/);
 assert.equal((await directory.set('owner-A',{...change,vaultRevision:2},1)).revision,2);
});
test('concurrent activation CAS allows one winner and missing credentials cannot activate',async t=>{
 const {vault,directory}=await setup(t);await assert.rejects(directory.set('owner-A',change,0),/revision_conflict/);await vault.save(seal(1),0);
 const outcomes=await Promise.allSettled([directory.set('owner-A',change,0),directory.set('owner-A',change,0)]);assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);assert.equal((await directory.list('owner-A')).length,1);
});
test('directory sanitizes driver failures and rejects invalid scope or state',async()=>{
 const directory=new BotDirectory({transaction:async()=>{throw Error('private-driver-marker')}});
 await assert.rejects(directory.list('owner-A'),e=>e.message==='Credential vault: directory_unavailable');
 await assert.rejects(directory.set('owner-A',{...change,active:'true'},0),/invalid_directory/);
 await assert.rejects(directory.loadActive('owner-A','../escape'),/invalid_context/);
});
