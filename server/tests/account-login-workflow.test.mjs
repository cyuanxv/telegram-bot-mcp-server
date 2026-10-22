import {handleAccountLogin} from '../lib/telegram/vault/account-login-http.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes,randomUUID} from 'node:crypto';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';
import {AccountLoginWorkflow} from '../lib/telegram/vault/account-login-workflow.ts';import {AccountLoginStore} from '../lib/telegram/vault/account-login-store.ts';import {AccountEnrollment} from '../lib/telegram/vault/account-enrollment.ts';import {PostgresCredentialVault} from '../lib/telegram/vault/postgres-vault.ts';import {AccountLoginError} from '../lib/telegram/vault/account-login-provider.ts';
async function setup(t){const pg=new PGlite();t.after(()=>pg.close());for(const f of ['003_credential_vault.sql','014_account_login.sql'])await pg.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));const db={transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))},store=new AccountLoginStore(db),vault=new PostgresCredentialVault(db),keys=new Map([['key',randomBytes(32)]]);let now=Date.now(),calls=[];
 const enrollment=new AccountEnrollment({ownerId:'owner',keyId:'key',keys,vault,guard:()=>{},verify:async()=>({user_id:'123',provider_authorization_verified:true,saved:false,activated:false})});
 const deps={ownerId:'owner',keyId:'key',keys,store,enrollment,guard:()=>{},now:()=>now,provider:async input=>{calls.push(input.action);if(input.action==='request_code')return {phase:'code_required',session:'synthetic-session',phoneCodeHash:'synthetic-hash',delivery:'app'};if(input.action==='submit_code')return {phase:'password_required',session:'synthetic-session'};return {phase:'authorized',session:'synthetic-session',userId:'123'}}};
 const input={id:randomUUID(),alias:'personal',apiId:1,apiHash:randomBytes(16).toString('hex'),phone:'+12345678901'};return {pg,store,vault,deps,input,calls,workflow:new AccountLoginWorkflow(deps),setNow:v=>now=v}}
test('complete code and 2FA flow stores only encrypted continuation, then stages exact account without activation',async t=>{
 const s=await setup(t),id=s.input.id;const prepared=await s.workflow.prepare(s.input);assert.equal(prepared.phase,'prepared');assert.equal((await s.workflow.prepare(s.input)).revision,1);assert.deepEqual(s.calls,[]);
 const code=await s.workflow.advance({action:'request_code',id,revision:1,confirm:true});assert.equal(code.phase,'code_required');assert.equal(code.revision,2);
 const password=await s.workflow.advance({action:'submit_code',id,revision:2,code:'12345'});assert.equal(password.phase,'password_required');
 const authorized=await s.workflow.advance({action:'submit_password',id,revision:3,password:randomBytes(12).toString('hex')});assert.equal(authorized.user_id,'123');assert.equal(authorized.phase,'authorized');
 for(const value of [prepared,code,password,authorized])assert.ok(!JSON.stringify(value).includes(s.input.apiHash));
 const rows=(await s.pg.query('SELECT * FROM telegram_account_login')).rows;for(const secret of [s.input.phone,s.input.apiHash,'synthetic-session','synthetic-hash'])assert.ok(!JSON.stringify(rows).includes(secret));
 await assert.rejects(s.workflow.finish({id,revision:4,expected_user_id:'999',confirm:true}));assert.equal((await s.pg.query('SELECT count(*)::int AS n FROM telegram_credential_vault')).rows[0].n,0);
 const staged=await s.workflow.finish({id,revision:4,expected_user_id:'123',confirm:true});assert.equal(staged.phase,'staged');assert.equal(staged.activated,false);assert.equal((await s.workflow.status(id)).phase,'closed');assert.equal((await s.store.get('owner',id)).envelope,null);
 assert.deepEqual(s.calls,['request_code','submit_code','submit_password']);
});
test('wrong code returns a fresh revision while stale replay never calls provider again',async t=>{
 const s=await setup(t),id=s.input.id;await s.workflow.prepare(s.input);await s.workflow.advance({action:'request_code',id,revision:1,confirm:true});let calls=0;
 const workflow=new AccountLoginWorkflow({...s.deps,provider:async()=>{calls++;throw new AccountLoginError('invalid_code')}});
 const result=await workflow.advance({action:'submit_code',id,revision:2,code:'11111'});assert.equal(result.error,'invalid_code');assert.equal(result.revision,3);assert.equal(result.phase,'code_required');await assert.rejects(workflow.advance({action:'submit_code',id,revision:2,code:'11111'}));assert.equal(calls,1);
});
test('unknown provider result remains claimed; cancel wipes secrets and late completion cannot restore them',async t=>{
 const s=await setup(t),id=s.input.id;await s.workflow.prepare(s.input);let release,entered;const started=new Promise(r=>entered=r);let calls=0;
 const workflow=new AccountLoginWorkflow({...s.deps,provider:async()=>{calls++;entered();return new Promise(r=>release=r)}});
 const running=workflow.advance({action:'request_code',id,revision:1,confirm:true});const rejected=assert.rejects(running);await started;
 await assert.rejects(workflow.advance({action:'request_code',id,revision:1,confirm:true}));assert.equal((await workflow.status(id)).phase,'result_unconfirmed');await workflow.cancel(id);
 release({phase:'code_required',session:'synthetic-session',phoneCodeHash:'synthetic-hash',delivery:'app'});await rejected;assert.equal(calls,1);assert.equal((await workflow.status(id)).phase,'closed');
});
test('cross-owner and expired challenges cannot issue login actions',async t=>{
 const s=await setup(t),id=s.input.id;const result=await s.workflow.prepare(s.input);const other=new AccountLoginWorkflow({...s.deps,ownerId:'other'});assert.equal((await other.status(id)).phase,'not_found');await assert.rejects(other.advance({action:'request_code',id,revision:1,confirm:true}));
 s.setNow(result.expires_at);assert.equal((await s.workflow.status(id)).phase,'expired');await assert.rejects(s.workflow.advance({action:'request_code',id,revision:1,confirm:true}));assert.equal(s.calls.length,0);
});

test('private HTTP login validates auth/confirmation and cancellation works without decryption keys',async t=>{
 const s=await setup(t);const env={TELEGRAM_ACCOUNT_LOGIN_ENABLED:'true',TELEGRAM_ACCOUNT_ENROLLMENT_AUTH:randomBytes(32).toString('hex'),TELEGRAM_VAULT_OWNER_ID:'owner',TELEGRAM_VAULT_KEY_ID:'key',TELEGRAM_VAULT_KEY_BASE64:s.deps.keys.get('key').toString('base64')};let opens=0;
 const options={env:()=>env,provider:s.deps.provider,open:async()=>{opens++;return {store:s.store,vault:s.vault,close:async()=>{}}}};
 const request=body=>new Request('https://test/login',{method:'POST',headers:{authorization:`Bearer ${env.TELEGRAM_ACCOUNT_ENROLLMENT_AUTH}`,'content-type':'application/json'},body:JSON.stringify(body)});
 const unauthorized=request({action:'prepare',...s.input});unauthorized.headers.delete('authorization');assert.equal((await handleAccountLogin(unauthorized,options)).status,401);
 assert.equal((await handleAccountLogin(request({action:'request_code',id:s.input.id,revision:1}),options)).status,400);assert.equal(opens,0);
 const prepare=await handleAccountLogin(request({action:'prepare',...s.input}),options);assert.equal((await prepare.json()).phase,'prepared');assert.equal(s.calls.length,0);
 const started=await handleAccountLogin(request({action:'request_code',id:s.input.id,revision:1,confirm:true}),options);assert.equal((await started.json()).phase,'code_required');assert.equal(s.calls.length,1);
 delete env.TELEGRAM_VAULT_KEY_BASE64;const cancelled=await handleAccountLogin(request({action:'cancel',id:s.input.id,confirm:true}),options);assert.equal((await cancelled.json()).phase,'closed');assert.equal((await s.store.get('owner',s.input.id)).envelope,null);
});
