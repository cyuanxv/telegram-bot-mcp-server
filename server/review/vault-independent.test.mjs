// Independent review: synthetic inputs and in-memory PGlite only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { sealCredential, openCredential, validateEnvelope, credentialMetadata, VaultError } from '../lib/telegram/vault/crypto.ts';
import { PostgresCredentialVault, MAX_VAULT_RECORDS } from '../lib/telegram/vault/postgres-vault.ts';
const context = { ownerId: 'review-owner', alias: 'review-bot', purpose: 'bot_token' };
const secret = { token: 'SYNTHETIC_REVIEW_ONLY_NOT_A_CREDENTIAL' };
const key = randomBytes(32), keys = new Map([['review-key', key], ['same-key-bytes', key]]);
const options = { revision: 1, createdAt: 1_000_000, expiresAt: 2_000_000 };
const migration = readFileSync(new URL('../migrations/003_credential_vault.sql', import.meta.url), 'utf8');
const seal = (revision = 1, c = context) => sealCredential(c, secret, keys, 'review-key', { ...options, revision });
const fixedUnavailable = error => error instanceof VaultError && error.code === 'credential_unavailable' && error.message === 'Credential vault: credential_unavailable';
const wrapper = (pg, calls) => ({ transaction: fn => pg.transaction(tx => fn({ query: (sql, values) => { calls?.push({ sql, values }); return tx.query(sql, values); } })) });
async function setup(t) { const db = new PGlite(); await db.exec(migration); t.after(() => db.close()); return { db, vault: new PostgresCredentialVault(wrapper(db)) }; }
function authenticatedBytes(envelope, plaintext) {
  const e = { ...envelope }; const nonce = randomBytes(12);
  const associated = { domain: 'livelyverse.telegram.credential.v1', version: e.version, algorithm: e.algorithm, keyId: e.keyId, ownerId: e.ownerId, alias: e.alias, purpose: e.purpose, revision: e.revision, createdAt: e.createdAt, expiresAt: e.expiresAt ?? null };
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 }); cipher.setAAD(Buffer.from(JSON.stringify(associated)));
  e.ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64url');
  e.nonce = nonce.toString('base64url'); e.tag = cipher.getAuthTag().toString('base64url'); return e;
}

test('independent: keyId remains AAD-bound even when two key aliases have identical bytes', () => {
  const e = seal(); assert.throws(() => openCredential(context, { ...e, keyId: 'same-key-bytes' }, keys, 1_000_001), fixedUnavailable);
});
test('independent: removing expiry and swapping purpose/context cannot retain authentication', () => {
  const e = seal(); const { expiresAt, ...withoutExpiry } = e;
  for (const change of [withoutExpiry, { ...e, ownerId: 'another-owner' }, { ...e, alias: 'another-bot' }, { ...e, purpose: 'mtproto_account' }]) {
    const expected = { ownerId: change.ownerId, alias: change.alias, purpose: change.purpose };
    assert.throws(() => openCredential(expected, change, keys, 1_000_001), fixedUnavailable);
  }
});
test('independent: runtime malformed inputs and out-of-range clocks have one open error', () => {
  for (const e of [null, undefined, [], 'secret', 1, { ...seal(), ciphertext: '\ud800' }, { ...seal(), surprise: 'SYNTHETIC' }]) assert.throws(() => openCredential(context, e, keys, 1_000_001), fixedUnavailable);
  for (const now of [NaN, Infinity, -1, 1.5, 8_000_000_000_000_001]) assert.throws(() => openCredential(context, seal(), keys, now), fixedUnavailable);
});
test('independent: a valid GCM tag does not bypass UTF-8, JSON or exact-secret schema validation', () => {
  for (const plaintext of [Buffer.from([0xc0, 0xaf]), Buffer.from('{'), Buffer.from('null'), Buffer.from('[]'), Buffer.from('{"token":""}'), Buffer.from('{"token":"SYNTHETIC","extra":1}'), Buffer.from('{"apiId":1,"apiHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","session":"SYNTHETIC"}')]) {
    assert.throws(() => openCredential(context, authenticatedBytes(seal(), plaintext), keys, 1_000_001), fixedUnavailable);
  }
});
test('independent: exact nonce/tag bytes and canonical base64url enforce bounds', () => {
  const e = seal();
  for (const [field, lengths] of [['nonce', [0, 11, 13]], ['tag', [0, 15, 17]], ['ciphertext', [0, 16385]]]) for (const len of lengths) assert.throws(() => validateEnvelope({ ...e, [field]: Buffer.alloc(len, 1).toString('base64url') }));
  for (const change of [{ nonce: e.nonce + '=' }, { tag: e.tag.slice(0, -1) + 'B' }, { ciphertext: e.ciphertext + '\n' }]) assert.throws(() => validateEnvelope({ ...e, ...change }));
});
test('independent: JSON escaping counts against plaintext byte budget', () => {
  const c = { ...context, purpose: 'mtproto_account' };
  assert.throws(() => sealCredential(c, { apiId: 1, apiHash: 'a'.repeat(32), session: '\\'.repeat(8192) }, keys, 'review-key', options), /invalid_secret/);
});
test('independent: key buffer views are copied and caller key bytes survive success/failure', () => {
  const allocation = randomBytes(64), view = allocation.subarray(13, 45), before = Buffer.from(allocation), ring = new Map([['review-key', view]]);
  const e = sealCredential(context, secret, ring, 'review-key', options);
  assert.deepEqual(openCredential(context, e, ring, 1_000_001), secret);
  assert.throws(() => openCredential(context, { ...e, tag: Buffer.alloc(16).toString('base64url') }, ring, 1_000_001), fixedUnavailable);
  assert.throws(() => sealCredential(context, secret, ring, 'review-key', { ...options, revision: 0 }));
  assert.deepEqual(allocation, before);
});
test('independent: metadata has no decrypt/provider-auth assertion and no sealed bytes', () => {
  const e = seal(); const metadata = credentialMetadata(e);
  assert.equal(metadata.providerAuthorizationVerified, false);
  assert.deepEqual(Object.keys(metadata).sort(), ['ownerId','alias','purpose','revision','keyId','createdAt','expiresAt','sealedRecordExists','providerAuthorizationVerified'].sort());
  for (const marker of [secret.token, e.nonce, e.tag, e.ciphertext, key.toString('base64url')]) assert.ok(!JSON.stringify(metadata).includes(marker));
});
test('independent: status clones lookup context before an asynchronous database handoff', async t => {
  const { db, vault } = await setup(t); const e = seal(); await vault.save(e, 0);
  let release; const wait = new Promise(r => release = r); const delayed = new PostgresCredentialVault({ transaction: async fn => { await wait; return wrapper(db).transaction(fn); } });
  const query = { ...context }; const pending = delayed.status(query); query.ownerId = 'wrong-owner'; release(); assert.equal((await pending).ownerId, context.ownerId);
});
test('independent: capacity is global, duplicates still succeed, updates consume no slot', async t => {
  const { db, vault } = await setup(t); const e = seal(); await vault.save(e, 0);
  await db.query(`INSERT INTO public.telegram_credential_vault(owner_id,alias,purpose,revision,envelope) SELECT $1, 'filler-' || n, $2, $3, jsonb_set($4::jsonb,'{alias}',to_jsonb('filler-' || n)) FROM generate_series(1,$5::int) n`, [context.ownerId, context.purpose, e.revision, JSON.stringify(e), MAX_VAULT_RECORDS - 1]);
  assert.equal(Number((await db.query('SELECT COUNT(*) n FROM public.telegram_credential_vault')).rows[0].n), MAX_VAULT_RECORDS);
  assert.equal((await vault.save(e, 0)).revision, 1);
  await assert.rejects(vault.save(seal(1, { ...context, alias: 'overflow' }), 0), /capacity_reached/);
  assert.equal((await vault.save(seal(2), 1)).revision, 2);
});
test('independent: an aborted transaction does not publish a partial write and the same envelope can retry', async t => {
  const { db, vault } = await setup(t); const e = seal(); let fail = true;
  const failing = new PostgresCredentialVault({ transaction: fn => db.transaction(async tx => { const result = await fn({ query: (sql, values) => tx.query(sql, values) }); if (fail) { fail = false; throw new Error('SYNTHETIC_ABORT'); } return result; }) });
  await assert.rejects(failing.save(e, 0), e => e instanceof VaultError && e.message === 'Credential vault: storage_unavailable'); assert.equal(await vault.loadSealed(context), undefined);
  assert.equal((await failing.save(e, 0)).revision, 1);
});
test('independent: lost replacement acknowledgement is idempotent; stale retries cannot roll back newer versions', async t => {
  const { db, vault } = await setup(t); await vault.save(seal(), 0); const e2 = seal(2); let fail = true;
  const lostAck = new PostgresCredentialVault({ transaction: async fn => { const result = await wrapper(db).transaction(fn); if (fail) { fail = false; throw new Error('SYNTHETIC_LOST_ACK'); } return result; } });
  await assert.rejects(lostAck.save(e2, 1), e => e instanceof VaultError && e.message === 'Credential vault: storage_unavailable'); assert.equal((await lostAck.save(e2, 1)).revision, 2);
  const e3 = seal(3); await vault.save(e3, 2); await assert.rejects(vault.save(e2, 1), /revision_conflict/); assert.deepEqual(await vault.loadSealed(context), e3);
});
test('independent: SQL receives no synthetic plaintext or key material, including replacement', async t => {
  const { db } = await setup(t), calls = []; const vault = new PostgresCredentialVault(wrapper(db, calls));
  await vault.save(seal(), 0); await vault.save(seal(2), 1); await vault.status(context); const trace = JSON.stringify(calls);
  for (const marker of [secret.token, key.toString('hex'), key.toString('base64'), key.toString('base64url')]) assert.ok(!trace.includes(marker));
});
test('independent: in-memory demo ignores input/env markers and prints only bounded synthetic metadata', () => {
  const output = execFileSync(process.execPath, ['--import', './tests/register-typescript.mjs', 'scripts/vault-demo.mjs', 'SYNTHETIC_ARGUMENT_MUST_NOT_BE_IMPORTED'], { cwd: new URL('../', import.meta.url), input: 'SYNTHETIC_STDIN_MUST_NOT_BE_IMPORTED', env: { TELEGRAM_SESSION_ENCRYPTION_KEY: 'SYNTHETIC_ENV_MUST_NOT_BE_IMPORTED' }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const result = JSON.parse(output); assert.equal(result.simulated, true); assert.equal(result.real_credentials_used, 0); assert.equal(result.external_connections, 0); assert.equal(result.metadata.providerAuthorizationVerified, false);
  for (const marker of ['SYNTHETIC_ARGUMENT', 'SYNTHETIC_STDIN', 'SYNTHETIC_ENV', 'ciphertext', 'nonce', 'tag', 'SYNTHETIC_ONLY_NOT_A_REAL_TELEGRAM_TOKEN']) assert.ok(!output.includes(marker));
});

test('independent: query callback failures never expose driver messages through save/load/status', async () => {
  for (const error of [new Error('postgres://synthetic-user:SYNTHETIC_SECRET@invalid/db'), 'SYNTHETIC_DRIVER_STRING', { message: 'SYNTHETIC_DRIVER_OBJECT' }]) {
    const vault = new PostgresCredentialVault({ transaction: async fn => fn({ query: async () => { throw error; } }) });
    for (const operation of [() => vault.save(seal(), 0), () => vault.save(seal(2), 1), () => vault.loadSealed(context), () => vault.status(context)]) {
      await assert.rejects(operation(), error => error instanceof VaultError && error.code === 'storage_unavailable' && error.message === 'Credential vault: storage_unavailable' && !('cause' in error));
    }
  }
});
