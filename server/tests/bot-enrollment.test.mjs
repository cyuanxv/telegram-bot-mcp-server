import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {enrollBot} from '../lib/telegram/vault/bot-enrollment.ts';
import {PostgresCredentialVault} from '../lib/telegram/vault/postgres-vault.ts';
import {openCredential} from '../lib/telegram/vault/crypto.ts';
const token='12345:'+randomBytes(24).toString('base64url');
const base=()=>({TELEGRAM_BOT_ENROLLMENT_ENABLED:'true',TELEGRAM_BOT_ENROLLMENT_AUTH:randomBytes(32).toString('hex'),TELEGRAM_VAULT_OWNER_ID:'owner-A',TELEGRAM_VAULT_KEY_ID:'key-A',TELEGRAM_VAULT_KEY_BASE64:randomBytes(32).toString('base64')});
const body=()=>({action:'stage',token,alias:'new-bot',expected_bot_id:12345});
const req=(e,b=body())=>new Request('https://service.test/api/internal/bots/enroll',{method:'POST',headers:{authorization:`Bearer ${e.TELEGRAM_BOT_ENROLLMENT_AUTH}`,'content-type':'application/json'},body:JSON.stringify(b)});
const verify=async(url,o)=>{assert.equal(url,`https://api.telegram.org/bot${token}/getMe`);assert.equal(o.redirect,'error');assert.equal(o.method,'POST');assert.equal(o.cache,'no-store');return Response.json({ok:true,result:{id:12345,is_bot:true,username:'NewBot',private:token}})};
const forbidden=async()=>{throw Error('unexpected side effect')};
test('disabled and unauthorized enrollment refuse before network or storage',async()=>{
 const e=base();const denied=await enrollBot(req(e),{env:()=>({}),fetcher:forbidden,open:forbidden});assert.equal(denied.status,503);
 const r=req(e);r.headers.delete('authorization');assert.equal((await enrollBot(r,{env:()=>e,fetcher:forbidden,open:forbidden})).status,401);
 for(const b of [{...body(),ownerId:'other'},{...body(),alias:'../escape'},{...body(),token:'invalid'}, {...body(),action:'rotate'}])assert.equal((await enrollBot(req(e,b),{env:()=>e,fetcher:forbidden,open:forbidden})).status,400);
});
test('inspect verifies only getMe, strips private data and never stores',async()=>{
 const e=base();const r=await enrollBot(req(e,{action:'inspect',token}),{env:()=>e,fetcher:verify,open:forbidden});
 assert.deepEqual(await r.json(),{status:'identity_verified',bot_id:12345,username:'NewBot',saved:false,activated:false});assert.equal(r.headers.get('cache-control'),'no-store');
});
test('wrong identity, configured aliases, malformed key and provider failure do not store',async()=>{
 const e=base();
 for(const [patch,b,expected] of [[{}, {...body(),expected_bot_id:999},409],[{TELEGRAM_BOTS_JSON:JSON.stringify({'new-bot':'existing-token'})},body(),409],[{TELEGRAM_VAULT_KEY_BASE64:'invalid'},body(),503]]){
  const env={...e,...patch};const r=await enrollBot(req(env,b),{env:()=>env,fetcher:verify,open:forbidden});assert.equal(r.status,expected);assert.ok(!(await r.text()).includes(token));
 }
 const r=await enrollBot(req(e),{env:()=>e,fetcher:async()=>{throw Error(token)},open:forbidden});assert.equal(r.status,502);assert.ok(!(await r.text()).includes(token));
});
test('revocation during identity lookup prevents storage',async()=>{
 const e=base();const r=await enrollBot(req(e),{env:()=>e,fetcher:async(...a)=>{const v=await verify(...a);e.TELEGRAM_BOT_ENROLLMENT_ENABLED='false';return v},open:forbidden});assert.equal(r.status,502);
});
test('staging persists only encrypted data, scopes owner and safely recognizes retry',async t=>{
 const pg=new PGlite();t.after(()=>pg.close());await pg.exec(readFileSync(new URL('../migrations/003_credential_vault.sql',import.meta.url),'utf8'));
 const e=base(),queries=[];let closes=0;const vault=new PostgresCredentialVault({transaction:fn=>pg.transaction(tx=>fn({query:async(sql,params)=>{queries.push(params);return tx.query(sql,params)}}))});
 const deps={env:()=>e,fetcher:verify,open:async()=>({vault,close:async()=>{closes++}})};
 const first=await (await enrollBot(req(e),deps)).json();assert.equal(first.status,'staged');assert.equal(first.activated,false);assert.equal(first.reused,false);assert.ok(!JSON.stringify(queries).includes(token));assert.ok(!JSON.stringify(first).includes(token));
 const again=await (await enrollBot(req(e),deps)).json();assert.equal(again.reused,true);assert.equal(again.revision,1);assert.equal(closes,2);
 const context={ownerId:'owner-A',alias:'new-bot',purpose:'bot_token'};
 const sealed=await vault.loadSealed(context);assert.equal(openCredential(context,sealed,new Map([['key-A',Buffer.from(e.TELEGRAM_VAULT_KEY_BASE64,'base64')]]),Date.now()).token,token);
 assert.equal(await vault.loadSealed({...context,ownerId:'owner-B'}),undefined);
 const changed=token.slice(0,-1)+(token.endsWith('a')?'b':'a');const r=await enrollBot(req(e,{...body(),token:changed}),{...deps,fetcher:async()=>Response.json({ok:true,result:{id:12345,is_bot:true,username:'NewBot'}})});assert.equal(r.status,409);
});
test('uncertain save does not retry or return sensitive errors and always closes',async()=>{
 const e=base();let saves=0,closes=0;
 const r=await enrollBot(req(e),{env:()=>e,fetcher:verify,open:async()=>({vault:{loadSealed:async()=>undefined,save:async()=>{saves++;throw Error(token)}},close:async()=>{closes++}})});
 assert.deepEqual(await r.json(),{status:'storage_unconfirmed',retry_automatically:false});assert.equal(saves,1);assert.equal(closes,1);
});
test('request size and upstream size are bounded without exposing their content',async()=>{
 const e=base();const large=await enrollBot(req(e,{action:'inspect',token,extra:'x'.repeat(9000)}),{env:()=>e,fetcher:forbidden,open:forbidden});assert.equal(large.status,400);
 const r=await enrollBot(req(e),{env:()=>e,fetcher:async()=>new Response('x'.repeat(33000)),open:forbidden});assert.equal(r.status,502);
});

test('rotation binds original identity/revision and invalidates active directory binding',async t=>{
 const {BotDirectory}=await import('../lib/telegram/vault/bot-directory.ts');
 const pg=new PGlite();t.after(()=>pg.close());
 for(const f of ['003_credential_vault.sql','006_bot_directory.sql'])await pg.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const db={transaction:fn=>pg.transaction(tx=>fn({query:(sql,p)=>tx.query(sql,p)}))},vault=new PostgresCredentialVault(db),directory=new BotDirectory(db),e=base();
 const deps={env:()=>e,fetcher:verify,open:async()=>({vault,close:async()=>{}})};
 await enrollBot(req(e),deps);await directory.set('owner-A',{alias:'new-bot',botId:12345,vaultRevision:1,active:true},0);
 const fresh='12345:'+randomBytes(24).toString('base64url');
 const rotate={action:'rotate',alias:'new-bot',token:fresh,expected_bot_id:12345,expected_revision:1,confirm:'replace_token'};
 const fetcher=async()=>Response.json({ok:true,result:{id:12345,is_bot:true,username:'NewBot'}});
 for(const patch of [{confirm:undefined},{expected_revision:0},{expected_revision:Number.MAX_SAFE_INTEGER}])assert.equal((await enrollBot(req(e,{...rotate,...patch}),{...deps,fetcher:forbidden})).status,400);
 assert.equal((await enrollBot(req(e,{...rotate,token}),deps)).status,409);
 assert.equal((await enrollBot(req(e,{...rotate,expected_revision:2}),{...deps,fetcher})).status,409);
 assert.equal((await enrollBot(req(e,{...rotate,alias:'unknown'}),{...deps,fetcher})).status,404);
 const changedId={...rotate,token:'67890:'+randomBytes(24).toString('base64url'),expected_bot_id:67890};
 assert.equal((await enrollBot(req(e,changedId),{...deps,fetcher:async()=>Response.json({ok:true,result:{id:67890,is_bot:true,username:'OtherBot'}})})).status,409);
 assert.equal((await directory.listActive('owner-A')).length,1);
 const r=await enrollBot(req(e,rotate),{...deps,fetcher});assert.equal(r.status,200);const v=await r.json();assert.equal(v.revision,2);assert.equal(v.requires_reactivation,true);assert.equal(v.activated,false);assert.ok(!JSON.stringify(v).includes(fresh));
 assert.deepEqual(await directory.listActive('owner-A'),[]);
 assert.equal((await enrollBot(req(e,rotate),{...deps,fetcher})).status,409);
 const context={ownerId:'owner-A',alias:'new-bot',purpose:'bot_token'},sealed=await vault.loadSealed(context);
 assert.equal(openCredential(context,sealed,new Map([['key-A',Buffer.from(e.TELEGRAM_VAULT_KEY_BASE64,'base64')]]),Date.now()).token,fresh);
});

test('rotation conflicts and lost save acknowledgements never retry',async()=>{
 const {sealCredential,VaultError}=await import('../lib/telegram/vault/crypto.ts');const e=base();
 const context={ownerId:'owner-A',alias:'new-bot',purpose:'bot_token'};
 const sealed=sealCredential(context,{token},new Map([['key-A',Buffer.from(e.TELEGRAM_VAULT_KEY_BASE64,'base64')]]),'key-A',{revision:1,createdAt:Date.now()});
 const rotate={...body(),action:'rotate',token:'12345:'+randomBytes(24).toString('base64url'),expected_revision:1,confirm:'replace_token'};
 for(const conflict of [true,false]){let saves=0;const r=await enrollBot(req(e,rotate),{env:()=>e,fetcher:async()=>Response.json({ok:true,result:{id:12345,is_bot:true,username:'NewBot'}}),open:async()=>({vault:{loadSealed:async()=>sealed,save:async()=>{saves++;throw conflict?new VaultError('revision_conflict'):Error(token)}},close:async()=>{}})});assert.equal(saves,1);assert.deepEqual(await r.json(),{status:conflict?'state_changed':'storage_unconfirmed',retry_automatically:false});}
});
