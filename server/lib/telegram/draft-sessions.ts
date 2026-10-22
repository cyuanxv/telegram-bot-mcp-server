import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {TransactionalSql,SqlExecutor} from './delivery/postgres-store';
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const alias=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const digest=z.string().regex(/^[0-9a-f]{64}$/);
const identity=z.object({ownerId:z.string().min(1).max(128),id:z.string().uuid(),botAlias:alias,chatId:z.string().regex(/^[1-9][0-9]{0,15}$/).refine(v=>Number.isSafeInteger(Number(v))),draftId:positive,threadId:positive.optional()}).strict();
const record=identity.extend({
 revision:positive,sequence:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 state:z.enum(['ready','previewing','previewed','unknown','final_pending','final_linked','stopped']),
 updatedAt:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 digest:digest.optional(),claim:z.string().uuid().optional(),reportKey:z.string().regex(/^stream-final:[0-9a-f]{64}$/).optional(),reportId:z.string().uuid().optional(),
}).strict().superRefine((v,c)=>{
 const bad=()=>c.addIssue({code:'custom',message:'Invalid session state'});
 if((v.state==='previewing')!==(v.claim!==undefined))bad();
 if(['previewing','previewed','unknown','final_pending','final_linked'].includes(v.state)&&v.digest===undefined)bad();
 if((v.state==='final_pending'||v.state==='final_linked')!==(v.reportKey!==undefined))bad();
 if((v.state==='final_linked')!==(v.reportId!==undefined))bad();
});
export type DraftSession=z.infer<typeof record>;
type Identity=z.infer<typeof identity>;
class SessionError extends Error{constructor(code:string){super('Draft session: '+code)}}
const conflict=()=>{throw new SessionError('state_changed')};
/** Server-internal storage. No Telegram calls, migration or final delivery. */
export class DraftSessions{
 private db:TransactionalSql;private now:()=>number;
 constructor(db:TransactionalSql,now:()=>number=Date.now){this.db=db;this.now=now}
 private time(){const t=this.now();if(!Number.isSafeInteger(t)||t<0)throw new SessionError('invalid_clock');return t}
 private async transaction<T>(fn:(sql:SqlExecutor)=>Promise<T>){try{return await this.db.transaction(fn)}catch(e){if(e instanceof SessionError)throw e;throw new SessionError('storage_unconfirmed')}}
 async create(value:Identity){
  const v=identity.parse(value),candidate:DraftSession={...v,revision:1,sequence:0,state:'ready',updatedAt:this.time()};
  return this.transaction(async sql=>{
   // Bounded metadata storage. No lock survives into a network request.
   await sql.query('LOCK TABLE public.telegram_draft_sessions IN SHARE ROW EXCLUSIVE MODE');
   const prior=(await sql.query('SELECT document FROM public.telegram_draft_sessions WHERE owner_id=$1 AND id=$2',[v.ownerId,v.id])).rows[0];
   if(prior){const existing=record.parse(prior.document);for(const k of Object.keys(v) as (keyof Identity)[])if(existing[k]!==v[k])conflict();if(existing.threadId!==v.threadId)conflict();return existing}
   // One Telegram preview identity must not be controlled by two sessions,
   // including across owners. Keep the identity reserved after stopping.
   const collision=await sql.query("SELECT id FROM public.telegram_draft_sessions WHERE document->>'botAlias'=$1 AND document->>'chatId'=$2 AND document->>'draftId'=$3 LIMIT 1",[v.botAlias,v.chatId,String(v.draftId)]);
   if(collision.rows.length)conflict();
   const n=Number((await sql.query('SELECT count(*) AS n FROM public.telegram_draft_sessions')).rows[0]?.n);
   if(!Number.isSafeInteger(n)||n>=10000)throw new SessionError('capacity_reached');
   await sql.query('INSERT INTO public.telegram_draft_sessions(owner_id,id,document) VALUES($1,$2,$3::jsonb)',[v.ownerId,v.id,JSON.stringify(candidate)]);return candidate;
  });
 }
 /** Authenticated Telegram stop event; exact destination binding, duplicate-safe. */
 async stopFromTelegram(value:Omit<Identity,'id'>){
  const v=identity.omit({id:true}).parse(value);
  return this.transaction(async sql=>{
   const rows=(await sql.query("SELECT document FROM public.telegram_draft_sessions WHERE owner_id=$1 AND document->>'botAlias'=$2 AND document->>'chatId'=$3 AND document->>'draftId'=$4 FOR UPDATE",[v.ownerId,v.botAlias,v.chatId,String(v.draftId)])).rows;
   if(!rows.length)return 'not_found' as const;
   if(rows.length!==1)conflict();
   const current=record.parse(rows[0].document);
   if(current.ownerId!==v.ownerId||current.botAlias!==v.botAlias||current.chatId!==v.chatId||current.draftId!==v.draftId||current.threadId!==v.threadId)return 'not_found' as const;
   if(current.state==='stopped')return 'already_stopped' as const;
   if(['final_pending','final_linked'].includes(current.state))return 'finalization_started' as const;
   if(current.revision>=Number.MAX_SAFE_INTEGER)conflict();
   delete current.claim;current.state='stopped';current.revision++;current.updatedAt=this.time();record.parse(current);
   await sql.query('UPDATE public.telegram_draft_sessions SET document=$3::jsonb WHERE owner_id=$1 AND id=$2',[v.ownerId,current.id,JSON.stringify(current)]);
   return 'stopped' as const;
  });
 }
 async get(ownerId:string,id:string){
  z.string().min(1).max(128).parse(ownerId);z.string().uuid().parse(id);
  return this.transaction(async sql=>{const row=(await sql.query('SELECT document FROM public.telegram_draft_sessions WHERE owner_id=$1 AND id=$2',[ownerId,id])).rows[0];return row?record.parse(row.document):undefined});
 }
 private async change(ownerId:string,id:string,revision:number,fn:(v:DraftSession)=>void){
  z.string().min(1).max(128).parse(ownerId);z.string().uuid().parse(id);positive.max(Number.MAX_SAFE_INTEGER-1).parse(revision);
  return this.transaction(async sql=>{
   const row=(await sql.query('SELECT document FROM public.telegram_draft_sessions WHERE owner_id=$1 AND id=$2 FOR UPDATE',[ownerId,id])).rows[0];if(!row)conflict();
   const v=record.parse(row.document);if(v.ownerId!==ownerId||v.id!==id||v.revision!==revision)conflict();
   fn(v);v.revision++;v.updatedAt=this.time();record.parse(v);
   await sql.query('UPDATE public.telegram_draft_sessions SET document=$3::jsonb WHERE owner_id=$1 AND id=$2',[ownerId,id,JSON.stringify(v)]);return v;
  });
 }
 claimPreview(ownerId:string,id:string,revision:number,sequence:number,hash:string){
  positive.parse(sequence);digest.parse(hash);
  return this.change(ownerId,id,revision,v=>{if(!['ready','previewed'].includes(v.state)||sequence!==v.sequence+1)conflict();v.sequence=sequence;v.digest=hash;v.claim=randomUUID();v.state='previewing'});
 }
 settlePreview(ownerId:string,id:string,revision:number,claim:string,acknowledged:boolean){
  z.string().uuid().parse(claim);z.boolean().parse(acknowledged);
  return this.change(ownerId,id,revision,v=>{if(v.state!=='previewing'||v.claim!==claim)conflict();delete v.claim;v.state=acknowledged?'previewed':'unknown'});
 }
 /** Recovery never makes an interrupted external operation retryable. */
 recoverPreview(ownerId:string,id:string,revision:number){
  return this.change(ownerId,id,revision,v=>{if(v.state!=='previewing')conflict();if(this.time()<v.updatedAt+60000)throw new SessionError('still_in_flight');delete v.claim;v.state='unknown'});
 }
 stop(ownerId:string,id:string,revision:number){
  return this.change(ownerId,id,revision,v=>{if(!['ready','previewing','previewed','unknown'].includes(v.state))conflict();delete v.claim;v.state='stopped'});
 }
 prepareFinal(ownerId:string,id:string,revision:number,hash:string){
  digest.parse(hash);
  return this.change(ownerId,id,revision,v=>{
   if(!['ready','previewed'].includes(v.state))conflict();
   v.digest=hash;v.state='final_pending';
   v.reportKey='stream-final:'+createHash('sha256').update(JSON.stringify([v.ownerId,v.id,v.botAlias,v.chatId,v.threadId??null,hash])).digest('hex');
  });
 }
 /** Caller must verify the report's destination, digest and idempotency key. */
 linkReport(ownerId:string,id:string,revision:number,reportKey:string,reportId:string){
  z.string().uuid().parse(reportId);
  return this.change(ownerId,id,revision,v=>{if(v.state!=='final_pending'||v.reportKey!==reportKey)conflict();v.reportId=reportId;v.state='final_linked'});
 }
}
