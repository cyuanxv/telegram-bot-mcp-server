import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowMcp } from '../lib/telegram/workflow-mcp.ts';
import { AsyncReportQueue } from '../lib/telegram/delivery/async-queue.ts';
import { MemoryQueueStore } from '../lib/telegram/delivery/store.ts';
import { PgPoolDatabase } from '../lib/telegram/delivery/pg-pool-adapter.ts';
import { BotApiDeliveryTransport } from '../lib/telegram/delivery/bot-transport.ts';

const target = { botAlias: 'reports', chatId: '-10012345' };
const input = { bot_alias: target.botAlias, chat: target.chatId, text: 'private report', idempotency_key: 'independent:workflow' };
function setup() {
  const env = { TELEGRAM_BOTS_JSON: JSON.stringify({ reports: { token: 'synthetic-only' } }), TELEGRAM_BUSINESS_BODY_READ_ENABLED: 'true', TELEGRAM_BUSINESS_DELETE_APPLY_ENABLED: 'true', TELEGRAM_BUSINESS_NOTICES_ENABLED: 'true', TELEGRAM_BUSINESS_NOTICE_BOTS_JSON: '["reports"]', TELEGRAM_WORKFLOW_MCP_ENABLED: 'true', TELEGRAM_DELIVERY_ALLOW_DISPATCH: 'true', TELEGRAM_DELIVERY_ALLOWED_DESTINATIONS_JSON: JSON.stringify([target]), TELEGRAM_INBOX_MCP_ENABLED: 'true', TELEGRAM_WEBHOOK_RETENTION_APPROVED: 'true' };
  const policy = { secretToken: 'synthetic_independent_secret_123456789', allowedChatIds: [target.chatId], allowedBusinessConnectionIds: ['A'], retainText: true, retentionDays: 7 };
  const setPolicy = patch => { Object.assign(policy, patch); env.TELEGRAM_WEBHOOK_BOTS_JSON = JSON.stringify({ reports: policy }); };
  setPolicy({});
  const memory = new MemoryQueueStore(); let opens = 0, sends = 0, afterClaim, close, inboxList, transport;
  const store = { create: async job => memory.create(job), get: async id => memory.get(id), update: async (id, fn) => { const result = memory.update(id, fn); if (memory.get(id).state === 'sending' && afterClaim) await afterClaim(); return result; } };
  const queue = new AsyncReportQueue(store, () => 1000000);
  const workflow = new WorkflowMcp(async guard => { opens++; guard(); return { queue, inbox: { list: async args => inboxList ? inboxList(args) : [{ sequence: '1', event: { botAlias: 'reports', chatId: target.chatId, expiresAt: Date.now() + 86400000, text: 'private inbox' } }] }, close: async () => { if (close) await close(); } }; }, () => env, signal => transport ? transport(signal) : { send: async request => { sends++; return { chatId: request.chatId, messageId: sends }; } }, async (bot, connection) => ({ bot_alias: bot, business_connection_id: connection, is_enabled: true }));
  return { env, workflow, memory, policy, setPolicy, opens: () => opens, sends: () => sends, setClose: fn => close = fn, setAfterClaim: fn => afterClaim = fn, setInbox: fn => inboxList = fn, setTransport: fn => transport = fn };
}
async function queued(s) { const job = await s.workflow.draft(input); await s.workflow.report('enqueue', job.id, job.fingerprint); return job; }

test('independent: text disabled during cleanup is not released from inbox', async () => {
  const s = setup(); s.setClose(async () => { await Promise.resolve(); s.setPolicy({ retainText: false }); });
  const result = await s.workflow.inbox({ bot_alias: 'reports' });
  assert.ok(!JSON.stringify(result).includes('private inbox'));
});
test('independent: inbox chat revocation during cleanup denies result release', async () => {
  const s = setup(); s.setClose(async () => { await Promise.resolve(); s.setPolicy({ allowedChatIds: ['-100999'] }); });
  await assert.rejects(s.workflow.inbox({ bot_alias: 'reports' }), /scope_changed/);
});
test('independent: Business revocation while reading denies result release', async () => {
  const s = setup(); s.setInbox(async () => { s.setPolicy({ allowedBusinessConnectionIds: [] }); return []; });
  await assert.rejects(s.workflow.inbox({ bot_alias: 'reports' }), /scope_changed/);
});
test('independent: inbox caller scope is snapshotted before resource acquisition', async () => {
  const s = setup(); const req = { bot_alias: 'reports', chat_ids: [target.chatId] }; let actual;
  s.setInbox(async args => { actual = args; return []; });
  const pending = s.workflow.inbox(req); req.chat_ids[0] = '-100999'; req.bot_alias = 'other'; await pending;
  assert.equal(actual.botAlias, 'reports'); assert.deepEqual(actual.chatIds, [target.chatId]); assert.deepEqual(actual.businessConnectionIds, ['A']);
});
test('independent: report scope revoked during cleanup denies status release', async () => {
  const s = setup(), job = await queued(s); s.setClose(() => { s.env.TELEGRAM_DELIVERY_ALLOWED_DESTINATIONS_JSON = JSON.stringify([{ ...target, chatId: '-100999' }]); });
  await assert.rejects(s.workflow.report('status', job.id), /not_allowed/);
});
test('independent: cancellation during cleanup denies inbox result release', async () => {
  const s = setup(), controller = new AbortController(); s.setClose(() => controller.abort(new Error('private reason')));
  await assert.rejects(s.workflow.inbox({ bot_alias: 'reports' }, controller.signal), /cancelled/);
});
test('independent: inbox rows expiring during cleanup are not released', async t => {
  const s = setup(); let now = 1000000; t.mock.method(Date, 'now', () => now);
  s.setInbox(async args => { assert.equal(args.now, now); return [{ sequence: '1', event: { botAlias: 'reports', chatId: target.chatId, expiresAt: 1000001, text: 'expired private inbox' } }]; });
  s.setClose(() => { now = 1000001; });
  const result = await s.workflow.inbox({ bot_alias: 'reports' });
  assert.equal(result.rows.length, 0); assert.equal(result.next_after_sequence, '1', 'cursor should advance beyond rows that expired while the read was pending');
});
test('independent: workflow and inbox disable gates do not open storage', async () => {
  const s = setup(); delete s.env.TELEGRAM_WORKFLOW_MCP_ENABLED;
  for (const action of ['status', 'enqueue', 'dispatch', 'recover']) await assert.rejects(s.workflow.report(action, 'unknown', 'hash'), /disabled/);
  await assert.rejects(s.workflow.draft(input), /disabled/); await assert.rejects(s.workflow.inbox({ bot_alias: 'reports' }), /disabled/);
  s.env.TELEGRAM_WORKFLOW_MCP_ENABLED = 'true'; s.env.TELEGRAM_INBOX_MCP_ENABLED = 'false';
  await assert.rejects(s.workflow.inbox({ bot_alias: 'reports' }), /inbox_read_disabled/); assert.equal(s.opens(), 0);
});
test('independent: changed target after committed claim never sends and cannot be retried', async () => {
  const s = setup(), job = await queued(s); s.setAfterClaim(() => { s.env.TELEGRAM_DELIVERY_ALLOWED_DESTINATIONS_JSON = JSON.stringify([{ ...target, chatId: '-100999' }]); });
  const result = await s.workflow.report('dispatch', job.id, job.fingerprint); assert.equal(result.state, 'rejected'); assert.equal(s.sends(), 0);
  s.env.TELEGRAM_DELIVERY_ALLOWED_DESTINATIONS_JSON = JSON.stringify([target]); s.setAfterClaim(undefined);
  await assert.rejects(s.workflow.report('dispatch', job.id, job.fingerprint)); assert.equal(s.sends(), 0);
});
test('independent: cancellation after transport start records unknown and duplicate dispatch remains blocked', async t => {
  const old = process.env.TELEGRAM_BOTS_JSON; t.after(() => { if (old === undefined) delete process.env.TELEGRAM_BOTS_JSON; else process.env.TELEGRAM_BOTS_JSON = old; });
  process.env.TELEGRAM_BOTS_JSON = JSON.stringify({ reports: { token: 'synthetic-not-a-credential' } });
  const s = setup(), job = await queued(s), controller = new AbortController(); let fetches = 0, propagated = false;
  s.setTransport(signal => { assert.equal(signal, controller.signal); return new BotApiDeliveryTransport(signal); });
  t.mock.method(globalThis, 'fetch', async (_url, args) => { fetches++; controller.abort(new Error('private cancellation reason')); propagated = args.signal.aborted; throw new Error('private provider detail'); });
  const result = await s.workflow.report('dispatch', job.id, job.fingerprint, controller.signal);
  assert.equal(result.state, 'unknown'); assert.equal(propagated, true); assert.equal(fetches, 1); assert.ok(!JSON.stringify(result).includes('private'));
  await assert.rejects(s.workflow.report('dispatch', job.id, job.fingerprint)); assert.equal(fetches, 1);
});
test('independent: known receipt settlement survives later withdrawal without a second send', async () => {
  const s = setup(), job = await queued(s), controller = new AbortController(); let sent = 0;
  s.setTransport(signal => ({ send: async request => { sent++; controller.abort(); s.env.TELEGRAM_WORKFLOW_MCP_ENABLED = 'false'; return { chatId: request.chatId, messageId: 42 }; } }));
  const result = await s.workflow.report('dispatch', job.id, job.fingerprint, controller.signal);
  assert.equal(result.state, 'delivered'); assert.equal(sent, 1); assert.equal(s.memory.get(job.id).chunks[0].receipt.messageId, 42);
});
test('independent: revocation while connection acquisition waits denies BEGIN and destroys client', async () => {
  let allowed = true, release, started; const barrier = new Promise(resolve => release = resolve), ready = new Promise(resolve => started = resolve); const commands = []; let destroyed;
  const db = new PgPoolDatabase({ connect: async () => { started(); await barrier; return { query: async sql => { commands.push(sql); return { rows: [], command: sql.split(' ')[0] }; }, release: value => destroyed = value }; } }, { guard: () => { if (!allowed) throw new Error('revoked'); } });
  const pending = db.transaction(async sql => sql.query('SELECT 1')); await ready; allowed = false; release();
  await assert.rejects(pending, /revoked/); assert.deepEqual(commands, []); assert.equal(destroyed, true);
});
test('independent: ambiguous COMMIT never authorizes a send', async () => {
  const s = setup(), job = await queued(s); let sent = 0;
  const db = new PgPoolDatabase({ connect: async () => ({ query: async sql => { if (sql === 'COMMIT') throw new Error('lost acknowledgement'); return { rows: [], command: sql.split(' ')[0] }; }, release() {} }) });
  const queue = new AsyncReportQueue({ get: async id => s.memory.get(id), create: async job => s.memory.create(job), update: async (id, fn) => { const result = s.memory.update(id, fn); await db.transaction(async () => result); return result; } });
  const w = new WorkflowMcp(async () => ({ queue, inbox: {}, close() {} }), () => s.env, () => ({ send: async r => { sent++; return { chatId: r.chatId, messageId: 1 }; } }));
  await assert.rejects(w.report('dispatch', job.id, job.fingerprint), /operation_failed/); assert.equal(sent, 0); assert.equal(s.memory.get(job.id).state, 'sending');
  await assert.rejects(w.report('dispatch', job.id, job.fingerprint)); assert.equal(sent, 0);
});
