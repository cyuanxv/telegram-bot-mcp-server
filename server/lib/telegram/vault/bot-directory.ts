import type { TransactionalSql, SqlExecutor } from "../delivery/postgres-store";
import { validateContext, validateEnvelope, VaultError, type SealedCredential } from "./crypto";
export type BotDirectoryEntry = { alias: string; botId: number; vaultRevision: number; revision: number; active: boolean; scopeRevision?: number };
function entry(row: Record<string, unknown>): BotDirectoryEntry {
  if(typeof row.alias!=="string")throw new VaultError("invalid_directory");
  const result = { alias: String(row.alias), botId: Number(row.bot_id), vaultRevision: Number(row.vault_revision), revision: Number(row.revision), active: row.active as boolean };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(result.alias) || [result.botId,result.vaultRevision,result.revision].some(n => !Number.isSafeInteger(n) || n < 1) || typeof result.active !== "boolean") throw new VaultError("invalid_directory");
  const scopeRevision=row.scope_revision===undefined||row.scope_revision===null?undefined:Number(row.scope_revision);
  if(scopeRevision!==undefined&&(!Number.isSafeInteger(scopeRevision)||scopeRevision<1))throw new VaultError("invalid_directory");
  return {...result,...(scopeRevision===undefined?{}:{scopeRevision})};
}
export class BotDirectory {
  private db: TransactionalSql;
  constructor(db: TransactionalSql) { this.db = db; }
  private async transaction<T>(fn: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    try { return await this.db.transaction(fn); } catch (e) { if(e instanceof VaultError) throw e; throw new VaultError("directory_unavailable"); }
  }
  async list(ownerId: string): Promise<BotDirectoryEntry[]> {
    validateContext({ownerId,alias:"directory",purpose:"bot_token"});
    return this.transaction(async sql => (await sql.query("SELECT alias,bot_id,vault_revision,revision,active FROM public.telegram_bot_directory WHERE owner_id=$1 ORDER BY alias LIMIT 1001",[ownerId])).rows.map(entry));
  }
  async get(ownerId: string, alias: string, requireScope=false): Promise<BotDirectoryEntry | undefined> {
    validateContext({ownerId,alias,purpose:"bot_token"});
    return this.transaction(async sql => {
      const row=(await sql.query(`SELECT alias,bot_id,vault_revision,revision,active${requireScope?",scope_revision":""} FROM public.telegram_bot_directory WHERE owner_id=$1 AND alias=$2`,[ownerId,alias])).rows[0];
      return row?entry(row):undefined;
    });
  }
  async listActive(ownerId: string, requireScope=false): Promise<BotDirectoryEntry[]> {
    validateContext({ownerId,alias:"directory",purpose:"bot_token"});
    return this.transaction(async sql => (await sql.query(`SELECT d.alias,d.bot_id,d.vault_revision,d.revision,d.active FROM public.telegram_bot_directory d JOIN public.telegram_credential_vault v ON v.owner_id=d.owner_id AND v.alias=d.alias AND v.purpose='bot_token' AND v.revision=d.vault_revision ${requireScope?"JOIN public.telegram_bot_scope s ON s.owner_id=d.owner_id AND s.alias=d.alias AND s.bot_id=d.bot_id AND s.vault_revision=d.vault_revision AND s.revision=d.scope_revision":""} WHERE d.owner_id=$1 AND d.active=true ORDER BY d.alias LIMIT 1001`,[ownerId])).rows.map(entry));
  }
  async loadActive(ownerId: string, alias: string, requireScope=false): Promise<{ entry: BotDirectoryEntry; envelope: SealedCredential } | undefined> {
    validateContext({ownerId,alias,purpose:"bot_token"});
    return this.transaction(async sql => {
      const row=(await sql.query(`SELECT d.alias,d.bot_id,d.vault_revision,d.revision,${requireScope?"d.active,d.scope_revision":"d.active"},v.envelope FROM public.telegram_bot_directory d JOIN public.telegram_credential_vault v ON v.owner_id=d.owner_id AND v.alias=d.alias AND v.purpose='bot_token' AND v.revision=d.vault_revision WHERE d.owner_id=$1 AND d.alias=$2 AND d.active=true`,[ownerId,alias])).rows[0];
      if(!row)return undefined;
      const envelope=structuredClone(row.envelope) as SealedCredential;validateEnvelope(envelope);
      if(envelope.ownerId!==ownerId||envelope.alias!==alias||envelope.purpose!=="bot_token"||envelope.revision!==Number(row.vault_revision))throw new VaultError("invalid_directory");
      return {entry:entry(row),envelope};
    });
  }
  /** Compare-and-set: bind explicit identity and exact saved credential revision. */
  async set(ownerId: string, value: Omit<BotDirectoryEntry,"revision">, expectedRevision: number): Promise<BotDirectoryEntry> {
    value=structuredClone(value);validateContext({ownerId,alias:value.alias,purpose:"bot_token"});
    entry({...value,bot_id:value.botId,vault_revision:value.vaultRevision,revision:1});
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER)throw new VaultError("revision_conflict");
    return this.transaction(async sql => {
      // Lock the saved revision while changing activation. Runtime reads join the
      // same revision; a later credential rotation never silently stays enabled.
      const stored=(await sql.query("SELECT revision FROM public.telegram_credential_vault WHERE owner_id=$1 AND alias=$2 AND purpose='bot_token' FOR SHARE",[ownerId,value.alias])).rows[0];
      if(Number(stored?.revision)!==value.vaultRevision)throw new VaultError("revision_conflict");
      if(value.active&&value.scopeRevision!==undefined){
        const scope=(await sql.query("SELECT bot_id,vault_revision,revision FROM public.telegram_bot_scope WHERE owner_id=$1 AND alias=$2 FOR SHARE",[ownerId,value.alias])).rows[0];
        if(!Number.isSafeInteger(value.scopeRevision)||value.scopeRevision<1||Number(scope?.revision)!==value.scopeRevision||Number(scope?.vault_revision)!==value.vaultRevision||Number(scope?.bot_id)!==value.botId)throw new VaultError("revision_conflict");
      }
      let rows;
      if(expectedRevision===0){
        if(!value.active)throw new VaultError("revision_conflict");
        rows=(await sql.query("INSERT INTO public.telegram_bot_directory(owner_id,alias,purpose,bot_id,vault_revision,revision,active) VALUES($1,$2,'bot_token',$3,$4,1,true) ON CONFLICT(owner_id,alias) DO NOTHING RETURNING alias,bot_id,vault_revision,revision,active",[ownerId,value.alias,value.botId,value.vaultRevision])).rows;
      }else{
        rows=(await sql.query("UPDATE public.telegram_bot_directory SET active=$1,vault_revision=$2,revision=revision+1 WHERE owner_id=$3 AND alias=$4 AND revision=$5 AND bot_id=$6 RETURNING alias,bot_id,vault_revision,revision,active",[value.active,value.vaultRevision,ownerId,value.alias,expectedRevision,value.botId])).rows;
      }
      if(rows.length!==1)throw new VaultError("revision_conflict");
      if(value.scopeRevision!==undefined){await sql.query("UPDATE public.telegram_bot_directory SET scope_revision=$3 WHERE owner_id=$1 AND alias=$2",[ownerId,value.alias,value.scopeRevision]);rows[0].scope_revision=value.scopeRevision;}
      return entry(rows[0]);
    });
  }
}
