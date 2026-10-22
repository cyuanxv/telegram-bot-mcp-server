import test from 'node:test';import assert from 'node:assert/strict';
import {inboxRegistrationParameters,assertInboxControlRequest,assertVaultInboxControl} from '../lib/telegram/inbox/control-policy.ts';
import {callInboxControl} from '../lib/telegram/bot-api.ts';
const receiver={secretToken:'synthetic_secret_1234567890123456',allowedChatIds:['-123'],retainText:true,retentionDays:7};
const env={TELEGRAM_WEBHOOK_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({reports:receiver})};
const scope={methods:['getMe'],chat_ids:['-123']};
test('inbox control pins URL, secret, pending-update preservation and approved update types',()=>{
 const p=inboxRegistrationParameters('reports',env);
 assert.doesNotThrow(()=>assertInboxControlRequest('reports','setWebhook',p,env));
 for(const patch of [{url:'https://other.invalid'},{url:p.url.replace('reports','default')},{secret_token:'wrong'},{drop_pending_updates:true},{allowed_updates:['callback_query']},{max_connections:100},{certificate:'x'}])assert.throws(()=>assertInboxControlRequest('reports','setWebhook',{...p,...patch},env));
 for(const method of ['deleteWebhook','getUpdates','sendMessage'])assert.throws(()=>assertInboxControlRequest('reports',method,{},env));
 assert.throws(()=>assertInboxControlRequest('reports','getWebhookInfo',{url:'x'},env));
 assert.doesNotThrow(()=>assertInboxControlRequest('reports','getWebhookInfo',{},{}));
 assert.throws(()=>inboxRegistrationParameters('reports',{}));
});
test('vault inbox control requires approved receiver scope, independent of ordinary method permissions',()=>{
 assert.doesNotThrow(()=>assertVaultInboxControl('reports','getWebhookInfo',{},env,scope));
 assert.doesNotThrow(()=>assertVaultInboxControl('reports','setWebhook',inboxRegistrationParameters('reports',env),env,scope));
 for(const e of [{},{...env,TELEGRAM_WEBHOOK_ENABLED:'false'},{...env,TELEGRAM_WEBHOOK_RETENTION_APPROVED:'false'}])assert.throws(()=>assertVaultInboxControl('reports','getWebhookInfo',{},e,scope));
 assert.throws(()=>assertVaultInboxControl('reports','getWebhookInfo',{},env,{methods:['getMe'],chat_ids:['-999']}));
 const callbacks={...env,TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({reports:{...receiver,acceptCallbacks:true}})};
 assert.equal(inboxRegistrationParameters('reports',callbacks).allowed_updates.at(-1),'callback_query');
 assert.throws(()=>assertVaultInboxControl('reports','setWebhook',inboxRegistrationParameters('reports',callbacks),env,scope));
});
test('internal dispatcher rejects arbitrary requests before fetch or credential resolution',async t=>{
 const original=globalThis.fetch;let calls=0;t.after(()=>globalThis.fetch=original);globalThis.fetch=async()=>{calls++;throw Error('unexpected fetch')};
 for(const [method,params] of [['deleteWebhook',{}],['sendMessage',{chat_id:123,text:'x'}],['getWebhookInfo',{purpose:'inbox_control'}],['setWebhook',{url:'https://other.invalid'}]])await assert.rejects(callInboxControl('reports',method,params));
 assert.equal(calls,0);
});
