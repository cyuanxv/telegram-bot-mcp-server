import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {manageBot} from '../lib/telegram/vault/bot-management.ts';
import {PostgresCredentialVault} from '../lib/telegram/vault/postgres-vault.ts';
import {BotScopeStore} from '../lib/telegram/vault/bot-scope-store.ts';
import {BotDirectory} from '../lib/telegram/vault/bot-directory.ts';
import {sealCredential} from '../lib/telegram/vault/crypto.ts';
const token='12345:'+randomBytes(24).toString('base64url');
const config=()=>({TELEGRAM_BOT_MANAGEMENT_ENABLED:'true',TELEGRAM_BOT_ENROLLMENT_AUTH:randomBytes(32).toString('hex'),TELEGRAM_VAULT_OWNER_ID:'owner-A',TELEGRAM_VAULT_KEY_ID:'k',TELEGRAM_VAULT_KEY_BASE64:randomBytes(32).toString('base64'),TELEGRAM_VAULT_BOTS_ENABLED:'true'});
const input=(action='activate',revision=0)=>({action,alias:'reports',expected_bot_id:12345,expected_credential_revision:1,expected_revision:revision,confirm:action});
const req=(e,body)=>new Request('https://service.test/api/internal/bots/manage',{method:'POST',headers:{authorization:`Bearer ${e.TELEGRAM_BOT_ENROLLMENT_AUTH}`,'content-type':'application/json'},body:JSON.stringify(body)});
async function setup(t){const pg=new PGlite();t.after(()=>pg.close());for(const p of ['003_credential_vault.sql','006_bot_directory.sql','007_bot_scope.sql'])await pg.exec(readFileSync(new URL('../migrations/'+p,import.meta.url),'utf8'));const db={transaction:fn=>pg.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))};const env=config(),vault=new PostgresCredentialVault(db),directory=new BotDirectory(db),scope=new BotScopeStore(db);await vault.save(sealCredential({ownerId:'owner-A',alias:'reports',purpose:'bot_token'},{token},new Map([['k',Buffer.from(env.TELEGRAM_VAULT_KEY_BASE64,'base64')]]),'k',{revision:1,createdAt:Date.now()}),0);let calls=0,closed=0;const deps={env:()=>env,open:async()=>({vault,directory,scope,close:async()=>{closed++}}),fetcher:async(url,options)=>{calls++;assert.equal(url,`https://api.telegram.org/bot${token}/getMe`);assert.equal(options.redirect,'error');return Response.json({ok:true,result:{id:12345,is_bot:true}})}};return {env,vault,directory,scope,deps,counts:()=>({calls,closed})}}
test('disabled, unauthorized, extra owner/token fields and missing confirmation are rejected before resources',async()=>{
 const env=config(),deps={env:()=>env,open:async()=>assert.fail('storage forbidden'),fetcher:async()=>assert.fail('network forbidden')};
 assert.equal((await manageBot(req(env,input()),{...deps,env:()=>({})})).status,503);
 const r=req(env,input());r.headers.delete('authorization');assert.equal((await manageBot(r,deps)).status,401);
 for(const body of [{...input(),ownerId:'other'},{...input(),token},{...input(),confirm:undefined},{action:'status',alias:'../x'}])assert.equal((await manageBot(req(env,body),deps)).status,400);
});
test('status is storage-only; explicit activation verifies identity and stale writes fail',async t=>{
 const s=await setup(t),status=await (await manageBot(req(s.env,{action:'status',alias:'reports'}),s.deps)).json();assert.equal(status.state,'staged');assert.equal(status.revision,0);assert.equal(s.counts().calls,0);assert.ok(!JSON.stringify(status).includes(token));
 const active=await (await manageBot(req(s.env,input()),s.deps)).json();assert.equal(active.state,'active');assert.equal(active.revision,1);assert.equal(s.counts().calls,1);
 assert.equal((await manageBot(req(s.env,input()),s.deps)).status,409);assert.equal(s.counts().calls,1);
 const off=await (await manageBot(req(s.env,input('deactivate',1)),s.deps)).json();assert.equal(off.state,'inactive');assert.equal(off.revision,2);assert.equal(s.counts().calls,1);assert.equal(await s.directory.loadActive('owner-A','reports'),undefined);
});
test('deactivation works without valid master key and never calls Telegram',async t=>{
 const s=await setup(t);await manageBot(req(s.env,input()),s.deps);delete s.env.TELEGRAM_VAULT_KEY_BASE64;
 const r=await manageBot(req(s.env,input('deactivate',1)),{...s.deps,fetcher:async()=>assert.fail('must not contact Telegram')});assert.equal(r.status,200);assert.equal((await r.json()).active,false);
});
test('wrong provider identity or revoked configuration cannot activate',async t=>{
 const s=await setup(t);
 for(const fetcher of [async()=>Response.json({ok:true,result:{id:999,is_bot:true}}),async()=>{throw Error(token)},async()=>{s.env.TELEGRAM_BOT_MANAGEMENT_ENABLED='false';return Response.json({ok:true,result:{id:12345,is_bot:true}})}]){const r=await manageBot(req(s.env,input()),{...s.deps,fetcher});assert.ok(r.status>=400);assert.ok(!(await r.text()).includes(token));assert.equal(await s.directory.loadActive('owner-A','reports'),undefined)}
});
test('runtime disabled and environment Bot aliases cannot activate or overwrite',async t=>{
 const s=await setup(t);s.env.TELEGRAM_VAULT_BOTS_ENABLED='false';assert.equal((await manageBot(req(s.env,input()),s.deps)).status,409);assert.equal(s.counts().calls,0);
 s.env.TELEGRAM_BOTS_JSON=JSON.stringify({reports:'synthetic-environment'});assert.equal((await manageBot(req(s.env,input()),s.deps)).status,409);assert.equal(await s.directory.loadActive('owner-A','reports'),undefined);
});
test('lost save acknowledgement reports unknown, does not retry and is resolved by status',async t=>{
 const s=await setup(t);let writes=0;const original=s.directory.set.bind(s.directory);s.directory.set=async(...a)=>{writes++;await original(...a);throw Error(token)};
 const r=await manageBot(req(s.env,input()),s.deps);assert.equal((await r.json()).status,'state_unconfirmed');assert.equal(writes,1);
 const status=await (await manageBot(req(s.env,{action:'status',alias:'reports'}),s.deps)).json();assert.equal(status.state,'active');assert.equal(status.revision,1);
});

test('persistent permission control binds activation to scope version and requires reactivation after edits',async t=>{
 const s=await setup(t);s.env.TELEGRAM_VAULT_SCOPE_STORE_ENABLED='true';
 const read=async()=>await (await manageBot(req(s.env,{action:'status',alias:'reports'}),s.deps)).json();
 assert.equal((await read()).scope_revision,0);
 assert.equal((await manageBot(req(s.env,{...input(),expected_scope_revision:0}),s.deps)).status,409);assert.equal(s.counts().calls,0);
 const save={...input('scope_save'),expected_scope_revision:0,policy:{methods:['getMe','sendMessage'],chat_ids:['-123']}};
 const saved=await (await manageBot(req(s.env,save),s.deps)).json();assert.equal(saved.status,'scope_saved');assert.equal(saved.scope_revision,1);assert.equal(saved.active,false);assert.ok(!JSON.stringify(saved).includes(token));
 const active=await (await manageBot(req(s.env,{...input(),expected_scope_revision:1}),s.deps)).json();assert.equal(active.state,'active');assert.equal(active.scope_revision,1);assert.equal(active.active,true);assert.equal((await s.directory.listActive('owner-A',true)).length,1);
 const edit={...save,expected_revision:1,expected_scope_revision:1,policy:{methods:['getMe'],chat_ids:[]}};
 assert.equal((await manageBot(req(s.env,edit),s.deps)).status,200);
 const next=await read();assert.equal(next.active,false);assert.equal(next.revision,2);assert.equal(next.scope_revision,2);assert.equal((await s.directory.listActive('owner-A',true)).length,0);
 assert.equal((await manageBot(req(s.env,{...input('activate',2),expected_scope_revision:1}),s.deps)).status,409);
 assert.equal((await manageBot(req(s.env,{...input('activate',2),expected_scope_revision:2}),s.deps)).status,200);
});
test('scope edit during provider verification cannot activate stale permissions',async t=>{
 const s=await setup(t);s.env.TELEGRAM_VAULT_SCOPE_STORE_ENABLED='true';
 const change={alias:'reports',botId:12345,vaultRevision:1,policy:{methods:['getMe'],chat_ids:[]}};await s.scope.save('owner-A',change,0);
 const fetcher=async()=>{await s.scope.save('owner-A',change,1);return Response.json({ok:true,result:{id:12345,is_bot:true}})};
 const r=await manageBot(req(s.env,{...input(),expected_scope_revision:1}),{...s.deps,fetcher});assert.equal(r.status,409);assert.equal(await s.directory.loadActive('owner-A','reports',true),undefined);
});
test('scope actions default off and uncertain writes are not retried',async t=>{
 const s=await setup(t),save={...input('scope_save'),expected_scope_revision:0,policy:{methods:['getMe'],chat_ids:[]}};
 assert.ok((await manageBot(req(s.env,save),s.deps)).status>=400);
 s.env.TELEGRAM_VAULT_SCOPE_STORE_ENABLED='true';let writes=0;const original=s.scope.save.bind(s.scope);s.scope.save=async(...a)=>{writes++;await original(...a);throw Error(token)};
 const r=await manageBot(req(s.env,save),s.deps);assert.equal((await r.json()).status,'state_unconfirmed');assert.equal(writes,1);assert.equal((await s.scope.get('owner-A','reports')).revision,1);
});

test('inventory lists only owner Bot aliases and revisions without decryption or provider calls',async t=>{
 const s=await setup(t);delete s.env.TELEGRAM_VAULT_KEY_BASE64;
 const r=await manageBot(req(s.env,{action:'list'}),{...s.deps,fetcher:async()=>assert.fail('no provider request')});
 assert.deepEqual(await r.json(),{status:'bot_inventory',bots:[{alias:'reports',credential_revision:1}],live_status:'not_checked'});
 for(const extra of [{ownerId:'other'},{alias:'reports'},{token}])assert.equal((await manageBot(req(s.env,{action:'list',...extra}),s.deps)).status,400);
 s.env.TELEGRAM_VAULT_OWNER_ID='other-owner';assert.deepEqual((await (await manageBot(req(s.env,{action:'list'}),s.deps)).json()).bots,[]);
});
