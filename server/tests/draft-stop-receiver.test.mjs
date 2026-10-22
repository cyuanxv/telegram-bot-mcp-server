import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';
import {DraftSessions} from '../lib/telegram/draft-sessions.ts';import {receiveDraftStop} from '../lib/telegram/draft-stop-receiver.ts';import {handleWebhook} from '../lib/telegram/inbox/receiver.ts';
const policy={acceptDraftStops:true,secretToken:'s'.repeat(40),allowedChatIds:['123'],retainText:false,retentionDays:7};
const config=()=>({TELEGRAM_DRAFT_STOP_EVENTS_ENABLED:'true',TELEGRAM_DRAFT_WORKFLOW_ENABLED:'true',TELEGRAM_VAULT_OWNER_ID:'owner',TELEGRAM_DRAFT_PREVIEW_TARGETS_JSON:'[{"bot_alias":"test","chat":"private"}]',TELEGRAM_CHATS_JSON:'{"private":"123"}'});
const update=()=>({update_id:1,stopped_message_generation:{chat:{id:123,type:'private',first_name:'private name'},draft_id:7}});
async function setup(t){const pg=new PGlite();t.after(()=>pg.close());await pg.exec(readFileSync(new URL('../migrations/011_draft_sessions.sql',import.meta.url),'utf8'));const sessions=new DraftSessions({transaction:fn=>pg.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))});const identity={ownerId:'owner',id:randomUUID(),botAlias:'test',chatId:'123',draftId:7};await sessions.create(identity);return {pg,sessions,identity,open:async()=>({sessions,close:async()=>{}})}}
test('default off and out-of-scope stop do not open storage; wrong webhook secret never invokes handler',async()=>{
 const no=async()=>assert.fail('storage not allowed');assert.equal(await receiveDraftStop(update(),'test',policy,()=>({}),no),undefined);
 const v=update();v.stopped_message_generation.chat.id=999;assert.equal((await receiveDraftStop(v,'test',policy,config,no)).status,200);
 const request=new Request('https://test/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'wrong'},body:JSON.stringify(update())});
 assert.equal((await handleWebhook(request,'test',{bots:{test:policy}},no,Date.now(),no)).status,401);
});
test('authenticated stop clears active claim once, retains reservation, strips user data and rejects late success',async t=>{
 const s=await setup(t),claim=await s.sessions.claimPreview('owner',s.identity.id,1,1,'a'.repeat(64));
 const req=()=>new Request('https://test/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':policy.secretToken},body:JSON.stringify(update())});
 const no=async()=>assert.fail('no ordinary inbox write');
 const invoke=()=>handleWebhook(req(),'test',{bots:{test:policy}},no,Date.now(),u=>receiveDraftStop(u,'test',policy,config,s.open));
 assert.equal((await (await invoke()).json()).status,'draft_stopped');
 const stopped=await s.sessions.get('owner',s.identity.id);assert.equal(stopped.state,'stopped');assert.equal(stopped.claim,undefined);
 assert.equal((await (await invoke()).json()).status,'draft_already_stopped');assert.deepEqual(await s.sessions.get('owner',s.identity.id),stopped);
 await assert.rejects(s.sessions.settlePreview('owner',s.identity.id,claim.revision,claim.claim,true));
 await assert.rejects(s.sessions.create({...s.identity,id:randomUUID()}));
 assert.ok(!JSON.stringify((await s.pg.query('SELECT document FROM telegram_draft_sessions')).rows).includes('private name'));
});
test('owner, thread and draft mismatch cannot stop another session; finalized report handoff is untouched',async t=>{
 const s=await setup(t);
 for(const patch of [{ownerId:'other'},{threadId:2},{draftId:8},{botAlias:'other'},{chatId:'999'}]){
  const {id,...identity}=s.identity;assert.equal(await s.sessions.stopFromTelegram({...identity,...patch}),'not_found');
 }
 const pending=await s.sessions.prepareFinal('owner',s.identity.id,1,'a'.repeat(64));
 assert.equal((await (await receiveDraftStop(update(),'test',policy,config,s.open)).json()).status,'draft_finalization_started');assert.deepEqual(await s.sessions.get('owner',s.identity.id),pending);
});
test('invalid event and changed scope fail without a successful stop; lost commit retries idempotently',async t=>{
 const s=await setup(t),v=update();v.stopped_message_generation.draft_id=0;
 assert.equal((await receiveDraftStop(v,'test',policy,config,async()=>assert.fail())).status,400);
 const env=config();assert.equal((await receiveDraftStop(update(),'test',policy,()=>env,async()=>{env.TELEGRAM_DRAFT_STOP_EVENTS_ENABLED='false';return s.open()})).status,503);
 assert.equal((await s.sessions.get('owner',s.identity.id)).state,'ready');
 const lose=async()=>({sessions:{stopFromTelegram:async i=>{await s.sessions.stopFromTelegram(i);throw Error('private storage error')}},close:async()=>{}});
 const first=await receiveDraftStop(update(),'test',policy,config,lose);assert.equal(first.status,503);assert.ok(!(await first.text()).includes('private storage'));
 assert.equal((await (await receiveDraftStop(update(),'test',policy,config,s.open)).json()).status,'draft_already_stopped');
});

test('native stop subscriptions require exact per-bot opt-in and preserve ordinary updates',async()=>{
 const {inboxRegistrationParameters}=await import('../lib/telegram/inbox/control-policy.ts');
 const env={TELEGRAM_WEBHOOK_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({test:policy})};
 const enabled=inboxRegistrationParameters('test',env);assert.ok(enabled.allowed_updates.includes('stopped_message_generation'));assert.equal(enabled.drop_pending_updates,false);
 const disabled={...policy,acceptDraftStops:false};env.TELEGRAM_WEBHOOK_BOTS_JSON=JSON.stringify({test:disabled});assert.ok(!inboxRegistrationParameters('test',env).allowed_updates.includes('stopped_message_generation'));
 assert.equal(await receiveDraftStop(update(),'test',disabled,config,async()=>assert.fail('no storage')),undefined);
 env.TELEGRAM_WEBHOOK_BOTS_JSON=JSON.stringify({test:{...policy,acceptDraftStops:'true'}});assert.throws(()=>inboxRegistrationParameters('test',env));
});
