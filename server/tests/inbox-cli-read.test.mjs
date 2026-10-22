import test from 'node:test';
import assert from 'node:assert/strict';
import {readInboxForCli} from '../lib/telegram/inbox/cli-read.ts';
import {WorkflowMcp} from '../lib/telegram/workflow-mcp.ts';
const policy={secretToken:'synthetic_cli_secret_1234567890123456',allowedChatIds:['-1','-2'],allowedBusinessConnectionIds:['c1'],retainText:true,retentionDays:7};
function setup(){
 const env={TELEGRAM_BOT_TOKEN:'synthetic',TELEGRAM_WORKFLOW_MCP_ENABLED:'true',TELEGRAM_INBOX_MCP_ENABLED:'true',TELEGRAM_WEBHOOK_RETENTION_APPROVED:'true',TELEGRAM_WEBHOOK_BOTS_JSON:JSON.stringify({default:policy})};
 let active=true,deleted=false;const calls=[],queries=[];
 const workflow=new WorkflowMcp(async()=>({queue:{},inbox:{list:async q=>{queries.push(q);return [{sequence:'1',event:{chatId:'-1',updateType:'message',text:'ordinary',expiresAt:Date.now()+60000}},{sequence:'2',event:{chatId:'-1',updateType:'business_message',businessConnectionId:'c1',text:'private body',expiresAt:Date.now()+60000}}]},filterBusinessDeleted:async r=>deleted?r.filter(x=>x.event.businessConnectionId===undefined):r},close:async()=>{}}),()=>env,undefined,async(bot,id)=>{calls.push(id);return {bot_alias:bot,business_connection_id:id,is_enabled:active}});
 return {env,calls,queries,workflow,setActive:v=>{active=v},setDeleted:v=>{deleted=v},enable:()=>Object.assign(env,{TELEGRAM_BUSINESS_BODY_READ_ENABLED:'true',TELEGRAM_BUSINESS_DELETE_APPLY_ENABLED:'true',TELEGRAM_BUSINESS_NOTICES_ENABLED:'true',TELEGRAM_BUSINESS_NOTICE_BOTS_JSON:'["default"]'})};
}
test('CLI uses shared default-off Business policy and preserves existing cursor shape',async()=>{
 const s=setup(),r=await readInboxForCli({botAlias:'default',chatIds:['-1'],limit:5,afterSequence:'0'},s.workflow);
 assert.deepEqual(r.rows.map(x=>x.text),['ordinary']);assert.equal(r.nextAfterSequence,'2');assert.equal(s.calls.length,0);assert.deepEqual(s.queries[0].businessConnectionIds,[]);assert.deepEqual(s.queries[0].chatIds,['-1']);assert.ok(Number.isSafeInteger(r.asOfUnixMs));
});
test('CLI enforces live connection and deletion protection before returning Business bodies',async()=>{
 const s=setup();s.enable();const r=await readInboxForCli({botAlias:'default'},s.workflow);assert.equal(r.rows.length,2);assert.deepEqual(s.calls,['c1','c1']);
 s.setDeleted(true);assert.deepEqual((await readInboxForCli({botAlias:'default'},s.workflow)).rows.map(x=>x.text),['ordinary']);
 s.setActive(false);await assert.rejects(readInboxForCli({botAlias:'default'},s.workflow),/business_connection_unavailable/);
});
test('CLI denied flags and unapproved chat never reach storage',async()=>{
 const s=setup();await assert.rejects(readInboxForCli({botAlias:'default',chatIds:['-9']},s.workflow),/scope_changed_or_not_allowed/);assert.equal(s.queries.length,0);
 s.env.TELEGRAM_INBOX_MCP_ENABLED='false';await assert.rejects(readInboxForCli({botAlias:'default'},s.workflow),/inbox_read_disabled/);assert.equal(s.queries.length,0);
});
test('CLI validates exact IDs, bounds and unknown fields before orchestration',async()=>{
 let calls=0;const workflow={inbox:async()=>{calls++;throw Error('must not run')}};
 for(const input of [{botAlias:'bad/name'},{botAlias:'default',chatIds:[]},{botAlias:'default',chatIds:['-1','-1']},{botAlias:'default',chatIds:['1.2']},{botAlias:'default',limit:101},{botAlias:'default',afterSequence:'-1'},{botAlias:'default',businessConnectionIds:['c1']}])await assert.rejects(readInboxForCli(input,workflow));
 assert.equal(calls,0);
});
