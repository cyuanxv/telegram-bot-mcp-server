// Synthetic-only demonstration. Does not accept input, read environment keys or contact any service.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { sealCredential, openCredential } from '../lib/telegram/vault/crypto.ts';
import { PostgresCredentialVault } from '../lib/telegram/vault/postgres-vault.ts';
const key = randomBytes(32), keyring = new Map([['demo-key', key]]);
const context = { ownerId: 'synthetic-owner', alias: 'synthetic-bot', purpose: 'bot_token' };
const secret = { token: 'SYNTHETIC_ONLY_NOT_A_REAL_TELEGRAM_TOKEN' };
const db = new PGlite();
try {
  await db.exec(readFileSync(new URL('../migrations/003_credential_vault.sql', import.meta.url), 'utf8'));
  const vault = new PostgresCredentialVault({ transaction: fn => db.transaction(tx => fn({ query: (sql, args) => tx.query(sql, args) })) });
  const sealed = sealCredential(context, secret, keyring, 'demo-key', { revision: 1, createdAt: Date.now() });
  await vault.save(sealed, 0); const stored = await vault.loadSealed(context);
  assert.deepEqual(openCredential(context, stored, keyring, Date.now()), secret);
  console.log(JSON.stringify({ simulated: true, real_credentials_used: 0, external_connections: 0, metadata: await vault.status(context) }));
} finally { key.fill(0); await db.close(); }
