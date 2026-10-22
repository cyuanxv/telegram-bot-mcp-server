import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function run(input, overrides = {}, options = {}) {
  const script = `
    import { mock } from 'node:test';
    import { EventEmitter } from 'node:events';
    import assert from 'node:assert/strict';
    import { normalizedUpdate } from './lib/telegram/inbox/normalize.ts';
    const options = ${JSON.stringify(options)};
    const policy = {secretToken:'independent_synthetic_secret_1234567890',allowedChatIds:['-10012345'],allowedBusinessConnectionIds:['A'],retainText:false,retentionDays:1};
    const event = normalizedUpdate({update_id:1,business_message:{message_id:9,date:1000,chat:{id:-10012345},business_connection_id:'A',text:'stored-private-content'}}, 'reports', {...policy,retainText:true}, Date.now());
    class Pool extends EventEmitter {
      constructor() {super();if(options.mustNotOpen)throw new Error('UNEXPECTED_POOL_CREATION');}
      async connect() {return {
        async query(sql,args){
          if(options.providerFailure)throw new Error('synthetic-private-provider-secret');
          if(sql.startsWith('SELECT sequence::text')){
            assert.equal(args[0],'reports');assert.deepEqual(args[1],['-10012345']);assert.deepEqual(args[4],options.businessDisabled ? [] : ['A']);
            return {rows:[{sequence:'1',document:event}]};
          }
          if(sql.startsWith('SELECT d.connection_id,d.chat_id,d.message_id')) { assert.equal(args[0],'reports'); return {rows:[]}; }
          if(!['BEGIN','COMMIT'].includes(sql)&&!sql.startsWith('SET LOCAL '))throw new Error('UNEXPECTED_MUTATION');
          return {rows:[],...(sql==='COMMIT'?{command:'COMMIT'}:{})};
        },release(){}
      };}
      async end(){}
    }
    mock.module('pg',{namedExports:{Pool}});
    mock.module('./lib/telegram/business-inspect.ts',{namedExports:{inspectBusinessConnection:async (bot,connection)=>({bot_alias:bot,business_connection_id:connection,is_enabled:true})}});
    globalThis.fetch=async()=>{throw Error('NETWORK_FORBIDDEN')};
    process.env.TELEGRAM_WORKFLOW_MCP_ENABLED='true';
    process.env.TELEGRAM_INBOX_MCP_ENABLED='true';
    process.env.TELEGRAM_BOTS_JSON=JSON.stringify({reports:{token:'synthetic-only'}});
    process.env.TELEGRAM_BUSINESS_BODY_READ_ENABLED='true';
    process.env.TELEGRAM_BUSINESS_DELETE_APPLY_ENABLED='true';
    process.env.TELEGRAM_BUSINESS_NOTICES_ENABLED='true';
    process.env.TELEGRAM_BUSINESS_NOTICE_BOTS_JSON='["reports"]';
    process.env.TELEGRAM_WEBHOOK_ENABLED='true';
    process.env.TELEGRAM_WEBHOOK_RETENTION_APPROVED='true';
    process.env.TELEGRAM_WEBHOOK_BOTS_JSON=JSON.stringify({reports:policy});
    process.env.TELEGRAM_DELIVERY_POSTGRES_ENABLED='true';
    process.env.TELEGRAM_DELIVERY_DATABASE_URL='postgres://user:synthetic-password@example.invalid/review';
    for (const [key,value] of Object.entries(${JSON.stringify(overrides)})) { if (value === null) delete process.env[key]; else process.env[key] = value; }
    process.argv=[process.execPath,'inbox-cli.ts','list'];
    const {Readable}=await import('node:stream');
    Object.defineProperty(process,'stdin',{value:Readable.from([${JSON.stringify(typeof input === 'string' ? input : JSON.stringify(input))}])});
    await import('./scripts/inbox-cli.ts');
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TELEGRAM_') && key !== 'MCP_API_KEY'));
  return spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import', './tests/register-typescript.mjs', '--input-type=module', '-e', script], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10000 });
}

test('independent CLI: explicit policy scopes SQL reads and hides historically retained text when current policy disallows text', () => {
  const result = run({botAlias:'reports'}); assert.equal(result.status,0,result.stderr);
  const output = JSON.parse(result.stdout); assert.equal(output.rows.length,1); assert.equal(output.nextAfterSequence,'1');
  assert.equal(output.rows[0].text,undefined); assert.ok(!result.stdout.includes('stored-private-content'));
});

test('independent CLI: disabled config, unapproved bot/chat and unknown input cannot open a pool', () => {
  for (const [input, overrides] of [
    [{botAlias:'reports'}, {TELEGRAM_WORKFLOW_MCP_ENABLED:null}],
    [{botAlias:'reports'}, {TELEGRAM_INBOX_MCP_ENABLED:null}],
    [{botAlias:'other'}, {}],
    [{botAlias:'reports',chatIds:['-100999']}, {}],
    [{botAlias:'reports',businessConnectionIds:['B']}, {}],
    [{botAlias:'reports',send:true}, {}],
    ['broken JSON', {}],
  ]) {
    const result=run(input,overrides,{mustNotOpen:true}); assert.equal(result.status,1,result.stderr); assert.ok(!result.stderr.includes('UNEXPECTED_POOL_CREATION'),result.stderr);
  }
});

test('independent CLI: database failures are sanitized', () => {
  const result=run({botAlias:'reports'},{},{providerFailure:true});
  assert.equal(result.status,1); assert.ok(!result.stderr.includes('synthetic-private-provider-secret'),result.stderr); assert.ok(!result.stderr.includes('synthetic-password'),result.stderr);
});

// Even a database stub returning old Business bodies cannot bypass the new gate.
test('independent CLI: Business body access disabled filters retained bodies and advances cursor', () => {
 const result=run({botAlias:'reports'},{TELEGRAM_BUSINESS_BODY_READ_ENABLED:null},{businessDisabled:true});
 assert.equal(result.status,0,result.stderr); const output=JSON.parse(result.stdout);
 assert.deepEqual(output.rows,[]); assert.equal(output.nextAfterSequence,'1');
 assert.ok(!result.stdout.includes('stored-private-content'));
});
