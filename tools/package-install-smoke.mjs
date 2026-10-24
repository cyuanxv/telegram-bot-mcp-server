import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
const prefix = resolve(process.argv[2]);
const key = randomBytes(32).toString('hex');
mkdirSync(resolve(prefix, 'home'), { recursive:true });
const env = { ...process.env, HOME:resolve(prefix, 'home'), MCP_API_KEY: key, NEXT_TELEMETRY_DISABLED: '1' };
for (const n of Object.keys(env)) if (n.startsWith('TELEGRAM_')) delete env[n];
const child = spawn(process.execPath, [resolve(prefix,'node_modules/@cyuanxv/telegram-bot-mcp-server/bin/telegram-bot-mcp-server.mjs'), '--port','3132'], { cwd:prefix, env, stdio:['ignore','pipe','pipe'] });
let logs='';
child.stdout.on('data', b=>{logs+=b;}); child.stderr.on('data', b=>{logs+=b;});
let closed=false;const exit=once(child,'exit').then(([code,signal])=>{closed=true;return {code,signal};});
const url='http://127.0.0.1:3132/api/mcp';
let successes=[];
async function rpc(id,method,params){
 const response=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(10000)});
 assert.equal(response.status,200);const text=await response.text();const data=text.startsWith('event:')?text.split('\n').find(x=>x.startsWith('data:')).slice(5).trim():text;const j=JSON.parse(data);assert.equal(j.error,undefined);return j.result;
}
try{
 let ready=false;
 for(let i=0;i<240;i++){
  if(closed)throw new Error('CLI exited before readiness');
  try{const r=await fetch(url,{method:'POST',signal:AbortSignal.timeout(1000)});if(r.status===401){ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,500));
 }
 assert.equal(ready,true,'Build/start readiness timeout');successes.push('source package builds and serves from clean installation');
 assert.equal((await fetch(url,{method:'POST',headers:{authorization:'Bearer wrong'}})).status,401);successes.push('missing/wrong authentication rejected');
 const init=await rpc(1,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'local-package-acceptance',version:'1.0.1'}});
 assert.deepEqual(init.serverInfo,{name:'telegram-bot-mcp-server',version:'1.0.1'});successes.push('formal MCP identity');
 const tools=await rpc(2,'tools/list',{});assert.equal(tools.tools.length,51);successes.push('51 tools discoverable');
 const result=await rpc(3,'tools/call',{name:'inspect_configuration',arguments:{}});assert.equal(result.isError,undefined);const config=JSON.parse(result.content[0].text);assert.equal(config.bots.count,0);assert.equal(config.database.connectivity,'not_checked');successes.push('credential-free configuration inspection');
 const bots=await rpc(4,'tools/call',{name:'list_bots',arguments:{}});assert.deepEqual(JSON.parse(bots.content[0].text),{bots:[]});successes.push('empty own-Bot configuration');
 const disabled=await rpc(5,'tools/call',{name:'send_message_draft',arguments:{bot_alias:'default',chat:'default',draft_id:1,text:'synthetic',confirm:true}});assert.equal(disabled.isError,true);successes.push('optional writes remain disabled');
 assert.equal(logs.includes(key),false);successes.push('access key absent from startup output');
}catch(e){console.error(logs);throw e;}
finally{
 if(!closed)child.kill('SIGTERM');
 let timer;await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('CLI did not stop')),10000)})]).finally(()=>clearTimeout(timer));
}
let reachable=false;try{await fetch(url,{signal:AbortSignal.timeout(500)});reachable=true;}catch{}assert.equal(reachable,false);successes.push('shutdown closes local listener');
console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,checks:successes,status:'passed'},null,2));
