import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
export type CredentialPurpose = "bot_token" | "mtproto_account";
export type CredentialContext = { ownerId: string; alias: string; purpose: CredentialPurpose };
export type BotSecret = { token: string };
export type AccountSecret = { apiId: number; apiHash: string; session: string; userId?: string };
export type CredentialSecret = BotSecret | AccountSecret;
export type SealedCredential = CredentialContext & { version: 1; algorithm: "A256GCM"; keyId: string; revision: number; createdAt: number; expiresAt?: number; nonce: string; tag: string; ciphertext: string };
export type VaultKeyring = ReadonlyMap<string, Uint8Array>;
const label = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const MAX_PLAINTEXT_BYTES = 16384;
export class VaultError extends Error { code: string; constructor(code: string) { super(`Credential vault: ${code}`); this.code = code; } }
export function validateContext(context: CredentialContext) {
  if (!context || typeof context.ownerId !== "string" || typeof context.alias !== "string" || !label.test(context.ownerId) || !label.test(context.alias)
    || !["bot_token", "mtproto_account"].includes(context.purpose)) throw new VaultError("invalid_context");
}
function integer(value: unknown) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_000_000_000_000_000; }
function secretValue(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value); }
function validateSecret(purpose: CredentialPurpose, value: unknown): CredentialSecret {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new VaultError("invalid_secret");
  const data = value as Record<string, unknown>, keys = Object.keys(data).sort().join(',');
  if (purpose === "bot_token" && keys === "token" && secretValue(data.token, 4096)) return { token: data.token };
  if (purpose === "mtproto_account" && ["apiHash,apiId,session","apiHash,apiId,session,userId"].includes(keys) && Number.isSafeInteger(data.apiId) && (data.apiId as number) > 0
    && typeof data.apiHash === "string" && /^[a-fA-F0-9]{32}$/.test(data.apiHash) && secretValue(data.session, 8192)) {
    if (data.userId !== undefined && (typeof data.userId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(data.userId) || !Number.isSafeInteger(Number(data.userId)))) throw new VaultError('invalid_secret');
    return { apiId: data.apiId as number, apiHash: data.apiHash, session: data.session, ...(data.userId===undefined?{}:{userId:data.userId as string}) };
  }
  throw new VaultError("invalid_secret");
}
function aad(envelope: Omit<SealedCredential, "nonce" | "tag" | "ciphertext">) {
  return Buffer.from(JSON.stringify({ domain: "livelyverse.telegram.credential.v1", version: envelope.version, algorithm: envelope.algorithm,
    keyId: envelope.keyId, ownerId: envelope.ownerId, alias: envelope.alias, purpose: envelope.purpose, revision: envelope.revision,
    createdAt: envelope.createdAt, expiresAt: envelope.expiresAt ?? null }), "utf8");
}
function bytes(value: unknown, max: number, exact?: number) {
  if (typeof value !== "string" || !value || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw new VaultError("invalid_envelope");
  const result = Buffer.from(value, "base64url");
  if (result.length < 1 || result.length > max || (exact !== undefined && result.length !== exact) || result.toString("base64url") !== value) throw new VaultError("invalid_envelope");
  return result;
}
export function validateEnvelope(envelope: SealedCredential) {
  validateContext(envelope);
  if (Object.keys(envelope).some(k => !["ownerId", "alias", "purpose", "version", "algorithm", "keyId", "revision", "createdAt", "expiresAt", "nonce", "tag", "ciphertext"].includes(k))
    || envelope.version !== 1 || envelope.algorithm !== "A256GCM" || typeof envelope.keyId !== "string" || !label.test(envelope.keyId)
    || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1 || !integer(envelope.createdAt)
    || (envelope.expiresAt !== undefined && (!integer(envelope.expiresAt) || envelope.expiresAt <= envelope.createdAt))) throw new VaultError("invalid_envelope");
  bytes(envelope.nonce, 12, 12); bytes(envelope.tag, 16, 16); bytes(envelope.ciphertext, MAX_PLAINTEXT_BYTES);
}
function keyBytes(keyring: VaultKeyring, keyId: string) {
  const value = keyring.get(keyId);
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw new VaultError("key_unavailable");
  return Buffer.from(value);
}
/** Backend-only primitive. Never expose plaintext input/decryption through chat or generic MCP tools. */
export function sealCredential(context: CredentialContext, secret: CredentialSecret, keyring: VaultKeyring, keyId: string,
  options: { revision: number; createdAt: number; expiresAt?: number }): SealedCredential {
  let key: Buffer | undefined, plaintext: Buffer | undefined;
  try {
    context = structuredClone(context); secret = structuredClone(secret); options = structuredClone(options);
    validateContext(context);
    const metadata = { version: 1 as const, algorithm: "A256GCM" as const, keyId, ownerId: context.ownerId, alias: context.alias, purpose: context.purpose,
      revision: options.revision, createdAt: options.createdAt, ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }) };
    const value = validateSecret(context.purpose, secret);
    plaintext = Buffer.from(JSON.stringify(value), "utf8"); if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new VaultError("invalid_secret");
    key = keyBytes(keyring, keyId); const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 }); cipher.setAAD(aad(metadata));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: SealedCredential = { ...metadata, nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
    validateEnvelope(envelope); return envelope;
  } catch (error) { if (error instanceof VaultError) throw error; throw new VaultError("seal_failed"); }
  finally { key?.fill(0); plaintext?.fill(0); }
}
/** For trusted backend use only; the returned value is highly sensitive and must never be tool output. */
export function openCredential(expected: CredentialContext, supplied: SealedCredential, keyring: VaultKeyring, now: number): CredentialSecret {
  let key: Buffer | undefined, plaintext: Buffer | undefined;
  const chunks: Buffer[] = [];
  try {
    expected = structuredClone(expected); validateContext(expected); const envelope = structuredClone(supplied); validateEnvelope(envelope);
    if (envelope.ownerId !== expected.ownerId || envelope.alias !== expected.alias || envelope.purpose !== expected.purpose
      || !integer(now) || envelope.createdAt > now + 300000 || (envelope.expiresAt !== undefined && envelope.expiresAt <= now)) throw new VaultError("credential_unavailable");
    key = keyBytes(keyring, envelope.keyId);
    const decipher = createDecipheriv("aes-256-gcm", key, bytes(envelope.nonce, 12, 12), { authTagLength: 16 });
    decipher.setAAD(aad(envelope)); decipher.setAuthTag(bytes(envelope.tag, 16, 16));
    chunks.push(decipher.update(bytes(envelope.ciphertext, MAX_PLAINTEXT_BYTES)));
    chunks.push(decipher.final());
    plaintext = Buffer.concat(chunks);
    return validateSecret(envelope.purpose, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)));
  } catch { throw new VaultError("credential_unavailable"); }
  finally { key?.fill(0); plaintext?.fill(0); for (const chunk of chunks) chunk.fill(0); }
}
export function credentialMetadata(envelope: SealedCredential) {
  validateEnvelope(envelope);
  return { ownerId: envelope.ownerId, alias: envelope.alias, purpose: envelope.purpose, revision: envelope.revision, keyId: envelope.keyId,
    createdAt: envelope.createdAt, ...(envelope.expiresAt === undefined ? {} : { expiresAt: envelope.expiresAt }), sealedRecordExists: true,
    providerAuthorizationVerified: false };
}
