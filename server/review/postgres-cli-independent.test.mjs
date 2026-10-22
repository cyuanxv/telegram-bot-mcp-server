import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('regression: PostgreSQL idle pool errors during send do not leak provider errors or crash a committed claim', () => {
  const script = `
    import { mock } from 'node:test';
    import { EventEmitter } from 'node:events';
    import { draftJob } from './lib/telegram/delivery/state.ts';
    let job = draftJob({ idempotencyKey: 'review:idle', botAlias: 'reports', chatId: '-10012345', text: 'synthetic' }, () => 1000000);
    job.state = 'queued';
    class Pool extends EventEmitter {
      async connect() { const owner = this; return {
        async query(sql, args) {
          if (sql.startsWith('SELECT document')) return { rows: [{ document: structuredClone(job) }] };
          if (sql.startsWith('UPDATE ')) job = JSON.parse(args[0]);
          return { rows: [], ...(sql === 'COMMIT' ? { command: 'COMMIT' } : {}) };
        },
        release() { if (!owner.triggered) { owner.triggered = true; setTimeout(() => owner.emit('error', new Error('sensitive-provider-secret')), 1); } }
      }; }
      async end() {}
    }
    mock.module('pg', { namedExports: { Pool } });
    mock.module('./lib/telegram/delivery/bot-transport.ts', { namedExports: { BotApiDeliveryTransport: class {
      async send(r) { await new Promise(resolve => setTimeout(resolve, 20)); return { chatId: r.chatId, messageId: 123 }; }
    } } });
    process.env.TELEGRAM_DELIVERY_BACKEND = 'postgres';
    process.env.TELEGRAM_DELIVERY_POSTGRES_ENABLED = 'true';
    process.env.TELEGRAM_DELIVERY_DATABASE_URL = 'postgres://user:synthetic-password@example.invalid/report';
    process.env.TELEGRAM_DELIVERY_ALLOW_DISPATCH = 'true';
    process.env.TELEGRAM_DELIVERY_ALLOWED_DESTINATIONS_JSON = JSON.stringify([{ botAlias: job.botAlias, chatId: job.chatId }]);
    process.argv = [process.execPath, 'delivery-cli.ts', 'dispatch'];
    const { Readable } = await import('node:stream');
    Object.defineProperty(process, 'stdin', { value: Readable.from([JSON.stringify({ id: job.id, fingerprint: job.fingerprint })]) });
    await import('./scripts/delivery-cli.ts');
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TELEGRAM_') && key !== 'MCP_API_KEY'));
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import', './tests/register-typescript.mjs', '--input-type=module', '-e', script], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10000 });
  assert.ok(!result.stderr.includes('sensitive-provider-secret'), result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, 'delivered');
});
