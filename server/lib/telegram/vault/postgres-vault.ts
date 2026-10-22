import type { SqlExecutor, TransactionalSql } from "../delivery/postgres-store";
import { credentialMetadata, validateContext, validateEnvelope, VaultError, type CredentialContext, type SealedCredential } from "./crypto";
/** Sealed envelopes only: no key material or plaintext ever belongs in this SQL adapter. */
export const MAX_VAULT_RECORDS = 1000;
function sameEnvelope(a: SealedCredential, b: SealedCredential) {
  return ["ownerId", "alias", "purpose", "version", "algorithm", "keyId", "revision", "createdAt", "expiresAt", "nonce", "tag", "ciphertext"].every(key => a[key as keyof SealedCredential] === b[key as keyof SealedCredential]);
}
export class PostgresCredentialVault {
  private database: TransactionalSql;
  constructor(database: TransactionalSql) { this.database = database; }
  private async transaction<T>(change: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    try { return await this.database.transaction(change); }
    catch (error) { if (error instanceof VaultError) throw error; throw new VaultError("storage_unavailable"); }
  }
  async save(supplied: SealedCredential, expectedRevision: number) {
    const envelope = structuredClone(supplied); validateEnvelope(envelope);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER || envelope.revision !== expectedRevision + 1) throw new VaultError("revision_conflict");
    return this.transaction(async sql => {
      let rows;
      if (expectedRevision === 0) {
        await sql.query("LOCK TABLE public.telegram_credential_vault IN SHARE ROW EXCLUSIVE MODE");
        const prior = (await sql.query("SELECT envelope FROM public.telegram_credential_vault WHERE owner_id=$1 AND alias=$2 AND purpose=$3", [envelope.ownerId, envelope.alias, envelope.purpose])).rows[0];
        if (prior) {
          const stored = prior.envelope as SealedCredential; validateEnvelope(stored);
          if (sameEnvelope(stored, envelope)) return credentialMetadata(stored);
          throw new VaultError("revision_conflict");
        }
        const count = Number((await sql.query("SELECT COUNT(*) AS n FROM public.telegram_credential_vault")).rows[0]?.n);
        if (!Number.isSafeInteger(count) || count >= MAX_VAULT_RECORDS) throw new VaultError("capacity_reached");
        rows = (await sql.query("INSERT INTO public.telegram_credential_vault(owner_id,alias,purpose,revision,envelope) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(owner_id,alias,purpose) DO NOTHING RETURNING revision", [envelope.ownerId, envelope.alias, envelope.purpose, envelope.revision, JSON.stringify(envelope)])).rows;
      } else {
        rows = (await sql.query("UPDATE public.telegram_credential_vault SET revision=$1,envelope=$2::jsonb WHERE owner_id=$3 AND alias=$4 AND purpose=$5 AND revision=$6 RETURNING revision", [envelope.revision, JSON.stringify(envelope), envelope.ownerId, envelope.alias, envelope.purpose, expectedRevision])).rows;
      }
      if (rows.length !== 1) {
        const prior = (await sql.query("SELECT envelope FROM public.telegram_credential_vault WHERE owner_id=$1 AND alias=$2 AND purpose=$3", [envelope.ownerId, envelope.alias, envelope.purpose])).rows[0];
        if (prior) { const stored = prior.envelope as SealedCredential; validateEnvelope(stored); if (sameEnvelope(stored, envelope)) return credentialMetadata(stored); }
        throw new VaultError("revision_conflict");
      }
      return credentialMetadata(envelope);
    });
  }
  async loadSealed(context: CredentialContext): Promise<SealedCredential | undefined> {
    const expected = structuredClone(context); validateContext(expected);
    return this.transaction(async sql => {
      const row = (await sql.query("SELECT revision,envelope FROM public.telegram_credential_vault WHERE owner_id=$1 AND alias=$2 AND purpose=$3", [expected.ownerId, expected.alias, expected.purpose])).rows[0];
      if (!row) return undefined;
      const envelope = structuredClone(row.envelope) as SealedCredential; validateEnvelope(envelope);
      if (envelope.ownerId !== expected.ownerId || envelope.alias !== expected.alias || envelope.purpose !== expected.purpose || envelope.revision !== Number(row.revision)) throw new VaultError("invalid_envelope");
      return envelope;
    });
  }
  /** Owner-scoped inventory; deliberately never selects sealed envelopes. */
  async listBots(ownerId:string):Promise<{alias:string;credential_revision:number}[]>{
    validateContext({ownerId,alias:'directory',purpose:'bot_token'});
    return this.transaction(async sql=>{
      const rows=(await sql.query("SELECT alias,revision FROM public.telegram_credential_vault WHERE owner_id=$1 AND purpose='bot_token' ORDER BY alias LIMIT 1001",[ownerId])).rows;
      if(rows.length>MAX_VAULT_RECORDS)throw new VaultError('capacity_reached');
      return rows.map(row=>{const revision=Number(row.revision);if(typeof row.alias!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.alias)||!Number.isSafeInteger(revision)||revision<1)throw new VaultError('invalid_metadata');return {alias:row.alias,credential_revision:revision}});
    });
  }
  async status(context: CredentialContext) { const envelope = await this.loadSealed(context); return envelope ? credentialMetadata(envelope) : { sealedRecordExists: false, providerAuthorizationVerified: false }; }
}
