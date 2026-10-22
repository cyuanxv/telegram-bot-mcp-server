import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sealCredential, openCredential } from '../lib/telegram/vault/crypto.ts';
import { PostgresCredentialVault } from '../lib/telegram/vault/postgres-vault.ts';
const migration = readFileSync(new URL('../migrations/003_credential_vault.sql', import.meta.url), 'utf8');
const context = { ownerId: 'owner-A', alias: 'bot-A', purpose: 'bot_token' }, keys = new Map([['test-key', randomBytes(32)]]), secret = { token: 'SYNTHETIC_TEST_TOKEN_NOT_REAL' };
function seal(revision = 1, c = context, token = secret.token) { return sealCredential(c, { token }, keys, 'test-key', { revision, createdAt: 1000000 }); }
function wrap(pg, capture) { return { transaction: fn => pg.transaction(tx => fn({ query: async (sql, values) => { capture?.push({ sql, values }); return tx.query(sql, values); } })) }; }
async function setup(t) { const pg = new PGlite(); await pg.exec(migration); t.after(() => pg.close()); const calls = []; return { pg, calls, vault: new PostgresCredentialVault(wrap(pg, calls)) }; }

test('PostgreSQL stores only sealed envelopes and status returns metadata without ciphertext', async t => {
  const { vault, calls } = await setup(t); const envelope = seal(); const result = await vault.save(envelope, 0);
  assert.equal(result.sealedRecordExists, true); assert.equal(result.providerAuthorizationVerified, false);
  assert.ok(!JSON.stringify(calls).includes(secret.token)); assert.ok(!JSON.stringify(result).includes(envelope.ciphertext));
  assert.deepEqual(openCredential(context, await vault.loadSealed(context), keys, 1000001), secret);
});
test('create retries are idempotent for the same envelope but never overwrite other data', async t => {
  const { vault } = await setup(t); const envelope = seal(); await vault.save(envelope, 0); assert.equal((await vault.save(envelope, 0)).revision, 1);
  await assert.rejects(vault.save(seal(), 0), /revision_conflict/); assert.deepEqual(await vault.loadSealed(context), envelope);
});
test('optimistic concurrent replacements allow one winner, and same-write retry is safe', async t => {
  const { vault } = await setup(t); await vault.save(seal(), 0);
  const a = seal(2, context, 'SYNTHETIC_A'), b = seal(2, context, 'SYNTHETIC_B');
  const results = await Promise.allSettled([vault.save(a, 1), vault.save(b, 1)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const stored = await vault.loadSealed(context); assert.equal((await vault.save(stored, 1)).revision, 2);
});
test('owner, alias and purpose lookup never crosses credential contexts', async t => {
  const { vault } = await setup(t); await vault.save(seal(), 0);
  for (const c of [{ ...context, ownerId: 'owner-B' }, { ...context, alias: 'bot-B' }, { ...context, purpose: 'mtproto_account' }]) assert.equal(await vault.loadSealed(c), undefined);
});
test('caller mutation while waiting cannot alter a pending sealed write', async t => {
  const { pg } = await setup(t); let resume; const barrier = new Promise(resolve => resume = resolve);
  const vault = new PostgresCredentialVault({ transaction: async fn => { await barrier; return wrap(pg).transaction(fn); } });
  const envelope = seal(); const original = structuredClone(envelope); const pending = vault.save(envelope, 0); envelope.ciphertext = 'changed'; resume(); await pending;
  assert.deepEqual(await vault.loadSealed(context), original);
});
test('lost commit acknowledgement is recovered by same-envelope retry without another version', async t => {
  const { pg } = await setup(t); let lose = true;
  const vault = new PostgresCredentialVault({ transaction: async fn => { const result = await wrap(pg).transaction(fn); if (lose) { lose = false; throw new Error('synthetic lost ack'); } return result; } });
  const envelope = seal(); await assert.rejects(vault.save(envelope, 0)); assert.equal((await vault.save(envelope, 0)).revision, 1);
});
test('sealed state survives reopen without storing master keys or plaintext', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-vault-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let pg = new PGlite(dir); await pg.exec(migration); let vault = new PostgresCredentialVault(wrap(pg)); await vault.save(seal(), 0); await pg.close();
  pg = new PGlite(dir); t.after(() => pg.close()); vault = new PostgresCredentialVault(wrap(pg));
  assert.deepEqual(openCredential(context, await vault.loadSealed(context), keys, 1000001), secret);
});
test('SQL constraints prevent missing identity or envelope/row revision mismatch', async t => {
  const { vault, pg } = await setup(t); await vault.save(seal(), 0);
  await assert.rejects(pg.query("UPDATE public.telegram_credential_vault SET envelope=envelope-'ownerId'"));
  await assert.rejects(pg.query("UPDATE public.telegram_credential_vault SET revision=2"));
});
test('vault adapter sanitizes untrusted SQL driver errors before exposing a failure', async () => {
  const vault = new PostgresCredentialVault({ transaction: async () => { throw new Error('postgres://user:private-driver-secret@host/db'); } });
  await assert.rejects(vault.save(seal(), 0), e => e.message === 'Credential vault: storage_unavailable');
  await assert.rejects(vault.loadSealed(context), e => e.message === 'Credential vault: storage_unavailable');
});


test('master-key rewrap uses revision CAS and invalidates the prior active binding',async t=>{
 const {rewrapCredential}=await import('../lib/telegram/vault/rewrap.ts');
 const {BotDirectory}=await import('../lib/telegram/vault/bot-directory.ts');
 const {pg,vault}=await setup(t);
 await pg.exec(readFileSync(new URL('../migrations/006_bot_directory.sql',import.meta.url),'utf8'));
 const directory=new BotDirectory(wrap(pg));const initial=seal();await vault.save(initial,0);
 await directory.set(context.ownerId,{alias:context.alias,botId:12345,vaultRevision:1,active:true},0);
 const ring=new Map([...keys,['new',randomBytes(32)]]);
 const next=rewrapCredential(context,initial,ring,'new',1000001);await vault.save(next,1);
 assert.equal(await directory.loadActive(context.ownerId,context.alias),undefined);
 assert.deepEqual(openCredential(context,await vault.loadSealed(context),new Map([['new',ring.get('new')]]),1000001),secret);
 assert.equal((await vault.save(next,1)).revision,2);
 await assert.rejects(vault.save(rewrapCredential(context,initial,ring,'new',1000001),1),/revision_conflict/);
});
