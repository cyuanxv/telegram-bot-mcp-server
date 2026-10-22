import {createHash,timingSafeEqual} from 'node:crypto';
import {Pool} from 'pg';
import {z} from 'zod';
import {readBotApiJson,callBotApi} from './bot-api';
import {getChats} from './config';
import {DraftSessions,type DraftSession} from './draft-sessions';
import {DraftWorkflow} from './draft-workflow';
import {sendMessageDraft,messageDraftSchema} from './message-draft';
import {PgPoolDatabase} from './delivery/pg-pool-adapter';
import {postgresConnectionConfig} from './delivery/postgres-config';
import {PostgresQueueStore} from './delivery/postgres-store';
import {AsyncReportQueue} from './delivery/async-queue';
type Env=Record<string,string|undefined>;
type Resource={sessions:DraftSessions;reports:AsyncReportQueue;close:()=>Promise<void>};
type Options={env?:()=>Env;open?:(env:Env,guard:()=>void)=>Promise<Resource>;call?:typeof callBotApi};
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const base=z.object({id:z.string().uuid()}).strict();
const mutate=base.extend({revision:positive.max(Number.MAX_SAFE_INTEGER-1),confirm:z.literal(true)});
const input=z.discriminatedUnion('action',[
 base.extend({action:z.literal('create'),bot_alias:messageDraftSchema.shape.bot_alias,chat:messageDraftSchema.shape.chat,draft_id:positive,message_thread_id:positive.optional(),confirm:z.literal(true)}),
 base.extend({action:z.literal('status')}),
 mutate.extend({action:z.literal('preview'),sequence:positive,text:messageDraftSchema.shape.text}),
 mutate.extend({action:z.literal('finalize'),text:z.string().max(131072)}),
 mutate.extend({action:z.literal('stop')}),mutate.extend({action:z.literal('recover')}),
]);
const targetsSchema=z.array(z.object({bot_alias:messageDraftSchema.shape.bot_alias,chat:messageDraftSchema.shape.chat}).strict()).min(1).max(100);
const json=(status:number,value:unknown)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
async function openProduction(env:Env,guard:()=>void):Promise<Resource>{
 guard();const pool=new Pool(postgresConnectionConfig(env));const db=new PgPoolDatabase(pool,{guard});
 return {sessions:new DraftSessions(db),reports:new AsyncReportQueue(new PostgresQueueStore(db)),close:()=>pool.end()};
}
function publicSession(s:DraftSession){return {id:s.id,revision:s.revision,sequence:s.sequence,state:s.state,bot_alias:s.botAlias,chat_id:s.chatId,draft_id:s.draftId,...(s.threadId===undefined?{}:{message_thread_id:s.threadId}),...(s.reportId?{report_id:s.reportId}:{}),retry_automatically:false}}
/** Server-authenticated, fixed-owner workflow. Disabled until storage and targets are approved.
 * No final dispatch, autonomous generation, browser token input or automatic retries. */
export async function handleDraftWorkflow(request:Request,options:Options={}){
 const env=options.env??(()=>process.env),snapshot={...env()};
 if(snapshot.TELEGRAM_DRAFT_WORKFLOW_ENABLED!=='true')return json(503,{status:'draft_workflow_disabled'});
 if(request.method!=='POST')return json(405,{status:'method_not_allowed'});
 const auth=snapshot.TELEGRAM_DRAFT_WORKFLOW_AUTH,supplied=request.headers.get('authorization');
 if(!auth||auth.length<32||auth.length>256)return json(503,{status:'draft_auth_unavailable'});
 if(!supplied||supplied.length>4096||!timingSafeEqual(createHash('sha256').update(supplied).digest(),createHash('sha256').update(`Bearer ${auth}`).digest()))return json(401,{status:'unauthorized'});
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return json(415,{status:'json_required'});
 const signal=AbortSignal.any([request.signal,AbortSignal.timeout(25000)]);
 let value:z.infer<typeof input>;
 try{value=input.parse(await readBotApiJson(new Response(request.body),signal,524288))}catch{return json(400,{status:'invalid_request'})}
 let resource:Resource|undefined,attempted=false;
 try{
  const ownerId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/).parse(snapshot.TELEGRAM_VAULT_OWNER_ID);
  const guard=()=>{const current=env();if(signal.aborted||Object.keys({...snapshot,...current}).filter(k=>k.startsWith('TELEGRAM_')).some(k=>snapshot[k]!==current[k]))throw Error('configuration changed')};
  guard();
  // Capture approved aliases and their IDs for this request; a later remap
  // cannot silently move a previously created session to a different chat.
  const raw=snapshot.TELEGRAM_DRAFT_PREVIEW_TARGETS_JSON;if(!raw||raw.length>16384)throw Error();
  const targets=targetsSchema.parse(JSON.parse(raw)),chats=getChats(snapshot);
  const target=(s:Pick<DraftSession,'ownerId'|'botAlias'|'chatId'>)=>{
   guard();if(s.ownerId!==ownerId)throw Error();
   const approved=targets.find(t=>t.bot_alias===s.botAlias&&Object.hasOwn(chats,t.chat)&&chats[t.chat]===s.chatId);
   if(!approved)throw Error('target denied');return approved;
  };
  resource=await(options.open??openProduction)(snapshot,guard);guard();
  const {sessions,reports}=resource;
  const flow=new DraftWorkflow({ownerId,sessions,reports,guard:s=>{target(s)},preview:async(s,text,o)=>{
   o.guard();const approved=target(s);
   const ack=await sendMessageDraft({bot_alias:s.botAlias,chat:approved.chat,draft_id:s.draftId,text,...(s.threadId===undefined?{}:{message_thread_id:s.threadId}),confirm:true},{env,signal:o.signal,call:options.call,beforeSend:o.beforeSend,stopButton:snapshot.TELEGRAM_DRAFT_STOP_EVENTS_ENABLED==='true',guard:()=>{guard();o.guard()}});
   return {acknowledged:ack.status==='preview_acknowledged'};
  }});
  let result:unknown;
  if(value.action==='create'){
   if(!targets.some(t=>t.bot_alias===value.bot_alias&&t.chat===value.chat)||!Object.hasOwn(chats,value.chat))throw Error();
   const identity={ownerId,id:value.id,botAlias:value.bot_alias,chatId:chats[value.chat],draftId:value.draft_id,...(value.message_thread_id===undefined?{}:{threadId:value.message_thread_id})};
   target(identity);attempted=true;result=publicSession(await sessions.create(identity));
  }else{
   const existing=await sessions.get(ownerId,value.id);if(!existing||existing.id!==value.id)throw Error();target(existing);
   if(value.action==='status')result=publicSession(existing);
   else{
    if(existing.revision!==value.revision)throw Error();attempted=true;
    const {action,...args}=value;
    if(action==='preview')result=await flow.preview(args,signal);
    else if(action==='finalize')result=await flow.prepareFinal(args);
    else if(action==='stop')result=publicSession(await sessions.stop(ownerId,value.id,value.revision));
    else result=publicSession(await sessions.recoverPreview(ownerId,value.id,value.revision));
   }
  }
  guard();return json(200,result);
 }catch{return json(503,{status:attempted?'draft_operation_unconfirmed':'draft_workflow_unavailable',retry_automatically:false})}
 finally{try{await resource?.close()}catch{}}
}
