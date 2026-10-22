import test from 'node:test';
import assert from 'node:assert/strict';
import { configurationStatus } from '../lib/telegram/configuration-status.ts';
import { approvedInboxPolicies } from '../lib/telegram/inbox/config.ts';

test('configuration inspection is isolated from process environment and defaults off', () => {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  try {
    process.env.TELEGRAM_BOT_TOKEN = 'global-secret-not-in-snapshot';
    const s = configurationStatus({});
    assert.deepEqual(s.bots, {status:'missing',count:0});
    assert.equal(s.database.status,'disabled');
    assert.equal(s.inbox.status,'disabled');
    assert.ok(Object.values(s.switches).every(v=>v===false));
    assert.equal(s.onboarding.backend_entry_configured,false);
  } finally { if(previous===undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN=previous; }
});
test('malformed registries never release error text, secrets or alias names', () => {
  const marker='private-secret-sentinel';
  const s=configurationStatus({TELEGRAM_BOTS_JSON:JSON.stringify({[marker]:{token:123}}),TELEGRAM_CHATS_JSON:'["'+marker+'"]',TELEGRAM_ACCOUNTS_JSON:marker,TELEGRAM_DELIVERY_POSTGRES_ENABLED:'true',TELEGRAM_DELIVERY_DATABASE_URL:marker});
  assert.equal(s.bots.status,'invalid');assert.equal(s.chats.status,'invalid');assert.equal(s.accounts.status,'invalid');
  assert.equal(s.database.status,'configuration_invalid');assert.ok(!JSON.stringify(s).includes(marker));
});
test('valid multi-bot configuration does not claim live connectivity or readiness', () => {
  const env={TELEGRAM_BOTS_JSON:JSON.stringify({one:'secret-one',two:'secret-two'}),TELEGRAM_CHATS_JSON:JSON.stringify({target:'-10022'}),TELEGRAM_ACCOUNTS_JSON:JSON.stringify({a:{session:'secret-session',apiId:5,apiHash:'secret-hash'},b:{session:''}}),TELEGRAM_DELIVERY_POSTGRES_ENABLED:'true',TELEGRAM_DELIVERY_DATABASE_URL:'postgres://user:password@db.example/test',TELEGRAM_CALLBACK_SEND_ENABLED:'true'};
  const s=configurationStatus(env);
  assert.equal(s.bots.count,2);assert.equal(s.accounts.complete_count,1);assert.equal(s.database.status,'configuration_valid');
  assert.equal(s.database.connectivity,'not_checked');assert.equal(s.database.schema,'not_checked');
  assert.equal(s.switches.callback_send,true);assert.equal(s.switches.callback_answer,false);
  for(const value of ['secret-one','secret-two','secret-session','secret-hash','password','-10022','db.example']) assert.ok(!JSON.stringify(s).includes(value));
  assert.equal(s.check,'configuration_only');assert.ok(!Object.hasOwn(s,'ready'));
});
test('inbox policy validates bot binding, flags and retention without enabling reception', () => {
  const policy={secretToken:'s'.repeat(40),allowedChatIds:['-123'],retainText:true,retentionDays:7,acceptCallbacks:true};
  const env={TELEGRAM_WEBHOOK_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({other:policy})};
  assert.equal(configurationStatus(env).inbox.status,'bot_not_configured');
  env.TELEGRAM_BOTS_JSON=JSON.stringify({other:'secret'});
  const s=configurationStatus(env);assert.equal(s.inbox.status,'configuration_valid');assert.equal(s.inbox.callback_bot_count,1);assert.equal(s.switches.callback_answer,false);
  env.TELEGRAM_WEBHOOK_RETENTION_APPROVED='false';assert.equal(configurationStatus(env).inbox.status,'configuration_invalid');
});
test('default inbox shortcut uses its supplied environment, not ambient credentials', () => {
  const env={TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_INBOX_ALLOW_DEFAULT_DESTINATION:'true',TELEGRAM_INBOX_DEFAULT_RETAIN_TEXT:'true',TELEGRAM_INBOX_DEFAULT_RETENTION_DAYS:'7',TELEGRAM_INBOX_DEFAULT_WEBHOOK_SECRET:'x'.repeat(40),TELEGRAM_BOT_TOKEN:'synthetic-token',TELEGRAM_CHAT_ID:'-555'};
  assert.deepEqual(approvedInboxPolicies(env).bots.default.allowedChatIds,['-555']);
  assert.throws(()=>approvedInboxPolicies({...env,TELEGRAM_BOT_TOKEN:undefined}));
});

test('private Bot entry configuration is distinct from runtime activation and real acceptance',()=>{
 const env={TELEGRAM_BOT_ENROLLMENT_ENABLED:'true',TELEGRAM_BOT_MANAGEMENT_ENABLED:'true',TELEGRAM_BOT_ENROLLMENT_AUTH:'a'.repeat(64),TELEGRAM_VAULT_KEY_BASE64:Buffer.alloc(32,7).toString('base64'),TELEGRAM_VAULT_KEY_ID:'test-key',TELEGRAM_VAULT_OWNER_ID:'private-owner',TELEGRAM_DELIVERY_POSTGRES_ENABLED:'true',TELEGRAM_DELIVERY_DATABASE_URL:'postgres://user:password@db.example/test'};
 const v=configurationStatus(env);assert.equal(v.onboarding.backend_entry_configured,true);assert.equal(v.onboarding.mode,'private_bot_management');assert.equal(v.onboarding.live_acceptance,'not_checked');assert.equal(v.onboarding.runtime_bots_enabled,false);assert.equal(v.onboarding.persistent_scope_enabled,false);
 for(const name of ['TELEGRAM_BOT_ENROLLMENT_AUTH','TELEGRAM_VAULT_KEY_BASE64','TELEGRAM_VAULT_OWNER_ID','TELEGRAM_DELIVERY_DATABASE_URL'])assert.equal(configurationStatus({...env,[name]:undefined}).onboarding.backend_entry_configured,false);
 for(const secret of [env.TELEGRAM_BOT_ENROLLMENT_AUTH,env.TELEGRAM_VAULT_KEY_BASE64,'private-owner','test-key','password'])assert.ok(!JSON.stringify(v).includes(secret));
});

test('draft diagnostics report independent config gates and never disclose targets or verify storage',()=>{
 const env={TELEGRAM_DRAFT_WORKFLOW_ENABLED:'true',TELEGRAM_DRAFT_WORKFLOW_AUTH:'private-auth'.repeat(4),TELEGRAM_VAULT_OWNER_ID:'private-owner',TELEGRAM_DRAFT_PREVIEW_TARGETS_JSON:'[{"bot_alias":"private-bot","chat":"private-chat"}]',TELEGRAM_CHATS_JSON:'{"private-chat":"12345"}',TELEGRAM_WEBHOOK_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({'private-bot':{secretToken:'s'.repeat(40),allowedChatIds:['12345'],retainText:false,retentionDays:7,acceptDraftStops:true}})};
 const d=configurationStatus(env).drafts;assert.equal(d.target_count,1);assert.equal(d.stop_target_count,1);assert.equal(d.preview_enabled,false);assert.equal(d.stop_events_enabled,false);assert.equal(d.storage,'not_checked');assert.equal(d.webhook_subscription,'not_checked');
 for(const marker of ['private-auth','private-owner','private-bot','private-chat','12345'])assert.ok(!JSON.stringify(d).includes(marker));
 assert.equal(configurationStatus({...env,TELEGRAM_CHATS_JSON:'{"private-chat":"-12345"}'}).drafts.targets,'configuration_invalid');
 assert.equal(configurationStatus({...env,TELEGRAM_WEBHOOK_BOTS_JSON:'invalid'}).drafts.stop_target_count,null);
});
