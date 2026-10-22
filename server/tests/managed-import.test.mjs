import test from 'node:test';import assert from 'node:assert/strict';
import {importManagedBot} from '../lib/telegram/vault/managed-import.ts';
const input={manager_alias:'default',managed_bot_id:12345,target_alias:'child',confirm:true};
const setup=()=>({TELEGRAM_BOT_TOKEN:'synthetic-manager',TELEGRAM_BOT_ENROLLMENT_AUTH:'x'.repeat(32),TELEGRAM_BOT_ENROLLMENT_ENABLED:'true',TELEGRAM_MANAGED_IMPORT_ENABLED:'true',TELEGRAM_MANAGED_IMPORT_TARGETS_JSON:JSON.stringify([{manager_alias:'default',managed_bot_id:12345,target_alias:'child'}])});
const token='12345:'+'a'.repeat(24);
test('managed token goes only to private enrollment and public result excludes raw fields',async()=>{
 const env=setup();let calls=0;
 const out=await importManagedBot(input,{env:()=>env,fetcher:async(url,o)=>{calls++;assert.equal(url,'https://api.telegram.org/botsynthetic-manager/getManagedBotToken');assert.equal(o.redirect,'error');assert.deepEqual(JSON.parse(o.body),{user_id:12345});return Response.json({ok:true,result:token})},enroll:async req=>{calls++;assert.equal((await req.json()).token,token);return Response.json({status:'staged',alias:'child',bot_id:12345,revision:1,reused:false,token})}});
 assert.equal(out.status,'managed_bot_staged');assert.equal(out.activation_performed,false);assert.equal(calls,2);assert.ok(!JSON.stringify(out).includes(token));
});
test('default-off, exact target and input gates refuse before token retrieval',async()=>{
 const fetcher=async()=>assert.fail('no network');
 for(const patch of [{TELEGRAM_MANAGED_IMPORT_ENABLED:'false'},{TELEGRAM_MANAGED_IMPORT_TARGETS_JSON:'[]'},{TELEGRAM_MANAGED_IMPORT_TARGETS_JSON:'null'},{TELEGRAM_BOT_ENROLLMENT_ENABLED:'false'}])await assert.rejects(importManagedBot(input,{env:()=>({...setup(),...patch}),fetcher}));
 for(const patch of [{target_alias:'other'},{managed_bot_id:999},{confirm:false},{token:'injected'}])await assert.rejects(importManagedBot({...input,...patch},{env:setup,fetcher}));
});
test('wrong child identity, revocation, provider errors and uncertain save never leak or retry',async()=>{
 for(const cause of ['identity','revoke','provider','save']){
  const env=setup();let calls=0;
  const out=await importManagedBot(input,{env:()=>env,fetcher:async()=>{calls++;if(cause==='provider')throw Error(token);if(cause==='revoke')env.TELEGRAM_MANAGED_IMPORT_ENABLED='false';return Response.json({ok:true,result:cause==='identity'?'999:'+token.split(':')[1]:token})},enroll:async()=>{if(cause!=='save')assert.fail('must not stage');throw Error(token)}});
  assert.equal(out.status,cause==='save'?'storage_unconfirmed':'managed_import_failed');assert.equal(calls,1);assert.ok(!JSON.stringify(out).includes(token));assert.equal(out.retry_automatically,false);
 }
});

test('real enrollment seals the retrieved child token and never activates it',async()=>{
 const {enrollBot}=await import('../lib/telegram/vault/bot-enrollment.ts');
 const {openCredential}=await import('../lib/telegram/vault/crypto.ts');
 const {randomBytes}=await import('node:crypto');const key=randomBytes(32),env={...setup(),TELEGRAM_VAULT_OWNER_ID:'owner-A',TELEGRAM_VAULT_KEY_ID:'k',TELEGRAM_VAULT_KEY_BASE64:key.toString('base64')};
 let envelope,closed=0;const calls=[];
 const out=await importManagedBot(input,{env:()=>env,fetcher:async(url)=>{calls.push(url.endsWith('/getManagedBotToken')?'manager':'child');return url.endsWith('/getManagedBotToken')?Response.json({ok:true,result:token}):Response.json({ok:true,result:{id:12345,is_bot:true,username:'SyntheticChildBot'}})},enroll:(req,options)=>enrollBot(req,{...options,open:async()=>({vault:{loadSealed:async()=>undefined,save:async(e,expected)=>{assert.equal(expected,0);envelope=e}},close:async()=>{closed++}})})});
 assert.equal(out.status,'managed_bot_staged');assert.deepEqual(calls,['manager','child']);assert.equal(closed,1);assert.ok(!JSON.stringify(envelope).includes(token));
 assert.deepEqual(openCredential({ownerId:'owner-A',alias:'child',purpose:'bot_token'},envelope,new Map([['k',key]]),Date.now()),{token});key.fill(0);
});
