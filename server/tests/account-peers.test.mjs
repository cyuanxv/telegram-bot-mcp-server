import {Api} from 'teleproto';import bigInt from 'big-integer';
import {captureAccountPeer,restoreAccountPeer} from '../lib/telegram/mtproto-peers.ts';
import {openRuntimeAccount} from '../lib/telegram/vault/runtime-accounts.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';
import {sealAccountPeer,openAccountPeer,accountPeerId,AccountPeerStore} from '../lib/telegram/vault/account-peers.ts';
import {AccountDirectory} from '../lib/telegram/vault/account-directory.ts';import {PostgresCredentialVault} from '../lib/telegram/vault/postgres-vault.ts';import {sealCredential} from '../lib/telegram/vault/crypto.ts';
const context={ownerId:'owner',alias:'personal',userId:'123',vaultRevision:1,peerId:'456'};
const peer={kind:'user',id:'456',accessHash:'-1234567890123456789'};
test('peer encryption authenticates owner/account/session and peer, with no plaintext access hash',()=>{
 const keys=new Map([['key',randomBytes(32)]]),sealed=sealAccountPeer(context,peer,keys,'key');assert.deepEqual(openAccountPeer(context,sealed,keys),peer);assert.ok(!JSON.stringify(sealed).includes(peer.accessHash));
 for(const patch of [{ownerId:'other'},{alias:'other'},{userId:'999'},{vaultRevision:2},{peerId:'999'}])assert.throws(()=>openAccountPeer({...context,...patch},sealed,keys));
 assert.throws(()=>openAccountPeer(context,{...sealed,createdAt:sealed.createdAt+1},keys));assert.throws(()=>openAccountPeer(context,sealed,new Map([['key',randomBytes(32)]])));
 assert.equal(accountPeerId({kind:'channel',id:'456',accessHash:'0'}),'-1000000000456');assert.equal(accountPeerId({kind:'chat',id:'456'}),'-456');
 assert.throws(()=>sealAccountPeer(context,{...peer,id:'999'},keys,'key'));assert.throws(()=>sealAccountPeer(context,{...peer,accessHash:'9223372036854775808'},keys,'key'));
});
async function setup(t){const pg=new PGlite();t.after(()=>pg.close());for(const name of ['003_credential_vault.sql','012_account_directory.sql','013_account_peers.sql'])await pg.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));const db={transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))},store=new AccountPeerStore(db),directory=new AccountDirectory(db),vault=new PostgresCredentialVault(db),keys=new Map([['key',randomBytes(32)]]);const vaultContext={ownerId:'owner',alias:'personal',purpose:'mtproto_account'},secret={apiId:1,apiHash:randomBytes(16).toString('hex'),session:'synthetic-session',userId:'123'};const credential=revision=>sealCredential(vaultContext,secret,keys,'key',{revision,createdAt:Date.now()});await vault.save(credential(1),0);await directory.activate('owner',{alias:'personal',userId:'123',vaultRevision:1,scope:{operations:['get_me'],peers:[]}},0);return {pg,db,store,directory,vault,keys,credential}}
test('persisted peer resolves after recreating store, remains encrypted and is hidden across owner/session',async t=>{
 const s=await setup(t),sealed=sealAccountPeer(context,peer,s.keys,'key');await s.store.save(context,sealed);
 const loaded=await new AccountPeerStore(s.db).load(context);assert.deepEqual(openAccountPeer(context,loaded,s.keys),peer);
 const rows=(await s.pg.query('SELECT * FROM telegram_account_peers')).rows;assert.ok(!JSON.stringify(rows).includes(peer.accessHash));
 assert.equal(await s.store.load({...context,ownerId:'other'}),undefined);assert.equal(await s.store.load({...context,userId:'999'}),undefined);
 await s.vault.save(s.credential(2),1);assert.equal(await s.store.load(context),undefined);await assert.rejects(s.store.save(context,sealed));
});
test('deactivation blocks cache reads and writes; reactivation uses exact current revision',async t=>{
 const s=await setup(t),sealed=sealAccountPeer(context,peer,s.keys,'key');await s.store.save(context,sealed);await s.directory.deactivate('owner','personal',1);assert.equal(await s.store.load(context),undefined);await assert.rejects(s.store.save(context,sealed));
 await s.directory.activate('owner',{alias:'personal',userId:'123',vaultRevision:1,scope:{operations:['get_me'],peers:[]}},2);assert.deepEqual(openAccountPeer(context,await s.store.load(context),s.keys),peer);
});
test('cache migration revokes API roles even when default privileges were granted',async t=>{
 const pg=new PGlite();t.after(()=>pg.close());await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon,authenticated,service_role;');for(const name of ['003_credential_vault.sql','013_account_peers.sql'])await pg.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 for(const role of ['anon','authenticated','service_role'])assert.equal((await pg.query("SELECT has_table_privilege($1,'telegram_account_peers','SELECT') AS permitted",[role])).rows[0].permitted,false);
});

test('SDK peer projection and reconstruction preserve IDs without exporting entity details',()=>{
 const entity=new Api.InputPeerUser({userId:bigInt(peer.id),accessHash:bigInt(peer.accessHash)});
 assert.deepEqual(captureAccountPeer(entity),peer);const restored=restoreAccountPeer(peer);assert.ok(restored instanceof Api.InputPeerUser);assert.equal(restored.accessHash.toString(),peer.accessHash);assert.equal(captureAccountPeer({phone:'private'}),undefined);
});
test('runtime caches only approved dialog targets and reuses them across request leases',async t=>{
 const s=await setup(t);await s.directory.activate('owner',{alias:'personal',userId:'123',vaultRevision:1,scope:{operations:['list_dialogs','send_message'],peers:['456']}},1);
 const env={TELEGRAM_MTPROTO_ENABLED:'true',TELEGRAM_VAULT_ACCOUNTS_ENABLED:'true',TELEGRAM_ACCOUNT_PEER_CACHE_ENABLED:'true',TELEGRAM_VAULT_OWNER_ID:'owner',TELEGRAM_VAULT_KEY_ID:'key',TELEGRAM_VAULT_KEY_BASE64:s.keys.get('key').toString('base64')};
 const options={env:()=>env,open:async()=>({directory:s.directory,peers:new AccountPeerStore(s.db),close:async()=>{}})};
 const listing=await openRuntimeAccount('personal',{operation:'list_dialogs'},options);await listing.savePeers([peer,{...peer,id:'999'}]);await listing.close();assert.equal((await s.pg.query('SELECT count(*)::int AS n FROM telegram_account_peers')).rows[0].n,1);
 const sending=await openRuntimeAccount('personal',{operation:'send_message',peer:'456'},options);assert.deepEqual(await sending.loadPeer(),peer);await assert.rejects(sending.savePeers([peer]),/scope_denied/);await sending.close();
});
