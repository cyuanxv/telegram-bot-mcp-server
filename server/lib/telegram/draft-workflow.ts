import {createHash} from 'node:crypto';
import {z} from 'zod';
import {DraftSessions,type DraftSession} from './draft-sessions';
import {messageDraftSchema} from './message-draft';
import {reportFingerprint} from './delivery/state';
import {planReport} from './report-plan';
import {checkJob} from './delivery/store';
import type {AsyncReportQueue} from './delivery/async-queue';
import type {ReportJob} from './delivery/types';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const input=z.object({id:z.string().uuid(),revision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),text:z.string().max(131072),confirm:z.literal(true)}).strict();
type Dependencies={
 ownerId:string;sessions:DraftSessions;reports:Pick<AsyncReportQueue,'draft'|'get'>;
 // Adapter must enforce target authorization, environment binding and cancellation.
 preview:(session:DraftSession,text:string,options:{signal:AbortSignal;guard:()=>void;beforeSend:()=>Promise<void>})=>Promise<{acknowledged:boolean}>;
 guard:(session:DraftSession)=>void;
};
/** No automatic scheduler or final dispatch. Internal adapters, not client callbacks. */
export class DraftWorkflow{
 private deps:Dependencies;
 constructor(deps:Dependencies){z.string().min(1).max(128).parse(deps.ownerId);this.deps=deps}
 private async load(id:string,revision:number){
  const s=await this.deps.sessions.get(this.deps.ownerId,id);
  if(!s||s.revision!==revision)throw Error('Draft workflow state changed');
  this.deps.guard(s);return s;
 }
 async preview(supplied:unknown,externalSignal?:AbortSignal){
  const v=input.extend({sequence:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).parse(supplied);
  // Reuse byte/Unicode validation; the trusted adapter supplies actual aliases.
  messageDraftSchema.shape.text.parse(v.text);
  const signal=AbortSignal.any([AbortSignal.timeout(30000),...(externalSignal?[externalSignal]:[])]);
  await this.load(v.id,v.revision);if(signal.aborted)throw Error('Draft workflow cancelled');
  const claim=await this.deps.sessions.claimPreview(this.deps.ownerId,v.id,v.revision,v.sequence,hash(v.text));
  const guard=()=>{if(signal.aborted)throw Error('Draft workflow cancelled');this.deps.guard(claim)};
  let acknowledged=false;
  try{
   guard();
   const current=await this.load(v.id,claim.revision);
   if(current.state!=='previewing'||current.claim!==claim.claim)throw Error();
   const beforeSend=async()=>{
    guard();const latest=await this.load(v.id,claim.revision);
    if(latest.state!=='previewing'||latest.claim!==claim.claim)throw Error('Draft workflow stopped');
    guard();
   };
   guard();const outcome=await this.deps.preview(structuredClone(claim),v.text,{signal,guard,beforeSend});guard();
   acknowledged=outcome?.acknowledged===true;
  }catch{/* Possible side effect: quarantine instead of retrying. */}
  const settled=await this.deps.sessions.settlePreview(this.deps.ownerId,v.id,claim.revision,claim.claim!,acknowledged);
  return {id:settled.id,revision:settled.revision,sequence:settled.sequence,state:settled.state,persisted_message:false,retry_automatically:false};
 }
 private verifyReport(job:ReportJob|undefined,session:DraftSession,text:string):ReportJob{
  if(!job)throw Error('Draft final report unavailable');checkJob(job);
  const fingerprint=reportFingerprint(job.botAlias,job.chatId,job.chunks.map(c=>c.text),job.threadId);
  if(job.fingerprint!==fingerprint||(session.reportId!==undefined&&job.id!==session.reportId))throw Error('Draft final report mismatch');
  if(job.botAlias!==session.botAlias||job.chatId!==session.chatId||job.threadId!==session.threadId||job.idempotencyKey!==session.reportKey||hash(job.chunks.map(c=>c.text).join(''))!==session.digest||hash(text)!==session.digest)throw Error('Draft final report mismatch');
  return job;
 }
 async prepareFinal(supplied:unknown){
  const v=input.parse(supplied);planReport(v.text);
  let session=await this.load(v.id,v.revision);
  const digest=hash(v.text);
  if(['ready','previewed'].includes(session.state))session=await this.deps.sessions.prepareFinal(this.deps.ownerId,v.id,v.revision,digest);
  else if(!['final_pending','final_linked'].includes(session.state)||session.digest!==digest)throw Error('Draft final content or state changed');
  this.deps.guard(session);
  const job=this.verifyReport(session.state==='final_linked'?await this.deps.reports.get(session.reportId!):await this.deps.reports.draft({botAlias:session.botAlias,chatId:session.chatId,text:v.text,idempotencyKey:session.reportKey!,...(session.threadId===undefined?{}:{threadId:session.threadId})}),session,v.text);
  this.deps.guard(session);
  if(session.state==='final_pending')session=await this.deps.sessions.linkReport(this.deps.ownerId,v.id,session.revision,session.reportKey!,job.id);
  return {id:session.id,revision:session.revision,state:session.state,report_id:job.id,report_fingerprint:job.fingerprint,report_state:job.state,dispatch_performed:false};
 }
}
