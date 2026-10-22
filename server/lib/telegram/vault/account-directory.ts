import {z} from 'zod';
import type {TransactionalSql,SqlExecutor} from '../delivery/postgres-store';
import {validateContext,validateEnvelope,VaultError,type SealedCredential} from './crypto';
export const accountScopeSchema=z.object({
 operations:z.array(z.enum(['get_me','list_dialogs','read_history','search','send_message','check_username'])).min(1).max(6).refine(v=>new Set(v).size===v.length),
 // Stable numeric peer identities only. Usernames can change owners.
 peers:z.array(z.string().regex(/^-?[1-9][0-9]{0,19}$/)).max(100).refine(v=>new Set(v).size===v.length),
}).strict().refine(v=>!v.operations.some(x=>['read_history','search','send_message'].includes(x))||v.peers.length>0);
export type AccountScope=z.infer<typeof accountScopeSchema>;
export type AccountDirectoryEntry={alias:string;userId:string;vaultRevision:number;revision:number;active:boolean;scope:AccountScope};
const positive=(v:unknown)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<1)throw new VaultError('invalid_account_directory');return n};
function entry(row:Record<string,unknown>):AccountDirectoryEntry{
 if(typeof row.alias!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.alias)||typeof row.user_id!=='string'||!/^[1-9][0-9]{0,15}$/.test(row.user_id)||!Number.isSafeInteger(Number(row.user_id))||typeof row.active!=='boolean')throw new VaultError('invalid_account_directory');
 const scope=accountScopeSchema.safeParse(row.scope);if(!scope.success)throw new VaultError('invalid_account_scope');
 return {alias:row.alias,userId:row.user_id,vaultRevision:positive(row.vault_revision),revision:positive(row.revision),active:row.active,scope:scope.data};
}
const columns='alias,user_id,vault_revision,revision,active,scope';
export class AccountDirectory{
 private db:TransactionalSql;
 constructor(db:TransactionalSql){this.db=db}
 private context(ownerId:string,alias:string){validateContext({ownerId,alias,purpose:'mtproto_account'});if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias))throw new VaultError('invalid_context')}
 private async transaction<T>(fn:(sql:SqlExecutor)=>Promise<T>):Promise<T>{try{return await this.db.transaction(fn)}catch(e){if(e instanceof VaultError)throw e;throw new VaultError('account_directory_unavailable')}}
 async get(ownerId:string,alias:string):Promise<AccountDirectoryEntry|undefined>{
  this.context(ownerId,alias);return this.transaction(async sql=>{const row=(await sql.query(`SELECT ${columns} FROM public.telegram_account_directory WHERE owner_id=$1 AND alias=$2`,[ownerId,alias])).rows[0];return row?entry(row):undefined});
 }
 /** Metadata-only inventory: no envelope/session is selected. */
 async listActive(ownerId:string):Promise<AccountDirectoryEntry[]>{
  this.context(ownerId,'accounts');return this.transaction(async sql=>{
   const rows=(await sql.query("SELECT d.alias,d.user_id,d.vault_revision,d.revision,d.active,d.scope FROM public.telegram_account_directory d JOIN public.telegram_credential_vault v ON v.owner_id=d.owner_id AND v.alias=d.alias AND v.purpose='mtproto_account' AND v.revision=d.vault_revision WHERE d.owner_id=$1 AND d.active=true ORDER BY d.alias LIMIT 1001",[ownerId])).rows;
   if(rows.length>1000)throw new VaultError('account_inventory_capacity');return rows.map(entry);
  });
 }
 async loadActive(ownerId:string,alias:string):Promise<{entry:AccountDirectoryEntry;envelope:SealedCredential}|undefined>{
  this.context(ownerId,alias);return this.transaction(async sql=>{
   const row=(await sql.query(`SELECT d.alias,d.user_id,d.vault_revision,d.revision,d.active,d.scope,v.envelope FROM public.telegram_account_directory d JOIN public.telegram_credential_vault v ON v.owner_id=d.owner_id AND v.alias=d.alias AND v.purpose='mtproto_account' AND v.revision=d.vault_revision WHERE d.owner_id=$1 AND d.alias=$2 AND d.active=true`,[ownerId,alias])).rows[0];
   if(!row)return undefined;const envelope=structuredClone(row.envelope) as SealedCredential;validateEnvelope(envelope);const record=entry(row);
   if(envelope.ownerId!==ownerId||envelope.alias!==alias||envelope.purpose!=='mtproto_account'||envelope.revision!==record.vaultRevision)throw new VaultError('invalid_account_directory');
   return {entry:record,envelope};
  });
 }
 /** Called after provider identity verification. Exact saved revision and CAS prevent silent replacement. */
 async activate(ownerId:string,value:Omit<AccountDirectoryEntry,'revision'|'active'>,expectedRevision:number):Promise<AccountDirectoryEntry>{
  value=structuredClone(value);this.context(ownerId,value.alias);
  entry({alias:value.alias,user_id:value.userId,vault_revision:value.vaultRevision,revision:1,active:true,scope:value.scope});
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER)throw new VaultError('revision_conflict');
  return this.transaction(async sql=>{
   const saved=(await sql.query("SELECT revision FROM public.telegram_credential_vault WHERE owner_id=$1 AND alias=$2 AND purpose='mtproto_account' FOR SHARE",[ownerId,value.alias])).rows[0];
   if(Number(saved?.revision)!==value.vaultRevision)throw new VaultError('revision_conflict');
   const rows=expectedRevision===0?(await sql.query(`INSERT INTO public.telegram_account_directory(owner_id,alias,user_id,vault_revision,revision,active,scope) VALUES($1,$2,$3,$4,1,true,$5::jsonb) ON CONFLICT(owner_id,alias) DO NOTHING RETURNING ${columns}`,[ownerId,value.alias,value.userId,value.vaultRevision,JSON.stringify(value.scope)])).rows:
    (await sql.query(`UPDATE public.telegram_account_directory SET vault_revision=$1,scope=$2::jsonb,active=true,revision=revision+1 WHERE owner_id=$3 AND alias=$4 AND revision=$5 AND user_id=$6 RETURNING ${columns}`,[value.vaultRevision,JSON.stringify(value.scope),ownerId,value.alias,expectedRevision,value.userId])).rows;
   if(rows.length!==1)throw new VaultError('revision_conflict');return entry(rows[0]);
  });
 }
 /** Disabling needs neither decryption nor provider connectivity, even after vault rotation. */
 async deactivate(ownerId:string,alias:string,expectedRevision:number):Promise<AccountDirectoryEntry>{
  this.context(ownerId,alias);if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||expectedRevision>=Number.MAX_SAFE_INTEGER)throw new VaultError('revision_conflict');
  return this.transaction(async sql=>{const rows=(await sql.query(`UPDATE public.telegram_account_directory SET active=false,revision=revision+1 WHERE owner_id=$1 AND alias=$2 AND revision=$3 RETURNING ${columns}`,[ownerId,alias,expectedRevision])).rows;if(rows.length!==1)throw new VaultError('revision_conflict');return entry(rows[0])});
 }
}
