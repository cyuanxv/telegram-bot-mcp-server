import {z} from 'zod';
import type {TransactionalSql} from './delivery/postgres-store';
const schema=z.object({id:z.string().uuid(),owner:z.string().min(1),bot:z.literal('default'),chat:z.string().min(1),chatId:z.string().regex(/^-?[0-9]+$/),mode:z.enum(['group','private']),revision:z.number().int().positive(),state:z.enum(['ready','pending','unknown','final','stopped']),sequence:z.number().int().nonnegative(),updatedAt:z.number().int(),expiresAt:z.number().int(),draftId:z.number().int().positive(),messageId:z.number().int().positive().optional(),digest:z.string().optional(),operation:z.enum(['preview','finalize']).optional(),acknowledged:z.boolean().optional(),retryAfter:z.number().int().optional()}).strict();
export type RichSession=z.infer<typeof schema>;
/** Metadata only. Durable compare-and-swap serializes dispatch across processes. */
export class RichSessions{
 private db:TransactionalSql;private now:()=>number;
 constructor(db:TransactionalSql,now=Date.now){this.db=db;this.now=now}
 async get(owner:string,id:string){return this.db.transaction(async sql=>{const r=await sql.query('SELECT document FROM public.telegram_rich_sessions WHERE owner_id=$1 AND id=$2',[owner,id]);return r.rows[0]?schema.parse(r.rows[0].document):undefined})}
 async create(input:Pick<RichSession,'id'|'owner'|'bot'|'chat'|'chatId'|'mode'|'draftId'>){
  const v=schema.parse({...input,revision:1,sequence:0,state:'ready',updatedAt:this.now(),expiresAt:this.now()+86400000});
  return this.db.transaction(async sql=>{
   await sql.query('LOCK TABLE public.telegram_rich_sessions IN SHARE ROW EXCLUSIVE MODE');
   const prior=await sql.query('SELECT document FROM public.telegram_rich_sessions WHERE owner_id=$1 AND id=$2',[v.owner,v.id]);
   if(prior.rows[0]){const old=schema.parse(prior.rows[0].document);for(const k of ['bot','chat','chatId','mode'] as const)if(old[k]!==v[k])throw Error('Session identity conflict');return old}
   const collision=await sql.query("SELECT id FROM public.telegram_rich_sessions WHERE document->>'bot'=$1 AND document->>'chatId'=$2 AND document->>'draftId'=$3 LIMIT 1",[v.bot,v.chatId,String(v.draftId)]);if(collision.rows.length)throw Error('Draft identity collision');
   const n=Number((await sql.query('SELECT count(*) AS n FROM public.telegram_rich_sessions')).rows[0]?.n);if(n>=10000)throw Error('Session capacity reached');
   await sql.query('INSERT INTO public.telegram_rich_sessions(owner_id,id,document) VALUES($1,$2,$3::jsonb)',[v.owner,v.id,JSON.stringify(v)]);return v;
  });
 }
 async change(owner:string,id:string,revision:number|undefined,fn:(v:RichSession)=>void){
  return this.db.transaction(async sql=>{
   const r=await sql.query('SELECT document FROM public.telegram_rich_sessions WHERE owner_id=$1 AND id=$2 FOR UPDATE',[owner,id]);if(!r.rows[0])throw Error('Unknown session');
   const v=schema.parse(r.rows[0].document);if(revision!==undefined&&v.revision!==revision)throw Error('Session revision changed; read status');
   fn(v);v.revision++;v.updatedAt=this.now();schema.parse(v);
   await sql.query('UPDATE public.telegram_rich_sessions SET document=$3::jsonb WHERE owner_id=$1 AND id=$2',[owner,id,JSON.stringify(v)]);return v;
  });
 }
 claim(owner:string,id:string,revision:number,sequence:number,digest:string,operation:'preview'|'finalize'){
  return this.change(owner,id,revision,v=>{if(v.state!=='ready'||this.now()>=v.expiresAt||sequence!==v.sequence+1)throw Error('Session cannot dispatch');if(this.now()<Math.max(v.retryAfter??0,v.sequence?v.updatedAt+(v.mode==='group'?3000:1000):0))throw Error('Session throttled; coalesce latest snapshot');v.state='pending';v.sequence=sequence;v.digest=digest;v.operation=operation});
 }
 settle(claim:RichSession,ok:boolean,messageId?:number,retryAfter?:number){return this.change(claim.owner,claim.id,undefined,v=>{
  if(v.sequence!==claim.sequence||v.digest!==claim.digest||!['pending','stopped'].includes(v.state))throw Error('Session settlement conflict');
  if(messageId!==undefined)v.messageId=messageId;
  if(v.state!=='stopped')v.state=ok?(claim.operation==='finalize'?'final':'ready'):'unknown';if(retryAfter)v.retryAfter=retryAfter;
 })}
 stop(owner:string,id:string,revision?:number){return this.change(owner,id,revision,v=>{if(v.state==='final')throw Error('Already finalized');v.state='stopped'})}
 recover(owner:string,id:string,revision:number){return this.change(owner,id,revision,v=>{if(v.state!=='pending'||this.now()-v.updatedAt<60000)throw Error('Operation still in flight');v.state='unknown'})}
}
