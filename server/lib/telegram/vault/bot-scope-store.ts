import type {TransactionalSql,SqlExecutor} from '../delivery/postgres-store';
import {validateContext,VaultError} from './crypto';
import {validateBotScope,type BotScope} from './bot-scope';
export type SavedBotScope={alias:string;botId:number;vaultRevision:number;revision:number;policy:BotScope};
function decode(row:Record<string,unknown>):SavedBotScope{
 const value={alias:row.alias as string,botId:Number(row.bot_id),vaultRevision:Number(row.vault_revision),revision:Number(row.revision),policy:validateBotScope(row.policy)};
 if(typeof value.alias!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.alias)||[value.botId,value.vaultRevision,value.revision].some(v=>!Number.isSafeInteger(v)||v<1))throw new VaultError('invalid_scope');
 return value;
}
export class BotScopeStore{
 private db:TransactionalSql;
 constructor(db:TransactionalSql){this.db=db}
 private async transaction<T>(fn:(sql:SqlExecutor)=>Promise<T>):Promise<T>{try{return await this.db.transaction(fn)}catch(e){if(e instanceof VaultError)throw e;throw new VaultError('scope_unavailable')}}
 async get(ownerId:string,alias:string):Promise<SavedBotScope|undefined>{
  validateContext({ownerId,alias,purpose:'bot_token'});
  return this.transaction(async sql=>{const row=(await sql.query('SELECT alias,bot_id,vault_revision,revision,policy FROM public.telegram_bot_scope WHERE owner_id=$1 AND alias=$2',[ownerId,alias])).rows[0];return row?decode(row):undefined});
 }
 /** Caller must verify Bot identity. Saving permissions always revokes activation
  * in the same transaction, even if the requested policy is unchanged. */
 async save(ownerId:string,value:Omit<SavedBotScope,'revision'>,expectedRevision:number,expectedDirectoryRevision?:number):Promise<SavedBotScope>{
  value=structuredClone(value);validateContext({ownerId,alias:value.alias,purpose:'bot_token'});
  let input:SavedBotScope;try{input=decode({...value,bot_id:value.botId,vault_revision:value.vaultRevision,revision:1})}catch{throw new VaultError('invalid_scope')}
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER)throw new VaultError('revision_conflict');
  if(expectedDirectoryRevision!==undefined&&(!Number.isSafeInteger(expectedDirectoryRevision)||expectedDirectoryRevision<0||expectedDirectoryRevision>=Number.MAX_SAFE_INTEGER))throw new VaultError('revision_conflict');
  return this.transaction(async sql=>{
   // Serialize with activation and credential replacement using the same row.
   const vault=(await sql.query("SELECT revision FROM public.telegram_credential_vault WHERE owner_id=$1 AND alias=$2 AND purpose='bot_token' FOR UPDATE",[ownerId,input.alias])).rows[0];
   if(Number(vault?.revision)!==input.vaultRevision)throw new VaultError('revision_conflict');
   const directory=(await sql.query('SELECT bot_id,revision FROM public.telegram_bot_directory WHERE owner_id=$1 AND alias=$2 FOR UPDATE',[ownerId,input.alias])).rows[0];
   if(expectedDirectoryRevision!==undefined&&Number(directory?.revision??0)!==expectedDirectoryRevision)throw new VaultError('revision_conflict');
   if(directory&&(Number(directory.bot_id)!==input.botId||Number(directory.revision)>=Number.MAX_SAFE_INTEGER))throw new VaultError('revision_conflict');
   const args=[ownerId,input.alias,input.botId,input.vaultRevision,JSON.stringify(input.policy)];
   const result=expectedRevision===0
    ?await sql.query("INSERT INTO public.telegram_bot_scope(owner_id,alias,purpose,bot_id,vault_revision,revision,policy) VALUES($1,$2,'bot_token',$3,$4,1,$5::jsonb) ON CONFLICT(owner_id,alias) DO NOTHING RETURNING alias,bot_id,vault_revision,revision,policy",args)
    :await sql.query('UPDATE public.telegram_bot_scope SET vault_revision=$4,revision=revision+1,policy=$5::jsonb WHERE owner_id=$1 AND alias=$2 AND bot_id=$3 AND revision=$6 RETURNING alias,bot_id,vault_revision,revision,policy',[...args,expectedRevision]);
   if(result.rows.length!==1)throw new VaultError('revision_conflict');
   await sql.query('UPDATE public.telegram_bot_directory SET active=false,revision=revision+1 WHERE owner_id=$1 AND alias=$2',[ownerId,input.alias]);
   return decode(result.rows[0]);
  });
 }
}
