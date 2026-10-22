import test from 'node:test';import assert from 'node:assert/strict';
import {handleManagedImport} from '../lib/telegram/vault/managed-import-http.ts';
const auth='synthetic-auth-'.repeat(3),env={TELEGRAM_MANAGED_IMPORT_ENABLED:'true',TELEGRAM_BOT_ENROLLMENT_AUTH:auth};
const input={manager_alias:'default',managed_bot_id:12345,target_alias:'child',confirm:true};
const req=(body=input,headers={})=>new Request('https://server.test/import',{method:'POST',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json',...headers},body:JSON.stringify(body)});
const forbidden=async()=>assert.fail('must not reach importer');
test('private import refuses disabled, unauthenticated and malformed requests before touching tokens',async()=>{
 assert.equal((await handleManagedImport(req(),{env:()=>({}),importer:forbidden})).status,503);
 assert.equal((await handleManagedImport(req(input,{authorization:'Bearer wrong'}),{env:()=>env,importer:forbidden})).status,401);
 assert.equal((await handleManagedImport(req(input,{'content-type':'text/plain'}),{env:()=>env,importer:forbidden})).status,415);
 for(const body of [{...input,token:'private'},{...input,confirm:false},{...input,ownerId:'other'},{...input,target_alias:'a'.repeat(9000)}])assert.equal((await handleManagedImport(req(body),{env:()=>env,importer:forbidden})).status,400);
});
test('private import projects identity-bound result and never echoes provider data or retries',async()=>{
 const good={status:'managed_bot_staged',alias:'child',bot_id:12345,revision:1,reused:false,activation_performed:false,token:'private-marker'};
 for(const patch of [{},{alias:'other'},{bot_id:999},{revision:0},{activation_performed:true},{reused:'false'}]){
  let calls=0;const r=await handleManagedImport(req(),{env:()=>env,importer:async args=>{calls++;assert.deepEqual(args,input);return {...good,...patch}}});
  assert.equal(calls,1);assert.equal(r.status,Object.keys(patch).length?503:200);assert.ok(!(await r.text()).includes('private-marker'));
 }
 const r=await handleManagedImport(req(),{env:()=>env,importer:async()=>{throw Error(auth)}});assert.equal(r.status,503);assert.ok(!(await r.text()).includes(auth));
});
