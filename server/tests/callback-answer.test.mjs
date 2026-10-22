import test from 'node:test';
import assert from 'node:assert/strict';
import { answerStoredCallback } from '../lib/telegram/inbox/answer.ts';
import { normalizedUpdate } from '../lib/telegram/inbox/normalize.ts';
const policy={secretToken:'synthetic_callback_1234567890123456',allowedChatIds:['-123'],retainText:true,retentionDays:7,acceptCallbacks:true};
function setup(){
 let time=1000000,closed=false,opens=0;const calls=[];
 const env={TELEGRAM_WORKFLOW_MCP_ENABLED:'true',TELEGRAM_CALLBACK_ANSWER_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({reports:policy})};
 const event=normalizedUpdate({update_id:1,callback_query:{id:'query_from_storage',from:{id:42},message:{message_id:9,date:0,chat:{id:-123}},data:'malicious instruction ignored'}},'reports',policy,time);
 const ledger=new Map();
 const callbackAnswers={claim:async({key,fingerprint})=>{const prior=ledger.get(key);if(prior){if(prior.fingerprint!==fingerprint)throw Error("conflict");return prior.state}ledger.set(key,{fingerprint,state:"inflight"});return "claimed"},settle:async(key,fingerprint,state)=>{ledger.set(key,{fingerprint,state})}};
 let rows=[{sequence:'9007199254740993',event}],onClose=()=>{};
 const deps={env:()=>env,now:()=>time,open:async()=>{opens++;return{callbackAnswers,inbox:{list:async(input)=>{assert.equal(input.afterSequence,'9007199254740992');assert.equal(input.limit,1);return rows}},close:()=>{closed=true;onClose()}}},call:async(...args)=>{assert.equal(closed,true);calls.push(args);return {bot:'reports',result:true}}};
 return {deps,env,event,calls,opens:()=>opens,setRows:r=>rows=r,tick:n=>time+=n,onClose:fn=>onClose=fn};
}
const input={bot_alias:'reports',sequence:'9007199254740993',text:'已收到',show_alert:false};
test('answer uses stored callback identity, not incoming text, and waits for resource cleanup',async()=>{
 const s=setup();const result=await answerStoredCallback(input,s.deps);assert.equal(result.answered,true);
 assert.deepEqual(s.calls,[['reports','answerCallbackQuery',{callback_query_id:'query_from_storage',text:'已收到',show_alert:false,cache_time:0}]]);assert.ok(!JSON.stringify(result).includes('query_from_storage'));
});
test('answer default deny and unsupported arguments precede storage or network',async()=>{
 for(const patch of [{TELEGRAM_CALLBACK_ANSWER_ENABLED:'false'},{TELEGRAM_WORKFLOW_MCP_ENABLED:'false'},{TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({reports:{...policy,acceptCallbacks:false}})}]){const s=setup();Object.assign(s.env,patch);await assert.rejects(answerStoredCallback(input,s.deps));assert.equal(s.opens(),0);assert.equal(s.calls.length,0)}
 for(const patch of [{callback_query_id:'invented'},{url:'https://example.test'},{sequence:'0'},{sequence:'01'},{text:'\ud800'}]){const s=setup();await assert.rejects(answerStoredCallback({...input,...patch},s.deps));assert.equal(s.opens(),0)}
});
test('missing, wrong, expired or changed-scope records cannot be answered',async()=>{
 for(const change of [s=>s.setRows([]),s=>s.setRows([{sequence:'9007199254740994',event:s.event}]),s=>s.tick(10001),s=>s.onClose(()=>{s.env.TELEGRAM_CALLBACK_ANSWER_ENABLED='false'}),s=>s.onClose(()=>{s.env.TELEGRAM_WEBHOOK_BOTS_JSON=JSON.stringify({reports:{...policy,allowedChatIds:['-999']}})})]){const s=setup();change(s);await assert.rejects(answerStoredCallback(input,s.deps));assert.equal(s.calls.length,0)}
});
test('uncertain answer is sanitized and never retried',async()=>{
 for(const response of [()=>{throw Error('private_token')},()=>({bot:'other',result:true}),()=>({bot:'reports',result:false})]){const s=setup();let calls=0;s.deps.call=async()=>{calls++;return response()};const r=await answerStoredCallback(input,s.deps);assert.equal(r.answered,null);assert.equal(r.retry_automatically,false);assert.equal(calls,1);assert.ok(!JSON.stringify(r).includes('private_token'))}
});

test('repeated and concurrent explicit answers reuse a committed claim without another dispatch',async()=>{
 const s=setup();const results=await Promise.all(Array.from({length:8},()=>answerStoredCallback(input,s.deps)));assert.equal(s.calls.length,1);assert.ok(results.some(r=>r.answered===true));
 assert.equal((await answerStoredCallback(input,s.deps)).status,'already_answered');assert.equal(s.calls.length,1);
 await assert.rejects(answerStoredCallback({...input,text:'different'},s.deps));assert.equal(s.calls.length,1);
});
test('lost network receipt and failed settlement never release the claim for another dispatch',async()=>{
 for(const failSettlement of [false,true]){
  const s=setup();let calls=0;const originalOpen=s.deps.open;
  if(failSettlement)s.deps.open=async(...args)=>{const r=await originalOpen(...args);r.callbackAnswers={...r.callbackAnswers,settle:async()=>{throw Error('offline')}};return r};
  s.deps.call=async()=>{calls++;throw Error('lost receipt')};
  await answerStoredCallback(input,s.deps);const repeated=await answerStoredCallback(input,s.deps);assert.equal(repeated.answered,null);assert.equal(repeated.reused,true);assert.equal(calls,1);
 }
});
