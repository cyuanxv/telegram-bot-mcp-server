import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {handleAccountEnrollment} from '../lib/telegram/vault/account-enrollment-http.ts';
import {PostgresCredentialVault} from '../lib/telegram/vault/postgres-vault.ts';
const identity={user_id:'123',provider_authorization_verified:true,saved:false,activated:false};
function setup(){
 const env={TELEGRAM_ACCOUNT_ENROLLMENT_ENABLED:'true',TELEGRAM_ACCOUNT_ENROLLMENT_AUTH:randomBytes(32).toString('hex'),TELEGRAM_VAULT_OWNER_ID:'owner',TELEGRAM_VAULT_KEY_ID:'test',TELEGRAM_VAULT_KEY_BASE64:randomBytes(32).toString('base64')};
 const input={action:'stage',alias:'personal',expected_user_id:'123',apiId:1,apiHash:randomBytes(16).toString('hex'),session:'synthetic-session',confirm:true};
 const request=(body=input,headers={})=>new Request('https://example.test/api/internal/accounts/enroll',{method:'POST',headers:{authorization:`Bearer ${env.TELEGRAM_ACCOUNT_ENROLLMENT_AUTH}`,'content-type':'application/json',...headers},body:JSON.stringify(body)});
 return {env,input,request};
}
test('disabled, unauthorized, malformed and oversized requests never open database or contact Telegram',async()=>{
 const s=setup();let calls=0;const options={env:()=>s.env,open:async()=>{calls++;throw Error()},verify:async()=>{calls++;return identity}};
 s.env.TELEGRAM_ACCOUNT_ENROLLMENT_ENABLED='false';assert.equal((await handleAccountEnrollment(s.request(),options)).status,503);
 s.env.TELEGRAM_ACCOUNT_ENROLLMENT_ENABLED='true';assert.equal((await handleAccountEnrollment(s.request(s.input,{authorization:'Bearer wrong'}),options)).status,401);
 assert.equal((await handleAccountEnrollment(s.request(s.input,{'content-type':'text/plain'}),options)).status,415);
 for(const body of [{...s.input,ownerId:'other'},{...s.input,confirm:false},{...s.input,session:'x'.repeat(20000)},{action:'status',alias:'personal',session:'forbidden'}])assert.equal((await handleAccountEnrollment(s.request(body),options)).status,400);
 assert.equal(calls,0);
});
test('inspect returns only verified identity, rejects invalid provider result and configuration revocation',async()=>{
 const s=setup(),body={action:'inspect',apiId:s.input.apiId,apiHash:s.input.apiHash,session:s.input.session};let opens=0;
 const options={env:()=>s.env,open:async()=>{opens++;throw Error()},verify:async()=>({...identity,phone:'never-return'})};
 const response=await handleAccountEnrollment(s.request(body),options);assert.deepEqual(await response.json(),{status:'account_identity_verified',user_id:'123',saved:false,activated:false});assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(opens,0);
 options.verify=async()=>({...identity,user_id:'0'});assert.equal((await handleAccountEnrollment(s.request(body),options)).status,503);
 options.verify=async()=>{s.env.TELEGRAM_ACCOUNT_ENROLLMENT_ENABLED='false';return identity};assert.equal((await handleAccountEnrollment(s.request(body),options)).status,503);
});
test('HTTP staging encrypts exact identity, reconciles retries, isolates owner, and permits status without keyring',async t=>{
 const s=setup(),pg=new PGlite();t.after(()=>pg.close());await pg.exec(readFileSync(new URL('../migrations/003_credential_vault.sql',import.meta.url),'utf8'));
 const vault=new PostgresCredentialVault({transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))});let closes=0;
 const options={env:()=>s.env,verify:async()=>identity,open:async()=>({vault,close:async()=>{closes++}})};
 const first=await handleAccountEnrollment(s.request(),options);assert.equal(first.status,200);assert.equal((await first.json()).activated,false);
 const retry=await handleAccountEnrollment(s.request(),options);assert.equal((await retry.json()).reused,true);
 const rows=(await pg.query('SELECT owner_id,envelope FROM telegram_credential_vault')).rows;assert.equal(rows.length,1);assert.equal(rows[0].owner_id,'owner');assert.ok(!JSON.stringify(rows).includes(s.input.session));assert.ok(!JSON.stringify(rows).includes(s.input.apiHash));
 const wrong=await handleAccountEnrollment(s.request({...s.input,expected_user_id:'999'}),options);assert.equal(wrong.status,503);assert.equal((await wrong.json()).retry_automatically,false);
 delete s.env.TELEGRAM_VAULT_KEY_BASE64;
 assert.equal((await (await handleAccountEnrollment(s.request({action:'status',alias:'personal'}),options)).json()).staged,true);
 s.env.TELEGRAM_VAULT_OWNER_ID='other';assert.equal((await (await handleAccountEnrollment(s.request({action:'status',alias:'personal'}),options)).json()).staged,false);assert.equal(closes,5);
});
test('provider and database failures are sanitized and cleanup always runs',async()=>{
 const s=setup();let closes=0;
 const result=await handleAccountEnrollment(s.request(),{env:()=>s.env,open:async()=>({vault:{loadSealed:async()=>{throw Error(s.input.apiHash)},save:async()=>{}},close:async()=>{closes++;throw Error(s.input.session)}})});
 assert.equal(result.status,503);const body=await result.text();assert.ok(!body.includes(s.input.apiHash));assert.ok(!body.includes(s.input.session));assert.equal(closes,1);
});
test('aborted request and existing static alias never reach storage',async()=>{
 const s=setup();let opens=0;const options={env:()=>s.env,open:async()=>{opens++;throw Error()}};
 const controller=new AbortController();controller.abort();const request=new Request(s.request(),{signal:controller.signal});
 assert.notEqual((await handleAccountEnrollment(request,options)).status,200);assert.equal(opens,0);
 s.env.TELEGRAM_ACCOUNTS_JSON=JSON.stringify({personal:{apiId:1,apiHash:s.input.apiHash,session:s.input.session}});
 const response=await handleAccountEnrollment(s.request(),options);assert.equal(response.status,409);assert.equal(opens,0);
});
