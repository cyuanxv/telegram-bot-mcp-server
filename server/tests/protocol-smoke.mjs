// Tests the built server on cloud-local loopback, using no Telegram credentials.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dailySnapshot } from './report-compose-fixture.mjs';

const port = 3130;
const testBearer = randomBytes(32).toString('hex');
const env = { ...process.env, MCP_API_KEY: testBearer, NEXT_TELEMETRY_DISABLED: '1' };
for (const key of Object.keys(env)) if (key.startsWith('TELEGRAM_')) delete env[key];
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
  env, stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
const ready = new Promise((resolve, reject) => {
  child.stdout.on('data', bytes => { if (bytes.toString().includes('Ready')) resolve(); });
  child.once('error', reject);
  child.once('exit', code => reject(new Error(`Server exited before ready: ${code}`)));
});
let timer;
const startupTimeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Server startup timed out')), 15000); });
const url = `http://127.0.0.1:${port}/api/mcp`;
async function rpc(id, method, params) {
  const response = await fetch(url, {
    method: 'POST', headers: { authorization: `Bearer ${testBearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const payload = text.startsWith('event:') ? text.split('\n').find(line => line.startsWith('data:')).slice(5).trim() : text;
  const result = JSON.parse(payload);
  assert.equal(result.error, undefined);
  return result.result;
}
try {
  await Promise.race([ready, startupTimeout]); clearTimeout(timer);
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  const management = await fetch(`http://127.0.0.1:${port}/api/internal/bots/manage`, {method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(management.status,503);assert.equal((await management.json()).status,'management_disabled');
  const enrollment = await fetch(`http://127.0.0.1:${port}/api/internal/bots/enroll`, {method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(enrollment.status,503);assert.equal((await enrollment.json()).status,'enrollment_disabled');
  const webhook = await fetch(`http://127.0.0.1:${port}/api/telegram/webhook/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'});
  assert.equal(webhook.status, 503);
  assert.equal((await webhook.json()).status, 'receiver_disabled');
  const init = await rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'offline-smoke-test', version: '1.0.0' } });
  assert.deepEqual(init.serverInfo, { name: 'telegram-bot-mcp-server', version: '1.0.0' });
  const legacyUrl = `http://127.0.0.1:${port}/api/mcp/legacy-compatibility-test`;
  assert.equal((await fetch(legacyUrl,{method:'POST'})).status,401);
  const legacy = await fetch(legacyUrl,{method:'POST',headers:{authorization:`Bearer ${testBearer}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:99,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'compatibility-test',version:'1'}}})});
  assert.equal(legacy.status,200);
  assert.match(await legacy.text(),/telegram-bot-mcp-server/);
  const list = await rpc(2, 'tools/list', {});
  assert.equal(list.tools.length, 51);
  assert.ok(list.tools.some(t=>t.name==='send_callback_message'));
  const draft = await rpc(111,'tools/call',{name:'send_message_draft',arguments:{bot_alias:'default',chat:'default',draft_id:1,text:'test',confirm:true}});
  assert.equal(draft.isError,true);
  assert.match(draft.content[0].text,/disabled/);
  const avatar = await rpc(110,'tools/call',{name:'manage_bot_avatar',arguments:{action:'inspect',bot_alias:'default'}});
  assert.equal(avatar.isError,true);assert.match(avatar.content[0].text,/Unknown bot alias|bot_unavailable/);
  const notices=await rpc(109,'tools/call',{name:'read_business_notices',arguments:{bot_alias:'default',business_connection_id:'test'}});
  assert.equal(notices.isError,true);assert.match(notices.content[0].text,/Business journal reading disabled/);
  for (const [name,args] of [['draft_payment_order',{id:'test',bot_alias:'default',payer_id:'123',currency:'XTR',total_amount:1,recurring:false}],['get_payment_order_status',{id:'test'}]]) {
    const result=await rpc(106,'tools/call',{name,arguments:args});assert.equal(result.isError,true);assert.match(result.content[0].text,/payment_orders_disabled/);
  }
  const botConnect=await rpc(107,'tools/call',{name:'connect_bot_inbox',arguments:{bot_alias:'reports'}});
  assert.equal(botConnect.isError,true);assert.match(botConnect.content[0].text,/configured before registration/);
  const botInspect=await rpc(108,'tools/call',{name:'inspect_bot_inbox',arguments:{bot_alias:'..'}});
  assert.equal(botInspect.isError,true);assert.match(botInspect.content[0].text,/Invalid inbox Bot alias/);
  const configuration=await rpc(105,'tools/call',{name:'inspect_configuration',arguments:{}});
  assert.equal(configuration.isError,undefined);
  const config=JSON.parse(configuration.content[0].text);
  assert.equal(config.check,'configuration_only');assert.equal(config.bots.count,0);assert.equal(config.database.connectivity,'not_checked');
  const fileStatus=await rpc(104,'tools/call',{name:'get_file_send_status',arguments:{bot_alias:'default',idempotency_key:'test:disabled'}});
  assert.equal(fileStatus.isError,true);assert.match(fileStatus.content[0].text,/Media status disabled/);
  const mediaOnce=await rpc(103,'tools/call',{name:'send_file_once',arguments:{bot_alias:'default',chat:'reports',kind:'document',filename:'test.txt',content_type:'text/plain',base64:'eA==',sha256:'0'.repeat(64),idempotency_key:'test:disabled'}});
  assert.equal(mediaOnce.isError,true);assert.match(mediaOnce.content[0].text,/Persistent media sending disabled/);
  const sendCallback = await rpc(102,'tools/call',{name:'send_callback_message',arguments:{bot_alias:'default',chat:'reports',text:'test',buttons:[[{text:'OK',data:'ok'}]]}});
  assert.equal(sendCallback.isError,true);assert.match(sendCallback.content[0].text,/Callback sending disabled/);
  const callback = await rpc(101,'tools/call',{name:'answer_inbox_callback',arguments:{bot_alias:'default',sequence:'1'}});
  assert.equal(callback.isError,true);assert.match(callback.content[0].text,/Callback answering disabled/);
  const bots = await rpc(3, 'tools/call', { name: 'list_bots', arguments: {} });
  assert.equal(bots.isError, undefined);
  assert.deepEqual(JSON.parse(bots.content[0].text), { bots: [] });
  const tokenOperation = await rpc(4, 'tools/call', { name: 'managed_bot_token', arguments: { user_id: 42, rotate: false } });
  assert.equal(tokenOperation.isError, true);
  assert.match(tokenOperation.content[0].text, /secure credential/);
  const disabled = await rpc(5, 'tools/call', { name: 'get_account_me', arguments: {} });
  assert.equal(disabled.isError, true);
  assert.match(disabled.content[0].text, /MTProto is disabled/);
  const rejectedMethod = await rpc(6, 'tools/call', { name: 'call_mtproto', arguments: { method: 'auth.exportAuthorization', params: {} } });
  assert.equal(rejectedMethod.isError, true);
  assert.match(rejectedMethod.content[0].text, /allowlist/);
  const rejectedNested = await rpc(7, 'tools/call', { name: 'call_mtproto', arguments: { method: 'messages.getHistory', params: { peer: { _: 'inputPeerSelf' } } } });
  assert.equal(rejectedNested.isError, true);
  assert.match(rejectedNested.content[0].text, /peer must/);
  const planned = await rpc(8, 'tools/call', { name: 'plan_report', arguments: { text: '日报🙂'.repeat(2000) } });
  const plan = JSON.parse(planned.content[0].text);
  assert.equal(plan.sent, false);
  assert.equal(plan.chunks.map(x => x.text).join(''), '日报🙂'.repeat(2000));
  const byteUpload = await rpc(9, 'tools/call', { name: 'send_media_bytes', arguments: { bot_alias: 'default', method: 'sendDocument', chat: '-100001', params: { document: 'attach://f' }, files: [{ field_name: 'f', filename: 'test.txt', base64: 'eA==' }] } });
  assert.equal(byteUpload.isError, true); assert.match(byteUpload.content[0].text, /disabled/);
  const workflow = await rpc(10, 'tools/call', { name: 'draft_report', arguments: { bot_alias: 'reports', chat: '-100001', text: 'test', idempotency_key: 'test' } });
  assert.equal(workflow.isError, true); assert.match(workflow.content[0].text, /disabled/);
  const composed = await rpc(11, 'tools/call', { name: 'compose_daily_report', arguments: dailySnapshot() });
  assert.equal(composed.isError, undefined);
  const report = JSON.parse(composed.content[0].text);
  assert.equal(report.metrics.chat_rate.value, '50.00% (100/200)'); assert.equal(report.sent, false); assert.equal(report.persisted, false);
  console.log('Protocol smoke passed: default-off webhook 503, unauthorized 401, initialize, 51 tools, empty bots, blocked credentials, default MTProto gate, disallowed method and nested input. No Telegram credentials or requests.');
} finally {
  clearTimeout(timer);
  child.kill('SIGTERM');
  const forceKill = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(forceKill);
}
