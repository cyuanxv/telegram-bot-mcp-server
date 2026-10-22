import test,{mock,beforeEach} from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
let me,authorized,connections,disconnects,options;
class Client{constructor(_s,_id,_hash,o){options=o}async connect(){connections++}async disconnect(){disconnects++}async isUserAuthorized(){return authorized}async getMe(){return me}}
mock.module('teleproto',{namedExports:{TelegramClient:Client}});mock.module('teleproto/sessions',{namedExports:{StringSession:class{}}});
const {verifyAccountSession}=await import('../lib/telegram/vault/account-verification.ts');
const secret={apiId:1,apiHash:randomBytes(16).toString('hex'),session:'synthetic-session'};
beforeEach(()=>{me={id:123n,phone:'private-phone',accessHash:'private-hash'};authorized=true;connections=disconnects=0});
test('private session verification returns only account ID and never enables or saves credentials',async()=>{
 assert.deepEqual(await verifyAccountSession(secret),{user_id:'123',provider_authorization_verified:true,saved:false,activated:false});assert.equal(connections,1);assert.equal(disconnects,1);assert.equal(options.autoReconnect,false);assert.equal(options.floodSleepThreshold,0);
});
test('malformed input, bots, deleted and unauthorized accounts are rejected without leaking data',async()=>{
 for(const patch of [{apiId:0},{apiHash:'invalid'},{session:'with space'},{token:'extra'}])await assert.rejects(verifyAccountSession({...secret,...patch}),/input invalid/);assert.equal(connections,0);
 for(const patch of [{bot:true},{deleted:true},{id:0},{id:'9007199254740992'}]){me={id:123n,...patch};await assert.rejects(verifyAccountSession(secret),e=>e.message==='Account verification unconfirmed')}
 authorized=false;await assert.rejects(verifyAccountSession(secret),/unconfirmed/);
});
test('abort or timeout during connection prevents later identity access',async t=>{
 for(const kind of ['abort','timeout']){
  let release,reads=0;const pending=new Promise(resolve=>{release=resolve});t.mock.method(Client.prototype,'connect',()=>pending);t.mock.method(Client.prototype,'getMe',async()=>{reads++;return me});
  t.mock.timers.enable({apis:['setTimeout']});const controller=new AbortController();const operation=verifyAccountSession(secret,{signal:controller.signal});const rejected=assert.rejects(operation,/unconfirmed/);
  if(kind==='abort')controller.abort();else t.mock.timers.tick(30000);await rejected;release();await new Promise(setImmediate);assert.equal(reads,0);
  t.mock.restoreAll();t.mock.timers.reset();
 }
});
test('revoked backend guard and provider exceptions are sanitized and never return identity',async t=>{
 t.mock.method(Client.prototype,'getMe',async()=>{throw Error(secret.apiHash)});await assert.rejects(verifyAccountSession(secret),e=>!e.message.includes(secret.apiHash));
 await assert.rejects(verifyAccountSession(secret,{guard:()=>{throw Error(secret.session)}}),e=>!e.message.includes(secret.session));
});
