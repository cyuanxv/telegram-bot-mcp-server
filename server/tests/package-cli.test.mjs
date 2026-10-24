import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const cli = new URL('../bin/telegram-bot-mcp-server.mjs', import.meta.url);
function run(args, key) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name === 'MCP_API_KEY' || name.startsWith('TELEGRAM_')) delete env[name];
  if (key !== undefined) env.MCP_API_KEY = key;
  const result = spawnSync(process.execPath, [cli.pathname, ...args], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  return result;
}
test('package CLI reports the formal version without starting a server', () => {
  const r = run(['--version']); assert.equal(r.status, 0); assert.equal(r.stdout.trim(), '1.0.1');
});
test('help describes HTTP and does not require credentials', () => {
  const r = run(['--help']); assert.equal(r.status, 0); assert.match(r.stdout, /Streamable HTTP/); assert.match(r.stdout, /127.0.0.1/);
});
test('missing or whitespace key refuses startup', () => {
  for (const key of [undefined, '   ']) { const r = run([], key); assert.equal(r.status, 2); assert.match(r.stderr, /MCP_API_KEY is required/); }
});
test('invalid ports and arguments fail before build or network activity', () => {
  for (const args of [['--port', '0'], ['--port', '65536'], ['--port', 'x'], ['--port'], ['--hostname', '0.0.0.0'], ['unexpected']]) {
    const r = run(args, 'synthetic-package-test-key'); assert.equal(r.status, 2); assert.doesNotMatch(r.stderr, /synthetic-package-test-key/);
  }
});
