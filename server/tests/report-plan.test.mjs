import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planReport } from '../lib/telegram/report-plan.ts';

test('short text is returned unchanged without a send receipt', () => {
  const result = planReport('Daily report\nHello');
  assert.equal(result.sent, false); assert.equal(result.chunk_count, 1);
  assert.equal(result.chunks[0].text, 'Daily report\nHello');
});
test('plans are deterministic and fingerprint changes with content or limit', () => {
  assert.deepEqual(planReport('abc'), planReport('abc'));
  assert.notEqual(planReport('abc').plan_sha256, planReport('abd').plan_sha256);
  assert.notEqual(planReport('abc', 3).plan_sha256, planReport('abc', 4).plan_sha256);
});
test('line breaks are preferred without trimming or adding text', () => {
  const text = '123456\n1234567890';
  const result = planReport(text, 10);
  assert.equal(result.chunks[0].text, '123456\n');
  assert.equal(result.chunks.map(x => x.text).join(''), text);
});
test('emoji ZWJ, flags and combining sequences stay in one grapheme', () => {
  const text = '👩‍💻🇨🇳é'.repeat(40);
  const result = planReport(text, 17);
  const bounds = new Set([0, ...Array.from(new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text), x => x.index + x.segment.length)]);
  let end = 0;
  for (const chunk of result.chunks) { end += chunk.text.length; assert(bounds.has(end)); assert(chunk.text.length <= 17); assert(chunk.text.isWellFormed()); }
  assert.equal(result.chunks.map(x => x.text).join(''), text);
});
test('oversized single grapheme is rejected rather than corrupted', () => {
  assert.throws(() => planReport('👩‍💻', 2), /grapheme/);
});
test('lone UTF-16 surrogate is rejected', () => {
  assert.throws(() => planReport('x\ud800'), /surrogate/);
});
test('empty and whitespace-only inputs are rejected', () => {
  for (const text of ['', ' ', '\n\r\t']) assert.throws(() => planReport(text), /non-whitespace/);
});
test('all numeric and input size budgets are enforced', () => {
  for (const size of [0, -1, 1.2, 4097, NaN, Infinity]) assert.throws(() => planReport('abc', size), /integer/);
  assert.throws(() => planReport('a'.repeat(131073)), /input limit/);
  assert.throws(() => planReport('a'.repeat(65), 1), /64 messages/);
  assert.equal(planReport('a'.repeat(64), 1).chunk_count, 64);
});
test('exact maximum chunk and full input budgets remain lossless', () => {
  assert.equal(planReport('a'.repeat(4096), 4096).chunk_count, 1);
  const text = 'a'.repeat(131072);
  const result = planReport(text, 4096);
  assert.equal(result.chunk_count, 32);
  assert.equal(result.chunks.map(x => x.text).join(''), text);
});
test('plain text does not parse or rewrite HTML and Markdown', () => {
  const text = '<b>x</b> & <script> _markdown_ [url](https://example.com)';
  const result = planReport(text, 20);
  assert.equal(result.format, 'plain_text');
  assert.equal(result.chunks.map(x => x.text).join(''), text);
  assert(result.chunks.every(x => x.utf16_units <= 20));
});
test('deterministic mixed-text corpus preserves order, content and limits', () => {
  const units = ['A', '中', '🙂', '👩‍💻', 'é', '\r\n', ' '];
  for (let seed = 1; seed <= 80; seed++) {
    let state = seed; let text = '日报';
    for (let i = 0; i < 300; i++) { state = (state * 1664525 + 1013904223) >>> 0; text += units[state % units.length]; }
    const max = 20 + seed % 71;
    const result = planReport(text, max);
    assert.equal(result.chunks.map(x => x.text).join(''), text);
    assert(result.chunks.every(x => x.text.length > 0 && x.text.length <= max && x.text.isWellFormed()));
  }
});


test('whitespace-only chunks are rejected without silently changing the report', () => {
  for (const text of ['A' + ' '.repeat(20) + 'B', ' '.repeat(10) + 'A', 'A' + '\n'.repeat(30) + 'B', 'A' + ' '.repeat(20)]) {
    assert.throws(() => planReport(text, 10), /whitespace-only message/);
    assert.equal(planReport(text, 4096).chunks[0].text, text);
  }
});


test('a short blank tail is reflowed without changing bytes or grapheme boundaries', () => {
  const text = '1234567890 ';
  const result = planReport(text, 10);
  assert.equal(result.chunks.map(x => x.text).join(''), text);
  assert(result.chunks.every(x => x.text.trim() && x.text.length <= 10));
});
