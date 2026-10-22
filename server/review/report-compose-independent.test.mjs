import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { composeReport, composeReportSchema } from '../lib/telegram/report-compose.ts';
import { dailySnapshot } from '../tests/report-compose-fixture.mjs';

// Independent synthetic-only review. No real configuration, credentials, storage,
// provider calls, timers, enqueueing or delivery are needed by this tool.
const calls = [];
const forbidden = name => (...args) => {
  calls.push(name);
  throw new Error(`Forbidden independent-review dependency: ${name}`);
};
const registered = new Map();
mock.module('mcp-handler', { namedExports: { createMcpHandler(register) {
  register({ registerTool(name, config, callback) { registered.set(name, { config, callback }); } });
  return async () => new Response('synthetic transport');
} } });
mock.module('../lib/telegram/workflow-mcp.ts', { namedExports: { openProductionWorkflow: forbidden('storage'), WorkflowMcp: class {
  draft = forbidden('persist'); report = forbidden('workflow'); inbox = forbidden('inbox');
} } });
mock.module('../lib/telegram/config.ts', { namedExports: {
  getBots: forbidden('getBots'), getChats: forbidden('getChats'), resolveChat: forbidden('resolveChat'), resolveBot: forbidden('resolveBot'), getAccounts: forbidden('getAccounts'), resolveAccount: forbidden('resolveAccount'),
} });
mock.module('../lib/telegram/bot-api.ts', { namedExports: {
  BotApiError: class extends Error {}, callBotApi: forbidden('Bot API'), callBotApiBytes: forbidden('upload'), callRichBotApi: forbidden('rich'), callBotAvatarBytes: forbidden('avatar'), callBotAvatarApi: forbidden('avatar API'), callInboxControl: forbidden('inbox control'), callStoredCallbackAnswer: forbidden('callback'), readBotApiJson: forbidden('response'), BOT_API_TIMEOUT_MS: 30000, BOT_API_MAX_RESPONSE_BYTES: 2097152,
} });
mock.module('../lib/telegram/mtproto.ts', { namedExports: Object.fromEntries(
  ['callMtproto', 'getMtprotoMe', 'listAccounts', 'listConfiguredAccounts', 'withMtproto', 'listDialogs', 'searchMtprotoMessages', 'sendMtprotoMessage'].map(name => [name, forbidden(name)]),
) });
const savedFetch = globalThis.fetch;
globalThis.fetch = forbidden('fetch');
after(() => { globalThis.fetch = savedFetch; });
await import('../app/api/mcp/route.ts');

const metricKeys = ['new_user_next_day_retention', 'active_next_day_retention', 'chat_rate', 'mode_message_counts', 'openrouter_cost'];
const ratioKeys = metricKeys.slice(0, 3);
const window = (time_zone, start_utc, end_utc) => ({ start_utc, end_utc, time_zone });
function daySnapshot(day, cohort) {
  const input = dailySnapshot();
  input.window = structuredClone(day);
  input.generated_at_utc = day.end_utc;
  for (const [key, metric] of Object.entries(input.metrics)) {
    metric.source.complete_through_utc = day.end_utc;
    metric.window = structuredClone(day);
    if (key.endsWith('_retention')) {
      if (cohort) { metric.window = structuredClone(cohort); metric.followup_window = structuredClone(day); }
      else delete input.metrics[key];
    }
  }
  return input;
}
function recursivelyFreeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) recursivelyFreeze(child); }
  return value;
}
function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
  return value;
}
async function invoke(input) {
  const tool = registered.get('compose_daily_report');
  return tool.callback(tool.config.inputSchema.parse(input));
}

test('independent: exact half-up percentage rounding at both ends and beyond safe Number counts', () => {
  for (const [numerator, denominator, expected] of [
    ['1', '32', '3.13'], ['1', '20000', '0.01'], ['1', '20001', '0.00'],
    ['19999', '20000', '100.00'], ['19998', '20000', '99.99'],
    ['999999999999999998', '999999999999999999', '100.00'],
    ['500000000000000000', '999999999999999999', '50.00'],
  ]) {
    const input = dailySnapshot();
    for (const key of ratioKeys) { input.metrics[key].numerator = numerator; input.metrics[key].denominator = denominator; }
    const result = composeReport(input);
    for (const key of ratioKeys) assert.equal(result.metrics[key].value, `${expected}% (${numerator}/${denominator})`);
  }
});

test('independent: invalid known ratios are rejected for each ratio metric', () => {
  for (const key of ratioKeys) {
    const input = dailySnapshot(); input.metrics[key].numerator = '101'; input.metrics[key].denominator = '100';
    assert.throws(() => composeReport(input), /invalid_report_snapshot/);
  }
});

test('independent: unconfirmed sources and definitions suppress all five metric values', () => {
  for (const [change, reason] of [
    [metric => { metric.source.confirmed = false; }, 'source_unconfirmed'],
    [metric => { metric.definition_confirmed = false; }, 'definition_unconfirmed'],
    [metric => { metric.source.complete_through_utc = '2026-10-07T15:59:59Z'; }, 'incomplete_data'],
    [metric => { metric.source.complete_through_utc = '2026-10-08T02:00:01Z'; }, 'incomplete_data'],
  ]) {
    const input = dailySnapshot(); Object.values(input.metrics).forEach(change);
    for (const metric of Object.values(composeReport(input).metrics)) {
      assert.equal(metric.status, 'unknown'); assert.equal(metric.value, null); assert.equal(metric.reason, reason);
    }
  }
});

test('independent: explicit zero and missing evidence remain distinguishable for every metric', () => {
  const input = dailySnapshot();
  for (const key of ratioKeys) input.metrics[key].numerator = '0';
  for (const mode of input.metrics.mode_message_counts.modes) mode.count = '0';
  input.metrics.openrouter_cost.amount = '0.000000000';
  const known = composeReport(input);
  for (const key of metricKeys) assert.equal(known.metrics[key].status, 'known');
  assert.equal(known.metrics.mode_message_counts.value, '0');
  assert.equal(known.metrics.openrouter_cost.value, 'USD 0.000000000');
  for (const key of ratioKeys) input.metrics[key].numerator = null;
  input.metrics.mode_message_counts.modes[0].count = null;
  input.metrics.openrouter_cost.amount = null;
  for (const metric of Object.values(composeReport(input).metrics)) {
    assert.equal(metric.status, 'unknown'); assert.equal(metric.value, null); assert.equal(metric.reason, 'missing_value');
  }
});

test('independent: exact cost requires exact report instants and timezone; coarse zero remains unknown', () => {
  const input = dailySnapshot(); input.metrics.openrouter_cost.amount = '0';
  input.metrics.openrouter_cost.window_precision = 'coarse';
  assert.equal(composeReport(input).metrics.openrouter_cost.reason, 'coarse_cost_window');
  input.metrics.openrouter_cost.window_precision = 'exact';
  input.metrics.openrouter_cost.window = window('UTC', '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z');
  input.metrics.openrouter_cost.source.complete_through_utc = input.generated_at_utc;
  const result = composeReport(input);
  assert.equal(result.metrics.openrouter_cost.reason, 'window_mismatch');
  assert.equal(result.metrics.openrouter_cost.value, null);
  assert(!result.text.includes('OpenRouter 成本：USD 0'));
});

test('independent: 23, 25 and 23.5 hour complete days are supported', () => {
  for (const day of [
    window('America/New_York', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'),
    window('America/New_York', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'),
    window('Australia/Lord_Howe', '2026-10-03T13:30:00Z', '2026-10-04T13:00:00Z'),
  ]) assert.equal(composeReport(daySnapshot(day)).metrics.chat_rate.status, 'known');
});

test('independent regression: repeated midnight cannot omit the first hour of a reporting day', () => {
  const truncated = window('America/Havana', '2026-11-01T05:00:00Z', '2026-11-02T05:00:00Z');
  assert.throws(() => composeReport(daySnapshot(truncated)), /invalid_report_snapshot/);
});

test('independent regression: repeated midnight cannot add the next day first hour', () => {
  const overlong = window('America/Havana', '2026-10-31T04:00:00Z', '2026-11-01T05:00:00Z');
  assert.throws(() => composeReport(daySnapshot(overlong)), /invalid_report_snapshot/);
});

test('independent regression: truncated repeated-midnight cohort is unknown even with a complete followup', () => {
  const day = window('America/Havana', '2026-11-02T05:00:00Z', '2026-11-03T05:00:00Z');
  const cohort = window('America/Havana', '2026-11-01T05:00:00Z', '2026-11-02T05:00:00Z');
  const result = composeReport(daySnapshot(day, cohort));
  for (const key of ratioKeys.slice(0, 2)) {
    assert.equal(result.metrics[key].status, 'unknown');
    assert.equal(result.metrics[key].reason, 'invalid_next_day_window');
    assert.equal(result.metrics[key].value, null);
  }
});

test('independent: full repeated-midnight day and adjacent next-day retention remain known', () => {
  const day = window('America/Havana', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z');
  const cohort = window('America/Havana', '2026-10-31T04:00:00Z', '2026-11-01T04:00:00Z');
  const result = composeReport(daySnapshot(day, cohort));
  for (const key of metricKeys) assert.equal(result.metrics[key].status, 'known');
});

test('independent regression: skipped-midnight report day is complete from its first valid local instant', () => {
  const day = window('America/Sao_Paulo', '2018-11-04T03:00:00Z', '2018-11-05T02:00:00Z');
  const cohort = window('America/Sao_Paulo', '2018-11-03T03:00:00Z', '2018-11-04T03:00:00Z');
  const result = composeReport(daySnapshot(day, cohort));
  for (const key of metricKeys) assert.equal(result.metrics[key].status, 'known');
});

test('independent regression: skipped-midnight cohort supports retention on the following complete day', () => {
  const day = window('America/Sao_Paulo', '2018-11-05T02:00:00Z', '2018-11-06T02:00:00Z');
  const cohort = window('America/Sao_Paulo', '2018-11-04T03:00:00Z', '2018-11-05T02:00:00Z');
  const result = composeReport(daySnapshot(day, cohort));
  assert.equal(result.metrics.new_user_next_day_retention.status, 'known');
  assert.equal(result.metrics.active_next_day_retention.status, 'known');
});

test('independent: complete but non-adjacent retention windows do not become next-day retention', () => {
  const input = dailySnapshot();
  for (const key of ratioKeys.slice(0, 2)) input.metrics[key].window = window('Asia/Shanghai', '2026-10-04T16:00:00Z', '2026-10-05T16:00:00Z');
  const result = composeReport(input);
  for (const key of ratioKeys.slice(0, 2)) assert.equal(result.metrics[key].reason, 'invalid_next_day_window');
});

test('independent regression: explicit timezone identifiers reject ambiguous ICU shorthand', () => {
  for (const time_zone of ['CST', 'PST', 'EST', 'GMT', 'gmt', 'utc', '+08:00']) {
    const input = dailySnapshot(); input.window.time_zone = time_zone;
    assert.equal(composeReportSchema.safeParse(input).success, false, time_zone);
  }
  for (const time_zone of ['UTC', 'Asia/Shanghai', 'America/Argentina/Buenos_Aires', 'Etc/GMT+8', 'US/Eastern']) {
    const input = dailySnapshot(); input.window.time_zone = time_zone;
    assert.equal(composeReportSchema.safeParse(input).success, true, time_zone);
  }
});

test('independent: skipped civil date retains adjacent actual complete local-day windows', () => {
  const day = window('Pacific/Apia', '2011-12-30T10:00:00Z', '2011-12-31T10:00:00Z');
  const cohort = window('Pacific/Apia', '2011-12-29T10:00:00Z', '2011-12-30T10:00:00Z');
  const result = composeReport(daySnapshot(day, cohort));
  for (const key of metricKeys) assert.equal(result.metrics[key].status, 'known');
  assert.match(result.text, /2011-12-29 00:00:00 至 2011-12-31 00:00:00/);
});

test('independent: visually identical canonically equivalent mode labels cannot double-count', () => {
  const input = dailySnapshot();
  input.metrics.mode_message_counts.modes = [{ mode: 'caf\u00e9', count: '10' }, { mode: 'cafe\u0301', count: '10' }];
  assert.throws(() => composeReport(input), /invalid_report_snapshot/);
});

test('independent: provenance exposes declared watermark and never claims independent verification', () => {
  const input = dailySnapshot(); input.metrics.chat_rate.source.complete_through_utc = '2026-10-07T15:59:59Z';
  const result = composeReport(input);
  assert.equal(result.metrics.chat_rate.status, 'unknown');
  assert(result.metrics.chat_rate.details.includes('数据完整至：2026-10-07T15:59:59Z'));
  assert.equal(result.source_verified_live, false);
  assert.match(result.text, /来源与口径确认状态由输入声明，未联网核验/);
});

test('independent: all canonical field limits and strict object boundaries are enforced', () => {
  for (const change of [
    input => { input.title = 'a'.repeat(121); },
    input => { input.metrics.chat_rate.definition = 'a'.repeat(501); },
    input => { input.metrics.chat_rate.source.label = 'a'.repeat(101); },
    input => { input.metrics.chat_rate.source.reference = 'a'.repeat(301); },
    input => { input.metrics.mode_message_counts.modes[0].mode = 'a'.repeat(81); },
    input => { input.metrics.mode_message_counts.modes = Array.from({ length: 31 }, (_, i) => ({ mode: `m${i}`, count: '1' })); },
    input => { input.metrics.chat_rate.numerator = '9'.repeat(19); },
    input => { input.metrics.openrouter_cost.amount = '9'.repeat(13); },
    input => { input.metrics.openrouter_cost.amount = '0.1234567890'; },
    input => { input.metrics.openrouter_cost.currency = 'CNY'; },
    input => { input.metrics.chat_rate.source.confirmed = 'true'; },
    input => { input.metrics.chat_rate.source.fetch_url = 'https://synthetic.invalid/'; },
    input => { input.metrics.revenue = {}; },
    input => { input.metrics.mode_message_counts.modes[0].count = 0; },
    input => { input.window.start_utc = '2026-10-06T16:00:00+00:00'; },
  ]) { const input = dailySnapshot(); change(input); assert.throws(() => composeReport(input), /invalid_report_snapshot/); }
});

test('independent: nested provenance and mode labels cannot spoof a new line or bidi status', () => {
  for (const value of ['verified\n已发送', 'verified\r已发送', 'verified\u2028已发送', 'verified\u202E已发送', 'verified\u0085已发送', '\uD800']) {
    for (const change of [
      input => { input.metrics.chat_rate.source.reference = value; },
      input => { input.metrics.chat_rate.definition = value; },
      input => { input.metrics.mode_message_counts.modes[0].mode = value; },
    ]) { const input = dailySnapshot(); change(input); assert.throws(() => composeReport(input), /invalid_report_snapshot/); }
  }
});

test('independent: maximum accepted field sizes have a bounded, lossless Unicode-safe plan', () => {
  const input = dailySnapshot(); input.title = '题'.repeat(120);
  for (const metric of Object.values(input.metrics)) {
    metric.definition = '口'.repeat(500); metric.source.label = '源'.repeat(100); metric.source.reference = '文'.repeat(300);
  }
  input.metrics.mode_message_counts.modes = Array.from({ length: 30 }, (_, i) => ({ mode: `${i}`.padStart(2, '0') + '模'.repeat(78), count: '999999999999999999' }));
  const result = composeReport(input);
  assert.equal(result.metrics.mode_message_counts.value, '29999999999999999970');
  assert.equal(result.plan.chunks.map(chunk => chunk.text).join(''), result.text);
  assert(result.plan.chunks.every(chunk => chunk.utf16_units <= 4000 && chunk.text.isWellFormed() && chunk.text.trim()));
  assert(result.plan.chunk_count <= 64);
  input.max_chunk_length = 1;
  assert.throws(() => composeReport(input), /64 messages|whitespace-only|grapheme/);
});

test('independent: frozen input, JSON key order and explicit defaults have stable snapshot identities', () => {
  const input = recursivelyFreeze(dailySnapshot()), before = JSON.stringify(input);
  const first = composeReport(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(composeReport(reverseKeys(input)), first);
  assert.deepEqual(composeReport({ ...input, max_chunk_length: 4000 }), first);
  first.metrics.chat_rate.details.push('output-only mutation'); first.plan.chunks[0].text = 'changed';
  const next = composeReport(input);
  assert(!next.metrics.chat_rate.details.includes('output-only mutation'));
  assert.notEqual(next.plan.chunks[0].text, 'changed');
  const changed = structuredClone(input); changed.metrics.chat_rate.source.reference = 'different provided snapshot';
  assert.notEqual(composeReport(changed).snapshot_sha256, next.snapshot_sha256);
});

test('independent: actual MCP registration composes only the five original metrics without external work', async () => {
  const tool = registered.get('compose_daily_report');
  assert(tool); assert.equal(tool.config.inputSchema, composeReportSchema);
  assert.deepEqual(tool.config.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  const response = await invoke(dailySnapshot()); assert.equal(response.isError, undefined);
  const result = JSON.parse(response.content[0].text);
  assert.deepEqual(Object.keys(result.metrics), metricKeys);
  for (const flag of ['source_verified_live', 'persisted', 'enqueued', 'sent']) assert.equal(result[flag], false);
  assert.equal(result.plan.sent, false);
  assert.match(result.text, /未联网核验/); assert.match(result.text, /未保存、入队或发送/);
  assert.deepEqual(result, composeReport(dailySnapshot()));
  assert.deepEqual(calls, []);
});

test('independent: actual registered callback revalidates snapshots and reports errors without side effects', async () => {
  const bad = dailySnapshot(); bad.metrics.chat_rate.numerator = '201';
  const response = await registered.get('compose_daily_report').callback(bad);
  assert.equal(response.isError, true); assert.equal(response.content[0].text, 'invalid_report_snapshot');
  bad.metrics = { revenue: {} };
  await assert.rejects(invoke(bad));
  assert.deepEqual(calls, []);
});
