// Security-hygiene regression: all data and keys here are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { sealCredential, openCredential } from '../lib/telegram/vault/crypto.ts';
const context = { ownerId: 'cleanup-review', alias: 'synthetic-bot', purpose: 'bot_token' };
const key = randomBytes(32), keys = new Map([['synthetic-key', key]]);
const secret = { token: 'SYNTHETIC_PLAINTEXT_CLEANUP_SENTINEL' };
for (const tampered of [false, true]) {
  test(`decryption update plaintext is cleared after ${tampered ? 'authentication failure' : 'successful authentication'}`, t => {
    const envelope = sealCredential(context, secret, keys, 'synthetic-key', { revision: 1, createdAt: 1 });
    const prototype = Object.getPrototypeOf(createDecipheriv('aes-256-gcm', key, randomBytes(12), { authTagLength: 16 }));
    const originalUpdate = prototype.update, plaintextChunks = [];
    t.mock.method(prototype, 'update', function (...args) { const chunk = originalUpdate.apply(this, args); if (Buffer.isBuffer(chunk)) plaintextChunks.push(chunk); return chunk; });
    if (tampered) {
      const tag = Buffer.from(envelope.tag, 'base64url'); tag[0] ^= 1; envelope.tag = tag.toString('base64url');
      assert.throws(() => openCredential(context, envelope, keys, 2), /credential_unavailable/);
    } else assert.deepEqual(openCredential(context, envelope, keys, 2), secret);
    assert.ok(plaintextChunks.length > 0, 'The regression must inspect an actual decryption output buffer');
    assert.ok(plaintextChunks.every(chunk => chunk.every(byte => byte === 0)), 'A decryption output buffer still contains synthetic plaintext after the function returns');
  });
}
