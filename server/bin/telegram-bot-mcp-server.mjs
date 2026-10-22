#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, cpSync, symlinkSync, lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Telegram Bot MCP Server 1.0.0\nUsage: telegram-bot-mcp-server [serve|build|start] [--port 3000]\nDefault: serve (build if needed, then start on 127.0.0.1).\nSet MCP_API_KEY and your own TELEGRAM_* settings in the environment.\nThis package uses Streamable HTTP, not stdio. No remote service is included.');
  process.exit(0);
}
if (args.length === 1 && args[0] === '--version') { console.log('1.0.0'); process.exit(0); }
const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'serve';
let port = '3000';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1] && /^\d+$/.test(args[i + 1])) port = args[++i];
  else { console.error('Invalid arguments. Use --help.'); process.exit(2); }
}
if (!['serve', 'build', 'start'].includes(command) || Number(port) < 1 || Number(port) > 65535) {
  console.error('Invalid command or port. Use --help.'); process.exit(2);
}
if (Number(process.versions.node.split('.')[0]) !== 24) { console.error('Node.js 24 is required.'); process.exit(2); }
if (command !== 'build' && !process.env.MCP_API_KEY?.trim()) {
  console.error('MCP_API_KEY is required; refusing to start.'); process.exit(2);
}
// Resolve through Node to support both nested and hoisted dependency layouts.
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const resolvedNext = require.resolve('next/dist/bin/next');
// Next.js intentionally skips transpiling app source inside node_modules.
// Build a private source-only workspace outside that directory; dependencies
// stay in the user's npm installation and are not bundled or copied.
const cacheId = createHash('sha256').update(root).update(readFileSync(new URL('../package.json', import.meta.url))).update(readFileSync(import.meta.url.startsWith('file:') ? fileURLToPath(import.meta.url) : import.meta.url)).digest('hex').slice(0, 20);
const cacheBase = join(homedir(), '.cache', 'telegram-bot-mcp-server');
mkdirSync(cacheBase, { recursive: true, mode: 0o700 });
const workspace = join(cacheBase, cacheId);
if (existsSync(workspace) && (lstatSync(workspace).isSymbolicLink() || !lstatSync(workspace).isDirectory())) {
  console.error('Invalid local build workspace.'); process.exit(2);
}
mkdirSync(workspace, { recursive: true, mode: 0o700 });
for (const name of ['app', 'lib', 'scripts', 'migrations', 'next.config.ts', 'next-env.d.ts', 'tsconfig.json', 'tsconfig.delivery.json', 'package.json']) {
  if (existsSync(join(root, name))) cpSync(join(root, name), join(workspace, name), { recursive: true });
}
const dependencies = dirname(dirname(require.resolve('next/package.json')));
if (!existsSync(join(workspace, 'node_modules'))) symlinkSync(dependencies, join(workspace, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
let child;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; child?.kill(signal); });
async function run(nextArgs, building = false) {
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
  if (building) for (const key of Object.keys(env)) if (key === 'MCP_API_KEY' || key.startsWith('TELEGRAM_')) delete env[key];
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [resolvedNext, ...nextArgs], { cwd: workspace, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? (signal === 'SIGINT' ? 130 : 143) : (code ?? 1)));
  });
}
try {
  if (command === 'build' || (command === 'serve' && !existsSync(join(workspace, '.next/BUILD_ID')))) {
    const code = await run(['build', '--webpack'], true);
    if (code || command === 'build' || stopping) process.exit(code);
  }
  if (!stopping) process.exit(await run(['start', '--hostname', '127.0.0.1', '--port', port]));
} catch { console.error('Could not start the local backend; check installation and permissions.'); process.exit(1); }
