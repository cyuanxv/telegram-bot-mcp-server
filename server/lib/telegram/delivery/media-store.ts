import type {TransactionalSql} from './postgres-store';
export type MediaClaim={key:string;fingerprint:string;createdAt:number};
export type MediaState={state:'claimed'|'inflight'|'sent'|'unknown';messageId?:number};
export interface MediaLedger {get(key:string):Promise<MediaState|undefined>;claim(input:MediaClaim):Promise<MediaState>;settle(key:string,fingerprint:string,state:'sent'|'unknown',messageId?:number):Promise<void>}
const hash=(v:string)=>{if(!/^[a-f0-9]{64}$/.test(v))throw Error('Invalid media ledger hash')};
export class PostgresMediaLedger implements MediaLedger{
 private database:TransactionalSql;
 constructor(database:TransactionalSql){this.database=database}
 async get(key:string):Promise<MediaState|undefined>{
  hash(key);
  return this.database.transaction(async sql=>{
   const row=(await sql.query('SELECT state,message_id FROM public.telegram_media_deliveries WHERE request_key=$1',[key])).rows[0];
   if(!row)return undefined;
   if(!['inflight','sent','unknown'].includes(String(row.state)))throw Error('Invalid media ledger state');
   if(row.state==='sent'){const id=Number(row.message_id);if(!Number.isSafeInteger(id)||id<1)throw Error('Invalid media receipt');return {state:'sent',messageId:id}}
   return {state:row.state as 'inflight'|'unknown'};
  });
 }
 async claim(input:MediaClaim):Promise<MediaState>{
  input=structuredClone(input);hash(input.key);hash(input.fingerprint);if(!Number.isSafeInteger(input.createdAt)||input.createdAt<0)throw Error('Invalid media timestamp');
  return this.database.transaction(async sql=>{
   // Bounded tombstones are never automatically deleted: deletion would release an old send key.
   await sql.query('LOCK TABLE public.telegram_media_deliveries IN SHARE ROW EXCLUSIVE MODE');
   const row=(await sql.query('SELECT fingerprint,state,message_id FROM public.telegram_media_deliveries WHERE request_key=$1',[input.key])).rows[0];
   if(row){
    if(row.fingerprint!==input.fingerprint)throw Error('Media key already used for different content');
    if(!['inflight','sent','unknown'].includes(String(row.state)))throw Error('Invalid media ledger state');
    if(row.state==='sent'){const id=Number(row.message_id);if(!Number.isSafeInteger(id)||id<1)throw Error('Invalid media receipt');return {state:'sent',messageId:id}}
    return {state:row.state as 'inflight'|'unknown'};
   }
   const n=Number((await sql.query('SELECT COUNT(*) AS n FROM public.telegram_media_deliveries')).rows[0]?.n);
   if(!Number.isSafeInteger(n)||n>=10000)throw Error('Media ledger capacity reached');
   await sql.query("INSERT INTO public.telegram_media_deliveries(request_key,fingerprint,state,created_at) VALUES($1,$2,'inflight',$3)",[input.key,input.fingerprint,input.createdAt]);
   return {state:'claimed'};
  });
 }
 async settle(key:string,fingerprint:string,state:'sent'|'unknown',messageId?:number){
  hash(key);hash(fingerprint);if(!['sent','unknown'].includes(state)||(state==='sent'&&(!Number.isSafeInteger(messageId)||messageId!<1))||(state==='unknown'&&messageId!==undefined))throw Error('Invalid media settlement');
  await this.database.transaction(async sql=>{const result=await sql.query("UPDATE public.telegram_media_deliveries SET state=$3,message_id=$4 WHERE request_key=$1 AND fingerprint=$2 AND state='inflight' RETURNING request_key",[key,fingerprint,state,messageId??null]);if(result.rows.length!==1)throw Error('Media settlement unavailable')});
 }
}
