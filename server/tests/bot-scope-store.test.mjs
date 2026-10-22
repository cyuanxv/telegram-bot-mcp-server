import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {BotScopeStore} from '../lib/telegram/vault/bot-scope-store.ts';
import {PostgresCredentialVault} from '../lib/telegram/vault/postgres-vault.ts';
import {BotDirectory} from '../lib/telegram/vault/bot-directory.ts';
import {sealCredential} from '../lib/telegram/vault/crypto.ts';
const owner='telegram-cloud-owner',alias='reports',context={ownerId:owner,alias,purpose:'bot_token'},keys=new Map([['test',randomBytes(32)]]);
const seal=r=>sealCredential(context,{token:'12345:'+randomBytes(24).toString('base64url')},keys,'test',{revision:r,createdAt:Date.now()});
const input={alias,botId:12345,vaultRevision:1,policy:{methods:['sendMessage','getMe'],chat_ids:['-123']}};
async function setup(t){
 const pg=new PGlite();t.after(()=>pg.close());
 await pg.exec('CREATE ROLE telegram_runtime; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon,authenticated,service_role');
 for(const f of ['003_credential_vault.sql','006_bot_directory.sql','007_bot_scope.sql','007_bot_scope_runtime.example.sql'])await pg.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const db={transaction:fn=>pg.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))};return {pg,db,vault:new PostgresCredentialVault(db),directory:new BotDirectory(db),scope:new BotScopeStore(db)};
}
test('persistent scopes bind owner, identity and credential revision; saving revokes activation atomically',async t=>{
 const {vault,directory,scope}=await setup(t);await vault.save(seal(1),0);
 await directory.set(owner,{alias,botId:12345,vaultRevision:1,active:true},0);
 const saved=await scope.save(owner,input,0);assert.equal(saved.revision,1);assert.equal((await directory.get(owner,alias)).active,false);assert.equal((await directory.get(owner,alias)).revision,2);
 await assert.rejects(scope.save(owner,input,1,1),/revision_conflict/);
 assert.equal(await scope.get('other-owner',alias),undefined);
 assert.deepEqual((await scope.get(owner,alias)).policy,{methods:['getMe','sendMessage'],chat_ids:['-123']});
 await assert.rejects(scope.save(owner,input,0),/revision_conflict/);
 await assert.rejects(scope.save(owner,{...input,botId:999},1),/revision_conflict/);
 await vault.save(seal(2),1);await assert.rejects(scope.save(owner,input,1),/revision_conflict/);
 assert.equal((await scope.save(owner,{...input,vaultRevision:2},1)).revision,2);
});
test('concurrent scope updates have one winner and revoke stale activation revision',async t=>{
 const {vault,directory,scope}=await setup(t);await vault.save(seal(1),0);await scope.save(owner,input,0);
 await directory.set(owner,{alias,botId:12345,vaultRevision:1,active:true},0);
 const result=await Promise.allSettled([scope.save(owner,input,1),scope.save(owner,{...input,policy:{methods:[],chat_ids:[]}},1)]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal((await scope.get(owner,alias)).revision,2);
 await assert.rejects(directory.set(owner,{alias,botId:12345,vaultRevision:1,active:true},1),/revision_conflict/);
});
test('failure revoking activation rolls back policy write; errors do not expose driver details',async t=>{
 const {pg,vault,scope}=await setup(t);await vault.save(seal(1),0);await scope.save(owner,input,0);
 const broken=new BotScopeStore({transaction:fn=>pg.transaction(tx=>fn({query:(s,p)=>{if(s.startsWith('UPDATE public.telegram_bot_directory'))throw Error('secret-driver-detail');return tx.query(s,p)}}))});
 await assert.rejects(broken.save(owner,{...input,policy:{methods:[],chat_ids:[]}},1),e=>e.message==='Credential vault: scope_unavailable');
 assert.equal((await scope.get(owner,alias)).revision,1);assert.equal((await scope.get(owner,alias)).policy.methods.length,2);
 await assert.rejects(scope.save(owner,{...input,policy:{methods:['arbitraryMethod'],chat_ids:[]}},1),/invalid_scope/);
});
test('scope migration removes default API grants and restricts runtime owner with no delete',async t=>{
 const {pg,vault,scope}=await setup(t);await vault.save(seal(1),0);await scope.save(owner,input,0);
 for(const role of ['anon','authenticated','service_role']){
  const r=await pg.query("SELECT has_table_privilege($1,'public.telegram_bot_scope','SELECT,INSERT,UPDATE,DELETE') AS permitted",[role]);assert.equal(r.rows[0].permitted,false);
 }
 await pg.exec('SET ROLE telegram_runtime');
 assert.equal((await pg.query('SELECT count(*) AS n FROM public.telegram_bot_scope')).rows[0].n,1);
 await pg.query("UPDATE public.telegram_bot_scope SET policy=$1::jsonb WHERE alias='reports'",[JSON.stringify({methods:[],chat_ids:[]})]);
 await assert.rejects(pg.query("UPDATE public.telegram_bot_scope SET owner_id='other' WHERE alias='reports'"),/row-level security/);
 await assert.rejects(pg.query('DELETE FROM public.telegram_bot_scope'),/permission denied/);
 await pg.exec('RESET ROLE');
});
