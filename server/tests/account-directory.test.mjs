import {handleAccountManagement} from '../lib/telegram/vault/account-management-http.ts';
import {openRuntimeAccount,listVaultAccountSummaries} from '../lib/telegram/vault/runtime-accounts.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';
import {AccountManagement} from '../lib/telegram/vault/account-management.ts';
import {AccountDirectory} from '../lib/telegram/vault/account-directory.ts';import {PostgresCredentialVault} from '../lib/telegram/vault/postgres-vault.ts';import {sealCredential} from '../lib/telegram/vault/crypto.ts';
async function setup(t){const pg=new PGlite();t.after(()=>pg.close());for(const file of ['003_credential_vault.sql','012_account_directory.sql'])await pg.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));const db={transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))},vault=new PostgresCredentialVault(db),directory=new AccountDirectory(db),keys=new Map([['test',randomBytes(32)]]);const context={ownerId:'owner',alias:'personal',purpose:'mtproto_account'},secret={apiId:1,apiHash:randomBytes(16).toString('hex'),session:'synthetic-session',userId:'123'};const seal=revision=>sealCredential(context,secret,keys,'test',{revision,createdAt:Date.now()});await vault.save(seal(1),0);return {pg,directory,vault,keys,seal,value:{alias:'personal',userId:'123',vaultRevision:1,scope:{operations:['get_me','send_message'],peers:['123']}}}}
test('activation binds exact vault version; rotating credentials invalidates runtime while disable still works',async t=>{
 const s=await setup(t);assert.equal(await s.directory.loadActive('owner','personal'),undefined);
 const active=await s.directory.activate('owner',s.value,0);assert.equal(active.revision,1);assert.deepEqual((await s.directory.loadActive('owner','personal')).entry,active);
 await s.vault.save(s.seal(2),1);assert.equal(await s.directory.loadActive('owner','personal'),undefined);
 assert.equal((await s.directory.deactivate('owner','personal',1)).active,false);
 const renewed=await s.directory.activate('owner',{...s.value,vaultRevision:2},2);assert.equal(renewed.revision,3);assert.equal((await s.directory.loadActive('owner','personal')).envelope.revision,2);
});
test('stale revision, wrong owner or identity cannot replace or deactivate account binding',async t=>{
 const s=await setup(t);await s.directory.activate('owner',s.value,0);
 for(const [owner,value,revision] of [['owner',s.value,0],['other',s.value,0],['owner',{...s.value,userId:'999'},1],['owner',{...s.value,vaultRevision:2},1]])await assert.rejects(s.directory.activate(owner,value,revision));
 assert.equal(await s.directory.get('other','personal'),undefined);assert.equal(await s.directory.loadActive('other','personal'),undefined);
 await assert.rejects(s.directory.deactivate('other','personal',1));await assert.rejects(s.directory.deactivate('owner','personal',0));assert.equal((await s.directory.get('owner','personal')).revision,1);
});
test('peer capabilities require bounded explicit stable IDs and corrupt persisted scope cannot run',async t=>{
 const s=await setup(t);
 for(const scope of [{operations:['send_message'],peers:[]},{operations:['send_message'],peers:['@mutable']},{operations:['arbitrary'],peers:[]},{operations:['get_me','get_me'],peers:[]},{operations:['get_me'],peers:[],extra:true}])await assert.rejects(s.directory.activate('owner',{...s.value,scope},0));
 await s.directory.activate('owner',s.value,0);await s.pg.query("UPDATE telegram_account_directory SET scope='{}'::jsonb");await assert.rejects(s.directory.loadActive('owner','personal'));
});
test('new table has RLS and grants no public or Supabase API access, including default-grant roles',async t=>{
 const pg=new PGlite();t.after(()=>pg.close());await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon,authenticated,service_role;');
 for(const file of ['003_credential_vault.sql','012_account_directory.sql'])await pg.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 assert.equal((await pg.query("SELECT relrowsecurity AS enabled FROM pg_class WHERE relname='telegram_account_directory'")).rows[0].enabled,true);
 for(const role of ['anon','authenticated','service_role'])assert.equal((await pg.query("SELECT has_table_privilege($1,'telegram_account_directory','SELECT') AS permitted",[role])).rows[0].permitted,false);
});
test('management verifies sealed and live identity before binding; disable needs no usable key or provider',async t=>{
 const s=await setup(t),input={alias:'personal',user_id:'123',vault_revision:1,expected_revision:0,scope:s.value.scope,confirm:true};let calls=0;
 const deps={ownerId:'owner',keys:s.keys,vault:s.vault,directory:s.directory,guard:()=>{},verify:async()=>{calls++;return {user_id:'123',provider_authorization_verified:true,saved:false,activated:false}}};
 const management=new AccountManagement(deps);
 await assert.rejects(management.activate({...input,user_id:'999'}));assert.equal(calls,0);
 await assert.rejects(new AccountManagement({...deps,verify:async()=>({user_id:'999',provider_authorization_verified:true,saved:false,activated:false})}).activate(input));assert.equal(await s.directory.get('owner','personal'),undefined);
 const result=await management.activate(input);assert.equal(result.active,true);assert.equal(result.runtime_verified,false);
 const disabled=await new AccountManagement({...deps,keys:new Map(),verify:async()=>{throw Error('must not contact')}}).deactivate({alias:'personal',expected_revision:1,confirm:true});assert.equal(disabled.active,false);assert.equal(await s.directory.loadActive('owner','personal'),undefined);
});
test('revocation during verification prevents activation; lost activation acknowledgement remains queryable',async t=>{
 const s=await setup(t),input={alias:'personal',user_id:'123',vault_revision:1,expected_revision:0,scope:s.value.scope,confirm:true};let revoked=false;
 const deps={ownerId:'owner',keys:s.keys,vault:s.vault,directory:s.directory,guard:()=>{if(revoked)throw Error()},verify:async()=>{revoked=true;return {user_id:'123',provider_authorization_verified:true,saved:false,activated:false}}};
 await assert.rejects(new AccountManagement(deps).activate(input));assert.equal(await s.directory.get('owner','personal'),undefined);revoked=false;
 const losing={activate:async(...args)=>{await s.directory.activate(...args);throw Error('sensitive detail')}};
 await assert.rejects(new AccountManagement({...deps,directory:losing,verify:async()=>({user_id:'123',provider_authorization_verified:true,saved:false,activated:false})}).activate(input),/unconfirmed/);
 assert.equal((await s.directory.get('owner','personal')).active,true);
});
test('runtime resolves encrypted identity only for allowed operations and peers; rechecks revocation',async t=>{
 const s=await setup(t);await s.directory.activate('owner',s.value,0);let closes=0;
 const env={TELEGRAM_MTPROTO_ENABLED:'true',TELEGRAM_VAULT_ACCOUNTS_ENABLED:'true',TELEGRAM_VAULT_OWNER_ID:'owner',TELEGRAM_VAULT_KEY_ID:'test',TELEGRAM_VAULT_KEY_BASE64:s.keys.get('test').toString('base64')};
 const options={env:()=>env,open:async()=>({directory:s.directory,close:async()=>{closes++}})};
 for(const request of [{operation:'search',peer:'123'},{operation:'send_message',peer:'999'},{operation:'send_message',peer:'@someone'}])await assert.rejects(openRuntimeAccount('personal',request,options),/scope_denied/);
 const lease=await openRuntimeAccount('personal',{operation:'send_message',peer:'123'},options);assert.equal(lease.userId,'123');assert.equal(lease.config.session,'synthetic-session');await lease.assertCurrent();
 await s.directory.deactivate('owner','personal',1);await assert.rejects(lease.assertCurrent(),/state_changed/);await lease.close();assert.equal(closes,4);
 await assert.rejects(openRuntimeAccount('personal',{operation:'get_me'},options),/unavailable/);
 env.TELEGRAM_VAULT_ACCOUNTS_ENABLED='false';await assert.rejects(openRuntimeAccount('personal',{operation:'get_me'},options),/disabled/);
});
test('runtime does not release mismatched sealed identity and notices config changes',async t=>{
 const s=await setup(t);await s.directory.activate('owner',{...s.value,userId:'999'},0);
 const env={TELEGRAM_MTPROTO_ENABLED:'true',TELEGRAM_VAULT_ACCOUNTS_ENABLED:'true',TELEGRAM_VAULT_OWNER_ID:'owner',TELEGRAM_VAULT_KEY_ID:'test',TELEGRAM_VAULT_KEY_BASE64:s.keys.get('test').toString('base64')};
 const options={env:()=>env,open:async()=>({directory:s.directory,close:async()=>{}})};
 await assert.rejects(openRuntimeAccount('personal',{operation:'get_me'},options),/identity_mismatch/);
 await s.pg.query("UPDATE telegram_account_directory SET user_id='123'");const lease=await openRuntimeAccount('personal',{operation:'get_me'},options);
 env.TELEGRAM_MTPROTO_ENABLED='false';await assert.rejects(lease.assertCurrent(),/configuration_changed/);await lease.close();
});
test('management HTTP enforces gates and supports status/disable without keyring or runtime enabled',async t=>{
 const s=await setup(t);const env={TELEGRAM_ACCOUNT_MANAGEMENT_ENABLED:'true',TELEGRAM_ACCOUNT_ENROLLMENT_AUTH:randomBytes(32).toString('hex'),TELEGRAM_MTPROTO_ENABLED:'true',TELEGRAM_VAULT_ACCOUNTS_ENABLED:'true',TELEGRAM_VAULT_OWNER_ID:'owner',TELEGRAM_VAULT_KEY_ID:'test',TELEGRAM_VAULT_KEY_BASE64:s.keys.get('test').toString('base64')};
 const options={env:()=>env,open:async()=>({vault:s.vault,directory:s.directory,close:async()=>{}}),verify:async()=>({user_id:'123',provider_authorization_verified:true,saved:false,activated:false})};
 const request=body=>new Request('https://test/internal',{method:'POST',headers:{authorization:`Bearer ${env.TELEGRAM_ACCOUNT_ENROLLMENT_AUTH}`,'content-type':'application/json'},body:JSON.stringify(body)});
 const activate={action:'activate',alias:'personal',user_id:'123',vault_revision:1,expected_revision:0,scope:s.value.scope,confirm:true};
 const unauthorized=request(activate);unauthorized.headers.delete('authorization');assert.equal((await handleAccountManagement(unauthorized,options)).status,401);
 assert.equal((await handleAccountManagement(request({...activate,owner_id:'other'}),options)).status,400);
 assert.equal((await handleAccountManagement(request(activate),options)).status,200);
 const status=await (await handleAccountManagement(request({action:'status',alias:'personal'}),options)).json();assert.equal(status.credential_binding_current,true);assert.equal(status.runtime_verified,false);
 delete env.TELEGRAM_VAULT_KEY_BASE64;env.TELEGRAM_MTPROTO_ENABLED='false';
 assert.equal((await handleAccountManagement(request({...activate,expected_revision:1}),options)).status,503);
 assert.equal((await handleAccountManagement(request({action:'deactivate',alias:'personal',expected_revision:1,confirm:true}),options)).status,200);
 const stopped=await (await handleAccountManagement(request({action:'status',alias:'personal'}),options)).json();assert.equal(stopped.binding.active,false);assert.equal(stopped.credential_binding_current,false);assert.equal(stopped.runtime_enabled,false);
});

test('account inventory uses metadata only, never needs keys, excludes stale revisions and other owners',async t=>{
 const s=await setup(t);await s.directory.activate('owner',s.value,0);
 const env={TELEGRAM_VAULT_ACCOUNTS_ENABLED:'true',TELEGRAM_MTPROTO_ENABLED:'false',TELEGRAM_VAULT_OWNER_ID:'owner'};
 const options={env:()=>env,open:async()=>({directory:s.directory,close:async()=>{}})};
 const rows=await listVaultAccountSummaries(options);assert.equal(rows.length,1);assert.equal(rows[0].alias,'personal');assert.equal(rows[0].enabled,false);assert.equal(rows[0].runtime_verified,false);assert.ok(!JSON.stringify(rows).includes('synthetic-session'));
 env.TELEGRAM_VAULT_OWNER_ID='other';assert.deepEqual(await listVaultAccountSummaries(options),[]);env.TELEGRAM_VAULT_OWNER_ID='owner';
 await s.vault.save(s.seal(2),1);assert.deepEqual(await listVaultAccountSummaries(options),[]);
 env.TELEGRAM_VAULT_ACCOUNTS_ENABLED='false';assert.deepEqual(await listVaultAccountSummaries({env:()=>env,open:async()=>{throw Error('must not open')}}),[]);
});
