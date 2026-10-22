// Process-level tests use synthetic configuration and a fetch interceptor with no network fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'mock-fetches.txt');
  const stub = join(dir, 'mock-fetch.mjs');
  writeFileSync(stub, `import {appendFileSync} from 'node:fs';
    globalThis.fetch=async(url,options)=>{
      if(url!=='https://api.telegram.org/botsynthetic-offline-review-token/sendMessage')throw new Error('Unexpected mocked URL');
      const body=JSON.parse(options.body);appendFileSync(process.env.MOCK_MARKER,JSON.stringify(body)+'\\n');
      await new Promise(resolve=>setTimeout(resolve,200));
      return Response.json({ok:true,result:{message_id:101,chat:{id:body.chat_id}}});
    };`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TELEGRAM_') && key !== 'MCP_API_KEY'));
  Object.assign(env, {
    TELEGRAM_DELIVERY_DB: join(dir, 'queue.sqlite'),
    TELEGRAM_DELIVERY_ALLOW_DISPATCH: 'true',
    TELEGRAM_DELIVERY_ALLOWED_DESTINATIONS_JSON: JSON.stringify([{botAlias:'reports',chatId:'-10012345'}]),
    TELEGRAM_BOTS_JSON: JSON.stringify({reports:{token:'synthetic-offline-review-token'}}),
    MOCK_MARKER: marker,
  });
  const args = ['--import', './tests/register-typescript.mjs', '--import', stub, './scripts/delivery-cli.ts'];
  function run(command, data, changes = {}) {
    const r = spawnSync(process.execPath, [...args, command], { cwd: process.cwd(), env:{...env,...changes},input:JSON.stringify(data),encoding:'utf8',timeout:10000 });
    return {...r, value:r.stdout ? JSON.parse(r.stdout) : undefined};
  }
  function dispatch(data) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...args, 'dispatch'], { cwd:process.cwd(),env,stdio:['pipe','pipe','pipe'] });
      let stdout='',stderr=''; child.stdout.on('data', d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
      child.on('error',reject);child.on('exit',code=>resolve({code,stdout,stderr}));child.stdin.end(JSON.stringify(data));
    });
  }
  const d = run('draft', {idempotencyKey:'review:cli',botAlias:'reports',chatId:'-10012345',text:'synthetic offline report'});
  assert.equal(d.status,0,d.stderr);
  const request={id:d.value.id,fingerprint:d.value.fingerprint};
  assert.equal(run('enqueue',request).status,0);
  return {run,dispatch,request,marker};
}
test('two independent CLI processes with an exact configured destination produce only one mocked send', async t => {
  const f=fixture(t);
  const results=await Promise.all([f.dispatch(f.request),f.dispatch(f.request)]);
  assert.equal(results.filter(r=>r.code===0).length,1,JSON.stringify(results));
  assert.equal(results.filter(r=>r.code===1).length,1,JSON.stringify(results));
  assert.equal(readFileSync(f.marker,'utf8').trim().split('\n').length,1);
  assert.equal(f.run('status',{id:f.request.id}).value.state,'delivered');
  assert.equal(f.run('dispatch',f.request).status,1);
  assert.equal(readFileSync(f.marker,'utf8').trim().split('\n').length,1);
});
test('malformed or near-match owner policies fail before any mocked fetch or claim', t => {
  const f=fixture(t);
  for(const scopes of [null,{},[],[{botAlias:'reports',chatId:-10012345}],[{botAlias:'reports',chatId:'-100123450'}],[{botAlias:'reports',chatId:'-10012345',extra:true}],Array(101).fill({botAlias:'reports',chatId:'-10012345'})]) {
    const r=f.run('dispatch',f.request,{TELEGRAM_DELIVERY_ALLOWED_DESTINATIONS_JSON:JSON.stringify(scopes)});
    assert.equal(r.status,1,r.stderr);
    assert.equal(f.run('status',{id:f.request.id}).value.state,'queued');
  }
  assert.equal(existsSync(f.marker),false);
});
