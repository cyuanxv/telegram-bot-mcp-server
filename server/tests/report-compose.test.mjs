import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeReport } from '../lib/telegram/report-compose.ts';
import { dailySnapshot } from './report-compose-fixture.mjs';

test('provided metric snapshot composes exact values, provenance and a lossless plan', () => {
  const input = dailySnapshot(), before = structuredClone(input), result = composeReport(input);
  assert.equal(result.metrics.new_user_next_day_retention.value, '20.00% (20/100)');
  assert.equal(result.metrics.active_next_day_retention.value, '55.00% (55/100)');
  assert.equal(result.metrics.chat_rate.value, '50.00% (100/200)');
  assert.equal(result.metrics.mode_message_counts.value, '150');
  assert.equal(result.metrics.openrouter_cost.value, 'USD 1.234567891');
  assert.match(result.text, /2026-10-07 00:00:00 至 2026-10-08 00:00:00 \(Asia\/Shanghai/);
  assert.equal(result.plan.chunks.map(item => item.text).join(''), result.text);
  assert.equal(result.source_verified_live, false); assert.equal(result.sent, false); assert.equal(result.enqueued, false); assert.equal(result.persisted, false);
  assert.deepEqual(input, before);
});
test('absent values and unconfirmed definitions/sources stay unknown instead of zero', () => {
  const input = dailySnapshot(); input.metrics = {};
  const result = composeReport(input); assert.equal(Object.keys(result.metrics).length, 5);
  for (const metric of Object.values(result.metrics)) { assert.equal(metric.value, null); assert.equal(metric.reason, 'not_provided'); }
  for (const field of ['definition', 'source']) {
    const value = dailySnapshot();
    if (field === 'definition') value.metrics.chat_rate.definition_confirmed = false;
    else value.metrics.chat_rate.source.confirmed = false;
    assert.equal(composeReport(value).metrics.chat_rate.reason, `${field}_unconfirmed`);
  }
});
test('ratio denominator zero is unknown, missing is unknown, real zero numerator is zero', () => {
  const input = dailySnapshot(); input.metrics.chat_rate.numerator = '0'; input.metrics.chat_rate.denominator = '0';
  assert.equal(composeReport(input).metrics.chat_rate.reason, 'zero_denominator');
  input.metrics.chat_rate.denominator = '200'; assert.equal(composeReport(input).metrics.chat_rate.value, '0.00% (0/200)');
  input.metrics.chat_rate.numerator = null; assert.equal(composeReport(input).metrics.chat_rate.reason, 'missing_value');
});
test('exact big-integer arithmetic avoids rounding counts through JavaScript numbers', () => {
  const input = dailySnapshot(); input.metrics.chat_rate.numerator = '333333333333333333'; input.metrics.chat_rate.denominator = '999999999999999999';
  assert.equal(composeReport(input).metrics.chat_rate.value, '33.33% (333333333333333333/999999999999999999)');
  input.metrics.mode_message_counts.modes = [{ mode: 'a', count: '999999999999999999' }, { mode: 'b', count: '999999999999999999' }];
  assert.equal(composeReport(input).metrics.mode_message_counts.value, '1999999999999999998');
});
test('invalid counts, floating values, numerator over denominator and unknown keys are rejected', () => {
  for (const numerator of [-1, 2, 1.5, '01', '-1', '1e3', '0.1', '1000000000000000000']) {
    const input = dailySnapshot(); input.metrics.chat_rate.numerator = numerator;
    assert.throws(() => composeReport(input), /^Error: invalid_report_snapshot$/);
  }
  const input = dailySnapshot(); input.metrics.chat_rate.numerator = '201'; assert.throws(() => composeReport(input), /invalid_report_snapshot/);
  input.metrics.chat_rate.numerator = '100'; input.metrics.secret = 'ignore'; assert.throws(() => composeReport(input), /invalid_report_snapshot/);
});
test('coarse OpenRouter amount cannot become an exact report-window cost', () => {
  const input = dailySnapshot(); input.metrics.openrouter_cost.window_precision = 'coarse';
  const result = composeReport(input); assert.equal(result.metrics.openrouter_cost.reason, 'coarse_cost_window'); assert.equal(result.metrics.openrouter_cost.value, null);
  assert(!result.text.includes('USD 1.234567891'));
});
test('UTC-day cost mismatching the Beijing report-day remains unknown', () => {
  const input = dailySnapshot(); input.metrics.openrouter_cost.window = { start_utc: '2026-10-07T00:00:00Z', end_utc: '2026-10-08T00:00:00Z', time_zone: 'UTC' };
  input.metrics.openrouter_cost.source.complete_through_utc = '2026-10-08T00:00:00Z';
  assert.equal(composeReport(input).metrics.openrouter_cost.reason, 'window_mismatch');
});
test('mode missing counts and incomplete coverage never produce a misleading total', () => {
  const input = dailySnapshot(); input.metrics.mode_message_counts.modes[0].count = null;
  let result = composeReport(input).metrics.mode_message_counts; assert.equal(result.value, null); assert(result.details.includes('mode-a：未知')); assert(result.details.includes('mode-b：50'));
  input.metrics.mode_message_counts.modes[0].count = '0'; input.metrics.mode_message_counts.coverage_complete = false;
  result = composeReport(input).metrics.mode_message_counts; assert.equal(result.status, 'unknown'); assert.equal(result.value, null);
  input.metrics.mode_message_counts.modes.push({ mode: 'mode-a', count: '1' }); assert.throws(() => composeReport(input), /invalid_report_snapshot/);
});
test('uncompleted next-day data cannot be reported as measured retention', () => {
  const input = dailySnapshot(); input.metrics.new_user_next_day_retention.source.complete_through_utc = input.metrics.new_user_next_day_retention.window.end_utc;
  assert.equal(composeReport(input).metrics.new_user_next_day_retention.reason, 'incomplete_data');
});
test('retention must observe the report day after an adjacent complete cohort day', () => {
  const input = dailySnapshot(); input.metrics.new_user_next_day_retention.window.start_utc = '2026-10-05T17:00:00Z';
  assert.equal(composeReport(input).metrics.new_user_next_day_retention.reason, 'invalid_next_day_window');
  input.metrics.new_user_next_day_retention.followup_window = structuredClone(input.metrics.new_user_next_day_retention.window);
  assert.equal(composeReport(input).metrics.new_user_next_day_retention.reason, 'window_mismatch');
});
test('DST day windows are accepted by local dates, not assumed to be 24 hours', () => {
  const input = dailySnapshot(); input.window = { start_utc: '2026-03-08T05:00:00Z', end_utc: '2026-03-09T04:00:00Z', time_zone: 'America/New_York' }; input.generated_at_utc = '2026-03-09T10:00:00Z';
  const metric = input.metrics.new_user_next_day_retention;
  metric.window = { start_utc: '2026-03-07T05:00:00Z', end_utc: '2026-03-08T05:00:00Z', time_zone: 'America/New_York' }; metric.followup_window = structuredClone(input.window); metric.source.complete_through_utc = input.window.end_utc;
  input.metrics = { new_user_next_day_retention: metric };
  assert.equal(composeReport(input).metrics.new_user_next_day_retention.value, '20.00% (20/100)');
});
test('timestamps and zones must be explicit valid supported complete local days', () => {
  for (const mutate of [x => x.window.time_zone = 'Bad/Zone', x => x.window.time_zone = '+08:00', x => x.window.start_utc = '2026-02-30T16:00:00Z', x => x.window.start_utc = '2026-10-06T16:00:00', x => x.window.end_utc = '2026-10-07T17:00:00Z', x => x.generated_at_utc = '2026-10-06T00:00:00Z']) {
    const input = dailySnapshot(); mutate(input); assert.throws(() => composeReport(input), /invalid_report_snapshot/);
  }
});
test('determinism includes provided source and definition, not only visible metric values', () => {
  const input = dailySnapshot(); const first = composeReport(input); assert.deepEqual(composeReport(input), first);
  input.metrics.chat_rate.definition += ' revised'; assert.notEqual(composeReport(input).snapshot_sha256, first.snapshot_sha256);
  input.max_chunk_length = 100; const small = composeReport(input); assert.equal(small.plan.chunks.map(x => x.text).join(''), small.text); assert(small.plan.chunks.every(x => x.text.length <= 100));
});
test('labels and references have bounded single-line well-formed text, with no control spoofing', () => {
  for (const title of ['x\nnew line', 'x\u202Ehidden', 'x\uD800', ' ', 'a'.repeat(121)]) {
    const input = dailySnapshot(); input.title = title; assert.throws(() => composeReport(input), /invalid_report_snapshot/);
  }
});
