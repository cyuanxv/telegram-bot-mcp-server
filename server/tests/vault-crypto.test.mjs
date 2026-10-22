import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sealCredential, openCredential, credentialMetadata, validateEnvelope, VaultError } from '../lib/telegram/vault/crypto.ts';
const context = { ownerId: 'owner-A', alias: 'bot-A', purpose: 'bot_token' };
const secret = { token: 'SYNTHETIC_TEST_TOKEN_NOT_REAL' };
const keys = new Map([['key-v1', randomBytes(32)], ['key-v2', randomBytes(32)]]);
const options = { revision: 1, createdAt: 1000000, expiresAt: 2000000 };
function seal(c = context, value = secret, keyId = 'key-v1', opts = options) { return sealCredential(c, value, keys, keyId, opts); }
function tamper(value) { const bytes = Buffer.from(value, 'base64url'); bytes[0] ^= 1; return bytes.toString('base64url'); }

test('AES-GCM roundtrip preserves a synthetic token without plaintext in envelope or metadata', () => {
  const envelope = seal(); assert.deepEqual(openCredential(context, envelope, keys, 1000001), secret);
  assert.ok(!JSON.stringify(envelope).includes(secret.token)); assert.ok(!JSON.stringify(credentialMetadata(envelope)).includes(envelope.ciphertext));
  assert.equal(credentialMetadata(envelope).providerAuthorizationVerified, false);
});
test('MTProto account bundle is sealed as one validated record', () => {
  const c = { ...context, purpose: 'mtproto_account' }, value = { apiId: 12345, apiHash: 'a'.repeat(32), session: 'SYNTHETIC_SESSION_NOT_REAL' };
  const envelope = seal(c, value); assert.deepEqual(openCredential(c, envelope, keys, 1000001), value);
  for (const marker of [value.apiHash, value.session]) assert.ok(!JSON.stringify(envelope).includes(marker));
});
test('fresh nonces make identical inputs distinct and master keys are not mutated', () => {
  const original = Buffer.from(keys.get('key-v1')); const nonces = new Set();
  for (let i = 0; i < 128; i++) nonces.add(seal().nonce);
  assert.equal(nonces.size, 128); assert.deepEqual(Buffer.from(keys.get('key-v1')), original);
});
test('owner, alias and purpose binding refuses cross-context reuse', () => {
  const envelope = seal();
  for (const expected of [{ ...context, ownerId: 'owner-B' }, { ...context, alias: 'bot-B' }, { ...context, purpose: 'mtproto_account' }]) assert.throws(() => openCredential(expected, envelope, keys, 1000001), /credential_unavailable/);
});
test('every authenticated metadata field and ciphertext/tag/nonce reject tampering', () => {
  const original = seal();
  const patches = [{ ownerId: 'owner-B' }, { alias: 'bot-B' }, { keyId: 'key-v2' }, { revision: 2 }, { createdAt: 1000001 }, { expiresAt: 2100000 }, { ciphertext: tamper(original.ciphertext) }, { nonce: tamper(original.nonce) }, { tag: tamper(original.tag) }];
  for (const patch of patches) {
    const changed = { ...original, ...patch }; const expected = { ownerId: changed.ownerId, alias: changed.alias, purpose: changed.purpose };
    assert.throws(() => openCredential(expected, changed, keys, 1000010), e => e instanceof VaultError && !e.message.includes(secret.token));
  }
});
test('JSONB-style property reordering does not change authenticated meaning', () => {
  const reordered = Object.fromEntries(Object.entries(seal()).reverse());
  assert.deepEqual(openCredential(context, reordered, keys, 1000001), secret);
});
test('wrong, absent or incorrectly sized keys fail closed with fixed errors', () => {
  const envelope = seal();
  for (const ring of [new Map(), new Map([['key-v1', randomBytes(31)]]), new Map([['key-v1', randomBytes(32)]])]) assert.throws(() => openCredential(context, envelope, ring, 1000001), /credential_unavailable/);
  assert.throws(() => sealCredential(context, secret, new Map([['key-v1', randomBytes(31)]]), 'key-v1', options), /key_unavailable/);
});
test('expiry and future-clock boundaries are enforced before opening', () => {
  const envelope = seal(); assert.throws(() => openCredential(context, envelope, keys, 2000000), /unavailable/);
  assert.throws(() => openCredential(context, envelope, keys, 0), /unavailable/);
  assert.deepEqual(openCredential(context, envelope, keys, 1999999), secret);
});
test('invalid plaintext schemas and extra fields are rejected without echoing values', () => {
  for (const value of [{ token: '' }, { token: 'private secret with spaces' }, { token: 'x\nsecret' }, { token: 'x'.repeat(4097) }, { token: secret.token, extra: 'private' }, [], null]) {
    assert.throws(() => seal(context, value), e => !e.message.includes('private') && !e.message.includes(secret.token));
  }
  const c = { ...context, purpose: 'mtproto_account' };
  for (const value of [{ apiId: 0, apiHash: 'a'.repeat(32), session: 'SYNTHETIC' }, { apiId: 1, apiHash: 'bad-private-hash', session: 'SYNTHETIC' }, { apiId: 1, apiHash: 'a'.repeat(32), session: 'x'.repeat(8193) }]) assert.throws(() => seal(c, value));
});
test('envelope syntax rejects extra fields, noncanonical base64, wrong lengths and budgets', () => {
  const envelope = seal();
  for (const patch of [{ extra: 'secret' }, { nonce: envelope.nonce + '=' }, { tag: 'a' }, { algorithm: 'AES-CBC' }, { version: 2 }, { ciphertext: 'a'.repeat(30000) }, { revision: 0 }, { expiresAt: options.createdAt }]) assert.throws(() => validateEnvelope({ ...envelope, ...patch }));
});
test('explicit re-encryption under another key and next revision preserves the secret', () => {
  const first = seal(); const opened = openCredential(context, first, keys, 1000001);
  const second = seal(context, opened, 'key-v2', { ...options, revision: 2 });
  assert.notEqual(first.nonce, second.nonce); assert.deepEqual(openCredential(context, second, new Map([['key-v2', keys.get('key-v2')]]), 1000001), secret);
});
