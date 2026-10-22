import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowMcp } from '../lib/telegram/workflow-mcp.ts';
import { assertBusinessConnections } from '../lib/telegram/business-body-access.ts';
const policy={secretToken:'synthetic_business_secret_1234567890123',allowedChatIds:['-123'],allowedBusinessConnectionIds:['conn1'],retainText:true,retentionDays:7};
const environment=()=>({TELEGRAM_BOT_TOKEN:'synthetic-only',TELEGRAM_WORKFLOW_MCP_ENABLED:'true',TELEGRAM_INBOX_MCP_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({default:policy}),TELEGRAM_BUSINESS_BODY_READ_ENABLED:'true',TELEGRAM_BUSINESS_DELETE_APPLY_ENABLED:'true',TELEGRAM_BUSINESS_NOTICES_ENABLED:'true',TELEGRAM_BUSINESS_NOTICE_BOTS_JSON:'["default"]'});
const rows=()=>[
 {sequence:'1',event:{updateType:'message',chatId:'-123',expiresAt:Date.now()+60000,text:'ordinary'}},
 {sequence:'2',event:{updateType:'business_message',chatId:'-123',businessConnectionId:'conn1',expiresAt:Date.now()+60000,text:'private business body'}}
];
function setup({enabled=()=>true,onList=()=>{},onClose=()=>{},onFilter=r=>r,inspectHook}={}){
 const env=environment();let opens=0,closes=0;const calls=[],queries=[];
 const inspect=async(bot,id,signal)=>{calls.push([bot,id]);if(inspectHook)await inspectHook(signal);return {bot_alias:bot,business_connection_id:id,is_enabled:enabled(),rights:{can_read_messages:false}}};
 const open=async()=>{opens++;return {queue:{},inbox:{filterBusinessDeleted:async r=>onFilter(r),list:async q=>{queries.push(q);await onList(env);return rows()}},close:async()=>{closes++;await onClose(env)}}};
 return {env,calls,queries,opens:()=>opens,closes:()=>closes,workflow:new WorkflowMcp(open,()=>env,undefined,inspect)};
}
test('Business body access uses two fresh connection reads, including after asynchronous database close',async()=>{
 const s=setup();const r=await s.workflow.inbox({bot_alias:'default'});
 assert.equal(r.rows.length,2);assert.deepEqual(s.calls,[['default','conn1'],['default','conn1']]);assert.deepEqual(s.queries[0].businessConnectionIds,['conn1']);assert.equal(s.closes(),2);
 // can_read_messages=false never triggers mark-as-read or denies bodies by that unrelated right.
 assert.equal(r.rows[1].text,'private business body');
});
test('Business body switch stays default-deny; ordinary inbox continues without any Telegram calls',async()=>{
 for(const change of [{TELEGRAM_BUSINESS_BODY_READ_ENABLED:undefined},{TELEGRAM_BOT_TOKEN:undefined}]){
  const s=setup();Object.assign(s.env,change);const r=await s.workflow.inbox({bot_alias:'default'});
  assert.deepEqual(r.rows.map(x=>x.text),['ordinary']);assert.deepEqual(s.queries[0].businessConnectionIds,[]);assert.equal(s.calls.length,0);assert.ok(!JSON.stringify(r).includes('private business'));assert.equal(r.next_after_sequence,'2');
 }
});
test('disabled connection before reading opens no storage, and disconnection during close prevents all output',async()=>{
 const a=setup({enabled:()=>false});await assert.rejects(a.workflow.inbox({bot_alias:'default'}),/business_connection_unavailable/);assert.equal(a.opens(),0);
 let active=true;const b=setup({enabled:()=>active,onClose:()=>{active=false}});
 await assert.rejects(b.workflow.inbox({bot_alias:'default'}),/business_connection_unavailable/);assert.equal(b.closes(),1);assert.equal(b.calls.length,2);
});
test('Business flag or scope revocation while querying never releases retained data',async()=>{
 for(const onList of [env=>{env.TELEGRAM_BUSINESS_BODY_READ_ENABLED='false'},env=>{env.TELEGRAM_WEBHOOK_BOTS_JSON=JSON.stringify({default:{...policy,allowedBusinessConnectionIds:[]}})}]){
  const s=setup({onList});await assert.rejects(s.workflow.inbox({bot_alias:'default'}),/business_body_scope_changed|inbox_scope_changed/);assert.equal(s.closes(),1);
 }
});
test('connection verification rejects mismatched identity and sanitizes transport details',async()=>{
 for(const inspect of [async()=>({bot_alias:'other',business_connection_id:'conn1',is_enabled:true}),async()=>({bot_alias:'default',business_connection_id:'wrong',is_enabled:true}),async()=>({bot_alias:'default',business_connection_id:'conn1',is_enabled:'true'}),async()=>{throw Error('sensitive token URL')}]){
  await assert.rejects(assertBusinessConnections('default',['conn1'],()=>{},new AbortController().signal,inspect),e=>e.message==='Business connection verification failed');
 }
});
test('bounded checks stop scheduling after a failure and abort waiting on a non-cooperative transport',async()=>{
 const ids=Array.from({length:12},(_,i)=>'conn'+i);let inFlight=0,max=0,calls=0;
 await assertBusinessConnections('default',ids,()=>{},new AbortController().signal,async(bot,id)=>{calls++;inFlight++;max=Math.max(max,inFlight);await new Promise(r=>setImmediate(r));inFlight--;return {bot_alias:bot,business_connection_id:id,is_enabled:true}});
 assert.equal(calls,12);assert.ok(max<=4);
 const ac=new AbortController();let started=0;
 const pending=assertBusinessConnections('default',ids,()=>{},ac.signal,async()=>{started++;return new Promise(()=>{})});
 ac.abort();await assert.rejects(pending,/verification failed/);assert.equal(started,4);
 let failedCalls=0;await assert.rejects(assertBusinessConnections('default',ids,()=>{},new AbortController().signal,async()=>{failedCalls++;throw Error('failed')}));assert.equal(failedCalls,4);
});

test('deletion observed after the body query is filtered before release while cursor advances',async()=>{
 const s=setup({onFilter:r=>r.filter(x=>x.event.businessConnectionId===undefined)});
 const r=await s.workflow.inbox({bot_alias:'default'});assert.deepEqual(r.rows.map(x=>x.text),['ordinary']);assert.equal(r.next_after_sequence,'2');assert.equal(s.closes(),2);
});
