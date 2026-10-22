import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {authorizeInboxBot} from '../lib/telegram/inbox/vault-access.ts';
import {PostgresInboxStore} from '../lib/telegram/inbox/postgres-inbox.ts';
import {normalizedUpdate} from '../lib/telegram/inbox/normalize.ts';
import {PostgresCredentialVault} from '../lib/telegram/vault/postgres-vault.ts';
import {BotDirectory} from '../lib/telegram/vault/bot-directory.ts';
import {BotScopeStore} from '../lib/telegram/vault/bot-scope-store.ts';
import {sealCredential} from '../lib/telegram/vault/crypto.ts';
const owner='telegram-cloud-owner',alias='reports',key=new Map([['test',randomBytes(32)]]);
const env=()=>({TELEGRAM_VAULT_BOTS_ENABLED:'true',TELEGRAM_VAULT_SCOPE_STORE_ENABLED:'true',TELEGRAM_VAULT_OWNER_ID:owner});
const seal=(revision,expiresAt)=>sealCredential({ownerId:owner,alias,purpose:'bot_token'},{token:'12345:'+randomBytes(24).toString('base64url')},key,'test',{revision,createdAt:1000,...(expiresAt?{expiresAt}:{})});
const policy={secretToken:'synthetic_123456789012345678901234',allowedChatIds:['-123','-456'],retainText:true,retentionDays:7};
const event=(id=1,chat=-123)=>normalizedUpdate({update_id:id,message:{message_id:id,date:1,chat:{id:chat},text:'test'}},alias,policy,2000);
const read={botAlias:alias,chatIds:['-123'],now:2000};
async function setup(t,expiresAt){
 const pg=new PGlite();t.after(()=>pg.close());
 for(const f of ['002_telegram_inbox.sql','003_credential_vault.sql','006_bot_directory.sql','007_bot_scope.sql'])await pg.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const db={transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};
 const vault=new PostgresCredentialVault(db),directory=new BotDirectory(db),scopes=new BotScopeStore(db);
 await vault.save(seal(1,expiresAt),0);
 await scopes.save(owner,{alias,botId:12345,vaultRevision:1,policy:{methods:['getMe'],chat_ids:['-123']}},0);
 await directory.set(owner,{alias,botId:12345,vaultRevision:1,scopeRevision:1,active:true},0);
 let live=env(),clock=2000;
 const authorize=authorizeInboxBot(()=>live,()=>clock);
 return {pg,db,vault,directory,scopes,store:new PostgresInboxStore(db,authorize),authorize,setEnv:v=>live=v,setTime:v=>clock=v};
}
test('active vault inbox persists and reads only approved chats; deactivation blocks both without deleting history',async t=>{
 const s=await setup(t);assert.equal(await s.store.record(event()),'stored');assert.equal((await s.store.list(read)).length,1);
 await assert.rejects(s.store.record(event(2,-456)));await assert.rejects(s.store.list({...read,chatIds:['-456']}));
 await s.directory.set(owner,{alias,botId:12345,vaultRevision:1,scopeRevision:1,active:false},1);
 await assert.rejects(s.store.record(event(3)));await assert.rejects(s.store.list(read));
 assert.equal(Number((await s.pg.query('SELECT count(*) AS n FROM public.telegram_inbox_events')).rows[0].n),1);
});
test('rotated credential and edited permissions invalidate old activation for inbox access',async t=>{
 const s=await setup(t);await s.store.record(event());await s.vault.save(seal(2),1);
 await assert.rejects(s.store.list(read));await assert.rejects(s.store.record(event(2)));
 await s.scopes.save(owner,{alias,botId:12345,vaultRevision:2,policy:{methods:['getMe'],chat_ids:['-123']}},1);
 const entry=await s.directory.get(owner,alias,true);
 await s.directory.set(owner,{alias,botId:12345,vaultRevision:2,scopeRevision:2,active:true},entry.revision);
 assert.equal((await s.store.list(read)).length,1);
 await s.scopes.save(owner,{alias,botId:12345,vaultRevision:2,policy:{methods:['getMe'],chat_ids:[]}},2);
 await assert.rejects(s.store.list(read));
});
test('static bots need no new tables and vault default is closed before SQL',async()=>{
 let queries=0;const sql={query:async()=>{queries++;throw Error('must not query')}};
 await authorizeInboxBot(()=>({TELEGRAM_BOT_TOKEN:'synthetic'}))(sql,'default',['-123']);
 for(const e of [{},{...env(),TELEGRAM_VAULT_BOTS_ENABLED:'false'},{...env(),TELEGRAM_VAULT_SCOPE_STORE_ENABLED:'false'}])await assert.rejects(authorizeInboxBot(()=>e)(sql,alias,['-123']));
 assert.equal(queries,0);
});
test('expired credentials, wrong owner and runtime revocation deny reads; final guard rolls back inserts',async t=>{
 const s=await setup(t,3000);s.setTime(3000);await assert.rejects(s.store.record(event()));s.setTime(2000);
 s.setEnv({...env(),TELEGRAM_VAULT_OWNER_ID:'other-owner'});await assert.rejects(s.store.list(read));s.setEnv(env());
 const wrapped={transaction:fn=>s.db.transaction(sql=>fn({query:async(q,p)=>{const r=await sql.query(q,p);if(q.startsWith('INSERT INTO public.telegram_inbox_events'))s.setEnv({...env(),TELEGRAM_VAULT_BOTS_ENABLED:'false'});return r}}))};
 await assert.rejects(new PostgresInboxStore(wrapped,s.authorize).record(event()));
 assert.equal(Number((await s.pg.query('SELECT count(*) AS n FROM public.telegram_inbox_events')).rows[0].n),0);
});
