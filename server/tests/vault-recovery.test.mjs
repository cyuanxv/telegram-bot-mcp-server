import test from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';import {randomBytes} from 'node:crypto';
import {sealCredential} from '../lib/telegram/vault/crypto.ts';
import {PostgresCredentialVault} from '../lib/telegram/vault/postgres-vault.ts';
import {BotDirectory} from '../lib/telegram/vault/bot-directory.ts';
import {BotScopeStore} from '../lib/telegram/vault/bot-scope-store.ts';
import {resolveRuntimeBot} from '../lib/telegram/vault/runtime-bots.ts';
const context={ownerId:'recovery-owner',alias:'recovery-bot',purpose:'bot_token'};
const wrap=pg=>({transaction:fn=>pg.transaction(tx=>fn({query:(...a)=>tx.query(...a)}))});
test('isolated database restore needs old key and must revoke restored activation before reopening runtime',async t=>{
 const pg=new PGlite();t.after(()=>pg.close());
 for(const file of ['003_credential_vault.sql','006_bot_directory.sql','007_bot_scope.sql'])await pg.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const db=wrap(pg),vault=new PostgresCredentialVault(db),directory=new BotDirectory(db),scopes=new BotScopeStore(db);
 const key=randomBytes(32),token='12345:'+randomBytes(24).toString('base64url');
 const envelope=sealCredential(context,{token},new Map([['old',key]]),'old',{revision:1,createdAt:Date.now()});
 await vault.save(envelope,0);
 const permission={alias:context.alias,botId:12345,vaultRevision:1,policy:{methods:['getMe'],chat_ids:[]}};
 await scopes.save(context.ownerId,permission,0,0);
 await directory.set(context.ownerId,{alias:context.alias,botId:12345,vaultRevision:1,scopeRevision:1,active:true},0);
 // Actual in-memory database archive and a distinct restored engine, not cloned row mocks.
 const backup=await pg.dumpDataDir();const restored=new PGlite({loadDataDir:backup});t.after(()=>restored.close());
 const restoredDb=wrap(restored),restoredDirectory=new BotDirectory(restoredDb),restoredScopes=new BotScopeStore(restoredDb);
 const env={TELEGRAM_VAULT_BOTS_ENABLED:'false',TELEGRAM_VAULT_SCOPE_STORE_ENABLED:'true',TELEGRAM_VAULT_OWNER_ID:context.ownerId,TELEGRAM_VAULT_KEY_ID:'new',TELEGRAM_VAULT_KEY_BASE64:randomBytes(32).toString('base64')};
 const deps={env:()=>env,request:{method:'getMe',params:{}},open:async()=>({directory:restoredDirectory,scope:restoredScopes,close:async()=>{}})};
 await assert.rejects(resolveRuntimeBot(context.alias,deps));
 assert.equal((await restoredDirectory.get(context.ownerId,context.alias,true)).active,true);
 // Demonstrate the hazard: restoring a full DB also restores its activation flags.
 env.TELEGRAM_VAULT_BOTS_ENABLED='true';await assert.rejects(resolveRuntimeBot(context.alias,deps),/credential_unavailable|key_unavailable/);
 env.TELEGRAM_VAULT_PREVIOUS_KEYS_JSON=JSON.stringify({old:key.toString('base64')});
 assert.equal((await resolveRuntimeBot(context.alias,deps)).config.token,token);
 env.TELEGRAM_VAULT_BOTS_ENABLED='false';
 await restoredScopes.save(context.ownerId,permission,1,1);
 assert.equal((await restoredDirectory.get(context.ownerId,context.alias,true)).active,false);
 env.TELEGRAM_VAULT_BOTS_ENABLED='true';await assert.rejects(resolveRuntimeBot(context.alias,deps),/bot_unavailable/);
 await restoredDirectory.set(context.ownerId,{alias:context.alias,botId:12345,vaultRevision:1,scopeRevision:2,active:true},2);
 assert.equal((await resolveRuntimeBot(context.alias,deps)).config.token,token);
 // Changes to restored storage do not mutate the source snapshot/database.
 assert.equal((await directory.get(context.ownerId,context.alias,true)).scopeRevision,1);
 key.fill(0);
});
