import {test,mock,beforeEach} from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
const {Api}=await import('teleproto');let clients=[],handler,me,connect,proofCalls=0;
class FakeClient{
 constructor(session,apiId,apiHash,options){this.session=session;this.options=options;this.calls=[];this.disconnected=false;clients.push(this)}
 async connect(){await connect()}async disconnect(){this.disconnected=true}
 async invoke(request){this.calls.push(request);return handler(request)}
 async getMe(){assert.equal(this.disconnected,false);return me}
}
mock.module('teleproto',{namedExports:{Api,TelegramClient:FakeClient}});
mock.module('teleproto/sessions',{namedExports:{StringSession:class{save(){return 'synthetic-login-session'}}}});
mock.module('teleproto/Password',{namedExports:{computeCheck:async()=>{proofCalls++;return new Api.InputCheckPasswordEmpty()}}});
const {accountLoginStep}=await import('../lib/telegram/vault/account-login-provider.ts');
const api={apiId:1,apiHash:randomBytes(16).toString('hex')};
const start={...api,action:'request_code',phone:'+12345678901'};
const code={...api,action:'submit_code',phone:start.phone,phoneCodeHash:'synthetic-code-hash',code:'12345',session:'synthetic-login-session'};
beforeEach(()=>{clients=[];me={id:'123',bot:false,deleted:false};connect=async()=>{};proofCalls=0;handler=async()=>new Api.auth.SentCode({type:new Api.auth.SentCodeTypeApp({length:5}),phoneCodeHash:'synthetic-code-hash',timeout:60})});
test('explicit code request performs one step with bounded SDK behavior and returns internal continuation',async()=>{
 const result=await accountLoginStep(start);assert.deepEqual(result,{phase:'code_required',session:'synthetic-login-session',phoneCodeHash:'synthetic-code-hash',delivery:'app',codeLength:5,retryAfter:60});
 assert.equal(clients[0].calls.length,1);assert.ok(clients[0].calls[0] instanceof Api.auth.SendCode);assert.equal(clients[0].options.autoReconnect,false);assert.equal(clients[0].options.floodSleepThreshold,0);assert.equal(clients[0].disconnected,true);
});
test('code login verifies exact normal-user identity; password-needed is an explicit next step',async()=>{
 handler=async()=>({});assert.deepEqual(await accountLoginStep(code),{phase:'authorized',userId:'123',session:'synthetic-login-session'});
 handler=async()=>{throw {errorMessage:'SESSION_PASSWORD_NEEDED',message:api.apiHash}};assert.deepEqual(await accountLoginStep(code),{phase:'password_required',session:'synthetic-login-session'});assert.equal(proofCalls,0);
 handler=async()=>({});me.bot=true;await assert.rejects(accountLoginStep(code),/result_unconfirmed/);
});
test('two-step password computes proof and never returns plaintext password or provider fields',async()=>{
 handler=async()=>({});const password=randomBytes(20).toString('hex');const result=await accountLoginStep({...api,action:'submit_password',session:code.session,password});assert.equal(result.phase,'authorized');assert.equal(proofCalls,1);assert.equal(clients[0].calls.length,2);assert.ok(clients[0].calls[0] instanceof Api.account.GetPassword);assert.ok(clients[0].calls[1] instanceof Api.auth.CheckPassword);assert.ok(!JSON.stringify(result).includes(password));
});
test('invalid input, unsupported delivery, signup and provider errors do not retry or leak details',async()=>{
 await assert.rejects(accountLoginStep({...start,extra:true}),/invalid_input/);assert.equal(clients.length,0);
 handler=async()=>new Api.auth.AuthorizationSignUpRequired({});await assert.rejects(accountLoginStep(code),/signup_not_supported/);assert.equal(clients.at(-1).calls.length,1);
 for(const [provider,expected] of [['PHONE_CODE_INVALID','invalid_code'],['PHONE_CODE_EXPIRED','code_expired'],['PASSWORD_HASH_INVALID','invalid_password'],['FLOOD_WAIT_120','rate_limited'],[api.apiHash,'result_unconfirmed']]){
  handler=async()=>{throw {errorMessage:provider,message:api.apiHash}};await assert.rejects(accountLoginStep(code),e=>e.code===expected&&!e.message.includes(api.apiHash)&&(expected!=='rate_limited'||e.retryAfter===120));assert.equal(clients.at(-1).calls.length,1);
 }
});
test('cancellation and late connection cannot request a code in the background',async()=>{
 let release;connect=()=>new Promise(r=>{release=r});const controller=new AbortController();const running=accountLoginStep(start,{signal:controller.signal});const rejection=assert.rejects(running,/result_unconfirmed/);await Promise.resolve();controller.abort();await rejection;release();await new Promise(r=>setImmediate(r));assert.equal(clients[0].calls.length,0);assert.equal(clients[0].disconnected,true);
});
test('configuration revocation before code submission prevents provider writes',async()=>{
 let revoked=false;connect=async()=>{revoked=true};await assert.rejects(accountLoginStep(start,{guard:()=>{if(revoked)throw Error(api.apiHash)}}),e=>e.code==='result_unconfirmed'&&!e.message.includes(api.apiHash));assert.equal(clients[0].calls.length,0);assert.equal(clients[0].disconnected,true);
});
test('whole-step timeout also bounds a stalled disconnect and discards sensitive result',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const original=FakeClient.prototype.disconnect;FakeClient.prototype.disconnect=()=>new Promise(()=>{});t.after(()=>{FakeClient.prototype.disconnect=original});
 const running=accountLoginStep(start);const rejection=assert.rejects(running,/result_unconfirmed/);for(let i=0;i<8;i++)await Promise.resolve();t.mock.timers.tick(30000);await rejection;assert.equal(clients[0].calls.length,1);
});
