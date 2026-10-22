import {test,mock,after,beforeEach} from 'node:test';import assert from 'node:assert/strict';
let seen,checks,calls,closed,identity,revoked;
mock.module('../lib/telegram/vault/runtime-accounts.ts',{namedExports:{listVaultAccountSummaries:async()=>[],openRuntimeAccount:async(alias,request)=>{seen={alias,request};return {config:{session:'synthetic-session',apiId:1,apiHash:'synthetic-hash'},userId:'123',assertCurrent:async()=>{checks++;if(revoked)throw Error()},close:async()=>{closed++}}}}});
mock.module('../lib/telegram/mtproto-peers.ts',{namedExports:{captureAccountPeer:()=>undefined,restoreAccountPeer:()=>{throw Error('unexpected cache')}}});
mock.module('teleproto',{namedExports:{TelegramClient:class{
 async connect(){}async isUserAuthorized(){return true}async disconnect(){}async getMe(){return {id:identity,bot:false,deleted:false}}
 async sendMessage(peer){calls.push(peer);return {id:1,message:'sent'}}
 async getMessages(peer){calls.push(peer);return []}
}}});
mock.module('teleproto/sessions',{namedExports:{StringSession:class{}}});
const {sendMtprotoMessage,searchMtprotoMessages}=await import('../lib/telegram/mtproto.ts');
const keys=['TELEGRAM_MTPROTO_ENABLED','TELEGRAM_VAULT_ACCOUNTS_ENABLED','TELEGRAM_ACCOUNTS_JSON'],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
after(()=>{for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k]}});
beforeEach(()=>{process.env.TELEGRAM_MTPROTO_ENABLED='true';process.env.TELEGRAM_VAULT_ACCOUNTS_ENABLED='true';process.env.TELEGRAM_ACCOUNTS_JSON='{}';checks=0;calls=[];closed=0;identity='123';revoked=false});
test('vault send binds operation, verifies live identity, checks lease before/after and uses numeric peer',async()=>{
 await sendMtprotoMessage('personal','123','hello');assert.deepEqual(seen,{alias:'personal',request:{operation:'send_message',peer:'123'}});assert.equal(checks,3);assert.equal(closed,1);assert.equal(calls.length,1);assert.notEqual(typeof calls[0],'string');assert.equal(calls[0].toString(),'123');
});
test('wrong live identity or revoked binding never reaches business RPC and closes lease',async()=>{
 identity='999';await assert.rejects(sendMtprotoMessage('personal','123','hello'));assert.equal(calls.length,0);assert.equal(closed,1);
 identity='123';revoked=true;await assert.rejects(searchMtprotoMessages('personal','123','query'));assert.equal(calls.length,0);assert.equal(closed,2);
});
