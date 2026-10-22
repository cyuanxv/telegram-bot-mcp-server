import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PostgresInboxStore } from '../lib/telegram/inbox/postgres-inbox.ts';
import { normalizedUpdate } from '../lib/telegram/inbox/normalize.ts';
import { handleWebhook } from '../lib/telegram/inbox/receiver.ts';
const migration = readFileSync(new URL('../migrations/002_telegram_inbox.sql', import.meta.url), 'utf8');
const secret = 'synthetic_webhook_secret_1234567890';
const policy = { secretToken: secret, allowedChatIds: ['-10012345', '-100999'], retainText: true, retentionDays: 7 };
function raw(id = 1, chat = -10012345, text = 'example text') { return { update_id: id, message: { message_id: 20, date: 1000, chat: { id: chat }, text } }; }
function event(id = 1, chat = -10012345, text) { return normalizedUpdate(raw(id, chat, text), 'reports', policy, 1000000); }
function wrap(pg) { return { transaction: fn => pg.transaction(tx => fn({ query: (sql, values) => tx.query(sql, values) })) }; }
async function setup(t) { const pg = new PGlite(); await pg.exec(migration); t.after(() => pg.close()); return { pg, store: new PostgresInboxStore(wrap(pg)) }; }
const scope = { botAlias: 'reports', chatIds: ['-10012345'], now: 1000000 };

test('PostgreSQL inbox persists normalized events and deduplicates racing requests', async t => {
  const { store } = await setup(t); const results = await Promise.all(Array.from({ length: 12 }, () => store.record(event())));
  assert.equal(results.filter(r => r === 'stored').length, 1); assert.equal(results.filter(r => r === 'duplicate').length, 11);
  const rows = await store.list(scope); assert.equal(rows.length, 1); assert.equal(rows[0].event.text, 'example text');
});
test('same update key with different retained content is a conflict without overwrite', async t => {
  const { store } = await setup(t); await store.record(event()); assert.equal(await store.record(event(1, -10012345, 'changed')), 'conflict');
  assert.equal((await store.list(scope))[0].event.text, 'example text');
});
test('inbox reads enforce chat scope, cursor, limits and expiry without silently purging data', async t => {
  const { store, pg } = await setup(t); await store.record(event(1)); await store.record(event(2, -100999)); await store.record(event(3));
  const first = await store.list({ ...scope, limit: 1 }); const next = await store.list({ ...scope, afterSequence: first[0].sequence });
  assert.equal(first.length, 1); assert.equal(next.length, 1); assert.equal(next[0].event.updateId, '3');
  assert.equal((await store.list({ ...scope, now: event().expiresAt })).length, 0);
  assert.equal(Number((await pg.query('SELECT COUNT(*) AS n FROM public.telegram_inbox_events')).rows[0].n), 3);
  await assert.rejects(store.list({ ...scope, chatIds: [] })); await assert.rejects(store.list({ ...scope, limit: 101 }));
});
test('explicit approved-cutoff purge removes only expired rows', async t => {
  const { store } = await setup(t); await store.record(event());
  assert.deepEqual(await store.purgeExpired(event().expiresAt - 1), { deleted: 0 });
  assert.deepEqual(await store.purgeExpired(event().expiresAt), { deleted: 1 });
});
test('mutating caller input after record starts cannot change persisted content', async t => {
  const { pg } = await setup(t); let start; const barrier = new Promise(resolve => start = resolve);
  const db = { transaction: async fn => { await barrier; return wrap(pg).transaction(fn); } };
  const store = new PostgresInboxStore(db), e = event(), pending = store.record(e); e.text = 'mutated after validation'; start();
  assert.equal(await pending, 'stored'); assert.equal((await store.list(scope))[0].event.text, 'example text');
});
test('lost commit acknowledgement returns 503, then Telegram retry is durably deduplicated', async t => {
  const { pg } = await setup(t); let loseAck = true;
  const store = new PostgresInboxStore({ transaction: async fn => { const result = await wrap(pg).transaction(fn); if (loseAck) { loseAck = false; throw new Error('lost commit ack with private URL'); } return result; } });
  const makeRequest = () => new Request('https://example.invalid/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(raw()) });
  const open = async () => ({ store, close() {} }); const config = { bots: { reports: policy } };
  const first = await handleWebhook(makeRequest(), 'reports', config, open, 1000000); assert.equal(first.status, 503); assert.ok(!(await first.text()).includes('private'));
  const repeated = await handleWebhook(makeRequest(), 'reports', config, open, 1000001); assert.equal((await repeated.json()).status, 'duplicate'); assert.equal((await store.list(scope)).length, 1);
});
test('failed commit does not falsely acknowledge or leave a stored update', async t => {
  const { pg } = await setup(t);
  const db = { transaction: fn => pg.transaction(async tx => { await fn({ query: (sql, values) => tx.query(sql, values) }); throw new Error('rollback before commit'); }) };
  await assert.rejects(new PostgresInboxStore(db).record(event()));
  assert.equal((await pg.query('SELECT COUNT(*) AS n FROM public.telegram_inbox_events')).rows[0].n, 0);
});
test('inbox deduplication survives database close and process-like reopening', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-inbox-pg-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let pg = new PGlite(dir); await pg.exec(migration); let store = new PostgresInboxStore(wrap(pg)); await store.record(event()); await pg.close();
  pg = new PGlite(dir); t.after(() => pg.close()); store = new PostgresInboxStore(wrap(pg));
  assert.equal(await store.record(event()), 'duplicate'); assert.equal((await store.list(scope)).length, 1);
});
test('SQL schema rejects missing identity and unsafe document mismatch', async t => {
  const { store, pg } = await setup(t); await store.record(event());
  await assert.rejects(pg.query("UPDATE public.telegram_inbox_events SET document=document-'chatId'"));
  await assert.rejects(pg.query("UPDATE public.telegram_inbox_events SET document=jsonb_set(document,'{updateId}','\"other\"')"));
});

test('example retention SQL removes only expired default-bot events', async t => {
 const {store,pg}=await setup(t);const now=Date.now();
 await store.record(normalizedUpdate(raw(10),'default',policy,now-8*86400000));
 await store.record(normalizedUpdate(raw(11),'default',policy,now));
 await store.record(normalizedUpdate(raw(12),'reports',policy,now-8*86400000));
 const source=readFileSync(new URL('../migrations/inbox-retention.example.sql',import.meta.url),'utf8');
 const command=source.split('$job$')[1].split(';')[0];
 await pg.exec(command);
 const rows=(await pg.query('SELECT bot_alias,update_id FROM public.telegram_inbox_events ORDER BY update_id')).rows;
 assert.deepEqual(rows,[{bot_alias:'default',update_id:'11'},{bot_alias:'reports',update_id:'12'}]);
});

test('callback events persist and deduplicate with existing schema and expire under same policy',async t=>{
 const {store}=await setup(t);
 const payload={update_id:901,callback_query:{id:'callback-fixture',from:{id:456},message:{message_id:20,date:0,chat:{id:-10012345}},data:'button:1'}};
 const e=normalizedUpdate(payload,'reports',{...policy,acceptCallbacks:true},1000000);
 assert.equal(await store.record(e),'stored');assert.equal(await store.record(e),'duplicate');
 const rows=await store.list(scope);assert.equal(rows.length,1);assert.equal(rows[0].event.callbackQueryId,'callback-fixture');assert.equal(rows[0].event.text,'button:1');
 const changed=normalizedUpdate({...payload,callback_query:{...payload.callback_query,data:'button:2'}},'reports',{...policy,acceptCallbacks:true},1000000);
 assert.equal(await store.record(changed),'conflict');assert.equal((await store.list({...scope,now:e.expiresAt})).length,0);
});
