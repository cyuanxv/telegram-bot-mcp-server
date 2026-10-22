import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SqliteQueueStore } from '../lib/telegram/delivery/sqlite-store.ts';

const sourceArgs = ['--import', './tests/register-typescript.mjs', './scripts/delivery-cli.ts'];
function run(command, input, db, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TELEGRAM_') && key !== 'MCP_API_KEY'));
  const result = spawnSync(process.execPath, [...sourceArgs, command], { cwd: process.cwd(), env: { ...env, ...(db ? { TELEGRAM_DELIVERY_DB: db } : {}), ...extra }, input: input === undefined ? '' : JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
  return { status: result.status, out: result.stdout.trim() ? JSON.parse(result.stdout) : null, error: result.stderr };
}
function db(t) { const dir = mkdtempSync(join(tmpdir(), 'telegram-cli-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return { dir, path: join(dir, 'queue.sqlite') }; }
const draft = { idempotencyKey: 'daily:cli', botAlias: 'reports', chatId: '-10012345', text: 'private example report text' };

test('CLI plan is storage-free and preserves text without network', () => {
  const result = run('plan', { text: '示例 report' }); assert.equal(result.status, 0, result.error);
  assert.equal(result.out.sent, false); assert.equal(result.out.chunks[0].text, '示例 report');
});
test('CLI demo completes only through a mock transport', () => {
  const result = run('demo'); assert.equal(result.status, 0, result.error);
  assert.equal(result.out.simulated, true); assert.equal(result.out.external_messages_sent, 0); assert.equal(result.out.job.state, 'delivered');
});
test('CLI draft, enqueue and status survive separate processes and status omits content', t => {
  const { path } = db(t); const d = run('draft', draft, path); assert.equal(d.status, 0, d.error); assert.equal(d.out.state, 'draft');
  const q = run('enqueue', { id: d.out.id, fingerprint: d.out.fingerprint }, path); assert.equal(q.status, 0, q.error); assert.equal(q.out.state, 'queued');
  const s = run('status', { id: d.out.id }, path); assert.equal(s.status, 0, s.error); assert.equal(s.out.state, 'queued'); assert.ok(!JSON.stringify(s.out).includes(draft.text));
  assert.equal(run('draft', draft, path).out.id, d.out.id);
});
test('CLI dispatch is denied by default, and denied without an exact destination policy', t => {
  const { path } = db(t); const d = run('draft', draft, path).out; const request = { id: d.id, fingerprint: d.fingerprint };
  run('enqueue', request, path);
  for (const env of [{}, { TELEGRAM_DELIVERY_ALLOW_DISPATCH: 'true' }, { TELEGRAM_DELIVERY_ALLOW_DISPATCH: 'true', TELEGRAM_DELIVERY_ALLOWED_DESTINATIONS_JSON: JSON.stringify([{ botAlias: 'other', chatId: d.chatId }]) }]) {
    const result = run('dispatch', request, path, env); assert.equal(result.status, 1); assert.match(result.error, /disabled|policy|required|outside/);
  }
  assert.equal(run('status', { id: d.id }, path).out.state, 'queued');
});
test('CLI rejects unexpected fields and missing storage before side effects', () => {
  assert.equal(run('draft', draft).status, 1);
  assert.equal(run('plan', { text: 'hi', extra: 'no' }).status, 1);
});
test('SQLite refuses public files, symlinks and non-private parent directories', t => {
  const { dir, path } = db(t); writeFileSync(path, '', { mode: 0o644 });
  assert.throws(() => new SqliteQueueStore(path), /private regular/);
  chmodSync(path, 0o600); const link = join(dir, 'alias.sqlite'); symlinkSync(path, link);
  assert.throws(() => new SqliteQueueStore(link), /private regular/);
  chmodSync(dir, 0o755); assert.throws(() => new SqliteQueueStore(path), /private directory/);
});
test('CLI PostgreSQL storage is separately default-deny and rejects insecure connection options before connecting', () => {
  const input = { id: 'example' };
  const disabled = run('status', input, undefined, { TELEGRAM_DELIVERY_BACKEND: 'postgres' });
  assert.equal(disabled.status, 1); assert.match(disabled.error, /storage is disabled/);
  const insecure = run('status', input, undefined, { TELEGRAM_DELIVERY_BACKEND: 'postgres', TELEGRAM_DELIVERY_POSTGRES_ENABLED: 'true', TELEGRAM_DELIVERY_DATABASE_URL: 'postgres://user:synthetic-secret@example.invalid/report?sslmode=disable' });
  assert.equal(insecure.status, 1); assert.match(insecure.error, /verified TLS/); assert.ok(!insecure.error.includes('synthetic-secret'));
});
