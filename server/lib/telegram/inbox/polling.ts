import type {TransactionalSql} from '../delivery/postgres-store';
import type {BotInboxPolicy} from './types';
import {PostgresInboxStore} from './postgres-inbox';
import {decimalId,normalizedUpdate} from './normalize';
type PollingProvider={webhook:()=>Promise<{url:string}>;getUpdates:(input:{offset:number;limit:number;timeout:number;allowed_updates:string[]})=>Promise<unknown>};
/** One bounded candidate batch. The caller owns authentication, credentials,
 * deadline, policy/identity guards and cloud scheduling. Never deletes webhooks.
 * Lock, inbox records and cursor commit share a single database transaction.
 * A failed/uncertain commit is recovered by reopening the stored cursor, not
 * by acknowledging a locally computed offset. Only one batch per invocation.
 */
export async function pollInboxBatch(input:{database:TransactionalSql;ownerId:string;botAlias:string;botId:string;policy:BotInboxPolicy;provider:PollingProvider;guard:()=>void;now:()=>number}){
 const {database,ownerId,botAlias,botId,provider,guard,now}=input;
 if(!/^[1-9][0-9]{0,15}$/.test(botId)||!ownerId||ownerId.length>128||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(botAlias))throw Error('invalid_polling_identity');
 const policy=structuredClone(input.policy);
 // Lifecycle/deletion and draft-stop consumers need their own transactional
 // routing before they can be enabled in this alternative receiver.
 if(policy.allowedBusinessConnectionIds?.length||policy.acceptDraftStops)throw Error('unsupported_polling_policy');
 const allowed=['message','edited_message','channel_post','edited_channel_post',...(policy.acceptCallbacks?['callback_query']:[])];
 guard();
 return database.transaction(async sql=>{
  // Transaction-scoped advisory lock serializes one owner/Bot across replicas.
  const lock=(await sql.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[JSON.stringify(['telegram-polling',ownerId,botAlias])])).rows[0];
  if(lock?.acquired!==true)return {status:'busy' as const};
  guard();
  const webhook=await provider.webhook();guard();
  if(typeof webhook?.url!=='string')throw Error('invalid_webhook_state');
  if(webhook.url!=='')return {status:'webhook_active' as const};
  await sql.query('INSERT INTO public.telegram_polling_cursors(owner_id,bot_alias,bot_id) VALUES($1,$2,$3) ON CONFLICT (owner_id,bot_alias) DO NOTHING',[ownerId,botAlias,botId]);
  const row=(await sql.query('SELECT bot_id,next_offset::text FROM public.telegram_polling_cursors WHERE owner_id=$1 AND bot_alias=$2 FOR UPDATE',[ownerId,botAlias])).rows[0];
  if(row?.bot_id!==botId)throw Error('polling_bot_identity_changed');
  const offset=Number(row?.next_offset);
  if(!Number.isSafeInteger(offset)||offset<0||offset>2147483648)throw Error('invalid_polling_cursor');
  guard();const updates=await provider.getUpdates({offset,limit:100,timeout:20,allowed_updates:allowed});guard();
  if(!Array.isArray(updates)||updates.length>100)throw Error('invalid_polling_batch');
  const inbox=new PostgresInboxStore({transaction:operation=>operation(sql)});
  let next=offset,stored=0,duplicates=0,ignored=0,previous=-1;
  for(const raw of updates){
   guard();
   if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('invalid_polling_update');
   const id=Number(decimalId(raw.update_id,'nonnegative'));
   if(!Number.isSafeInteger(id)||id>2147483647||id<offset||id<=previous)throw Error('invalid_polling_order');
   previous=id;
   // Telegram may return previously queued types despite allowed_updates.
   // Never silently acknowledge a type without an approved processor.
   const kinds=Object.keys(raw).filter(key=>key!=='update_id');
   if(kinds.length!==1||!allowed.includes(kinds[0]))throw Error('unsupported_polling_update');
   const event=normalizedUpdate(raw,botAlias,policy,now());
   if(event){const result=await inbox.record(event);if(result==='conflict')throw Error('polling_fingerprint_conflict');if(result==='stored')stored++;else duplicates++;}
   else ignored++;
   next=id+1;
  }
  guard();
  await sql.query('UPDATE public.telegram_polling_cursors SET next_offset=$3 WHERE owner_id=$1 AND bot_alias=$2',[ownerId,botAlias,next]);
  guard();return {status:'processed' as const,received:updates.length,stored,duplicates,ignored,next_offset:String(next)};
 });
}
