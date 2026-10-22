import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const observed = [];
let callback;
mock.module('../lib/telegram/workflow-mcp.ts', { namedExports: { openProductionWorkflow: async () => { throw Error('Unexpected storage access'); }, WorkflowMcp: class {
  async draft(args, signal) { observed.push({ action: 'draft', signal, cancelledOnEntry: signal?.aborted }); return callback ? callback(signal) : { cancelled: signal?.aborted }; }
  async report(action, id, fingerprint, signal) { observed.push({ action, signal, cancelledOnEntry: signal?.aborted }); return callback ? callback(signal) : { cancelled: signal?.aborted }; }
  async inbox(args, signal) { observed.push({ action: 'inbox', signal, cancelledOnEntry: signal?.aborted }); return callback ? callback(signal) : { cancelled: signal?.aborted }; }
} } });
const { POST } = await import('../app/api/mcp/route.ts');
const oldKey = process.env.MCP_API_KEY; process.env.MCP_API_KEY = 'independent-synthetic-key';
test.after(() => { if (oldKey === undefined) delete process.env.MCP_API_KEY; else process.env.MCP_API_KEY = oldKey; });
function request(name, args, signal) { return new Request('https://example.invalid/api/mcp', { method: 'POST', headers: { authorization: 'Bearer independent-synthetic-key', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal }); }
const id = '6f1d6156-c310-4a2b-81ba-51ef59777fb1', fingerprint = 'a'.repeat(64);
test('independent: real installed MCP handler supplies cancellation signals to all six tools', async () => {
  for (const [name, action, args] of [
    ['draft_report', 'draft', { bot_alias: 'reports', chat: '-10012345', text: 'text', idempotency_key: 'test' }],
    ['get_report_status', 'status', { id }], ['enqueue_report', 'enqueue', { id, fingerprint }],
    ['dispatch_report_chunk', 'dispatch', { id, fingerprint }], ['recover_report', 'recover', { id }], ['read_inbox', 'inbox', { bot_alias: 'reports' }],
  ]) {
    const response = await POST(request(name, args)); assert.equal(response.status, 200); await response.text();
    const last = observed.at(-1); assert.equal(last.action, action); assert.ok(last.signal instanceof AbortSignal);
  }
});
test('independent: cancelling a live legacy HTTP request aborts the workflow signal', async () => {
  let started, finish; const ready = new Promise(resolve => started = resolve), end = new Promise(resolve => finish = resolve);
  const controller = new AbortController();
  callback = async signal => { started(signal); await end; return {}; };
  const pending = POST(request('dispatch_report_chunk', { id, fingerprint }, controller.signal));
  const signal = await ready; controller.abort(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, true); finish(); const response = await pending; await response.text(); callback = undefined;
});
test('independent: pre-aborted legacy HTTP request cannot start an uncancelled workflow', async () => {
  callback = undefined; const controller = new AbortController(); controller.abort(); const before = observed.length;
  const response = await POST(request('dispatch_report_chunk', { id, fingerprint }, controller.signal)); await response.text();
  assert.ok(observed.length === before || observed.at(-1).cancelledOnEntry, 'pre-aborted HTTP request reached the workflow with a live signal');
});
test('independent: abort during legacy request body parsing cannot start an uncancelled workflow', async () => {
  callback = undefined; const controller = new AbortController(); const before = observed.length; let body;
  const stream = new ReadableStream({ start(c) { body = c; } });
  const req = new Request('https://example.invalid/api/mcp', { method: 'POST', headers: { authorization: 'Bearer independent-synthetic-key', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: stream, duplex: 'half', signal: controller.signal });
  const pending = POST(req); controller.abort();
  body.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dispatch_report_chunk', arguments: { id, fingerprint } } }))); body.close();
  const response = await pending; await response.text();
  assert.ok(observed.length === before || observed.at(-1).cancelledOnEntry, 'HTTP request cancelled during parsing reached the workflow with a live signal');
});
