import {inboxConfig} from './inbox/config';
import {resolveRichMedia} from './rich-assets';
import {createHash,createHmac,randomInt} from 'node:crypto';
import {Pool} from 'pg';
import {z} from 'zod';
import {PgPoolDatabase} from './delivery/pg-pool-adapter';
import {postgresConnectionConfig} from './delivery/postgres-config';
import {RichSessions,type RichSession} from './rich-session-store';
import {checkRich,type CompiledRich} from './rich-compiler.mjs';
import {writeRich,richDocumentSchema} from './rich-message';
import {BotApiError,callRichBotApi,callBotApi} from './bot-api';
import {getChats} from './config';
import {assertMediaUploadScope} from './media-bytes';
type Env=Record<string,string|undefined>;
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1);
const base=z.object({id:z.string().uuid()}).strict();
const mutation=base.extend({revision:positive});
export const richStreamSchema=z.discriminatedUnion('action',[
 base.extend({action:z.literal('create'),bot_alias:z.literal('default'),chat:z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),mode:z.enum(['group','private'])}),
 base.extend({action:z.literal('status')}),
 mutation.extend({action:z.literal('preview'),sequence:positive,...richDocumentSchema.shape}),
 mutation.extend({action:z.literal('finalize'),sequence:positive,...richDocumentSchema.shape}),
 mutation.extend({action:z.literal('stop')}),mutation.extend({action:z.literal('recover')})
]);
export async function openRichSessions(env:Env=process.env){const pool=new Pool(postgresConnectionConfig(env));pool.on('error',()=>{});return {sessions:new RichSessions(new PgPoolDatabase(pool)),close:()=>pool.end()}}
export function richSessionGuard(s:Pick<RichSession,'bot'|'chat'|'chatId'|'mode'|'owner'>,env:Env=process.env){
 if(env.TELEGRAM_RICH_STREAM_ENABLED!=='true'||env.TELEGRAM_RICH_MESSAGES_ENABLED!=='true'||env.TELEGRAM_WORKFLOW_MCP_ENABLED!=='true'||s.owner!==env.TELEGRAM_VAULT_OWNER_ID)throw Error('Rich stream disabled');
 const chats=getChats(env);if(chats[s.chat]!==s.chatId)throw Error('Rich destination changed');
 const targets=z.array(z.object({bot_alias:z.literal('default'),chat:z.string(),mode:z.enum(['group','private'])}).strict()).max(10).parse(JSON.parse(env.TELEGRAM_RICH_STREAM_TARGETS_JSON??'[]'));
 if(!targets.some(t=>t.bot_alias===s.bot&&t.chat===s.chat&&t.mode===s.mode)||(s.mode==='private')!== (Number(s.chatId)>0))throw Error('Rich destination not approved');
 assertMediaUploadScope(s.bot,s.chatId,env);
}
export function actionToken(s:RichSession,action:'ack'|'stop',env:Env=process.env){const key=env.MCP_API_KEY;if(!key||key.length<32)throw Error('Rich callback signing unavailable');const prefix=`r2:${s.id.replaceAll('-','')}:${action==='ack'?'a':'s'}`;return `${prefix}:${createHmac('sha256',key).update(JSON.stringify([prefix,s.bot,s.chatId,s.expiresAt])).digest('base64url').slice(0,16)}`}
export function prepareSessionDocument(compiled:CompiledRich,s:RichSession,env:Env){
 resolveRichMedia(compiled,env);
 if(compiled.rich_message.html.includes('rich-action:')){
  const users=z.array(z.string().regex(/^[1-9][0-9]{0,15}$/)).min(1).max(10).parse(JSON.parse(env.TELEGRAM_RICH_CALLBACK_USERS_JSON??'[]'));
  const policy=inboxConfig(env)?.bots[s.bot];
  if(!users.length||env.TELEGRAM_RICH_CALLBACKS_ENABLED!=='true'||env.TELEGRAM_CALLBACK_ANSWER_ENABLED!=='true'||!policy?.acceptCallbacks||!policy.allowedChatIds.includes(s.chatId))throw Error('Rich callbacks disabled');
  for(const action of ['ack','stop'] as const)compiled.rich_message.html=compiled.rich_message.html.replaceAll(`data="rich-action:${action}"`,`data="${actionToken(s,action,env)}"`);
 }
}
function previewDocument(blocks:unknown[],mode:string){
 // Drafts have no fresh media uploads and no active callbacks. Only complete blocks enter compiler.
 return blocks.map(raw=>{const b=raw as Record<string,unknown>;if(['photo','video','audio','voice'].includes(String(b.type)))return {type:'paragraph',text:`[${b.type}：完成后显示]`};
  if(b.type==='buttons'){const stop=(b.buttons as {action?:string}[]).filter(x=>x.action==='stop');return mode==='group'&&stop.length?{type:'buttons',buttons:stop}:{type:'paragraph',text:'[操作按钮：完成后启用]'}};
  const visit=(v:unknown):unknown=>Array.isArray(v)?v.map(visit):v&&typeof v==='object'?(Object.hasOwn(v,'button')?(mode==='group'&&((v as Record<string,unknown>).button as Record<string,unknown>).action==='stop'?v:{text:`[${String(((v as Record<string,unknown>).button as Record<string,unknown>).text)}]`}):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,visit(x)]))):v;
  return visit(b);
 });
}
export async function runRichStream(raw:unknown,options:{signal?:AbortSignal;env?:()=>Env;open?:typeof openRichSessions;call?:typeof callRichBotApi;write?:typeof writeRich}={}){
 const input=richStreamSchema.parse(structuredClone(raw)),env=options.env??(()=>process.env),owner=env().TELEGRAM_VAULT_OWNER_ID;
 if(!owner||env().TELEGRAM_RICH_STREAM_ENABLED!=='true')throw Error('Rich stream disabled');
 const guard=(s:RichSession)=>{if(options.signal?.aborted)throw Error('Cancelled');richSessionGuard(s,env())};
 const resource=await(options.open??openRichSessions)(env());
 try{
  const {sessions}=resource;
  if(input.action==='create'){
   const chatId=getChats(env())[input.chat];const identity={id:input.id,owner,bot:input.bot_alias,chat:input.chat,chatId,mode:input.mode,draftId:randomInt(1,2147483647)};
   richSessionGuard(identity,env());
   if(input.mode==='private'){const r=await callBotApi('default','getChat',{chat_id:chatId},{},{signal:options.signal});if(String((r.result as {id?:unknown}).id)!==chatId||(r.result as {type?:unknown}).type!=='private')throw Error('Private chat verification failed')}
   return await sessions.create(identity);
  }
  let s=await sessions.get(owner,input.id);if(!s)throw Error('Unknown session');
  if(input.action==='status')return {...s,retry_automatically:false};
  guard(s);
  if(input.action==='stop')return await sessions.stop(owner,s.id,input.revision);
  if(input.action==='recover')return await sessions.recover(owner,s.id,input.revision);
  // Validate entire final snapshot before claiming, even if media is omitted in previews.
  const full=await checkRich({blocks:input.blocks,...(input.files?{files:input.files}:{})});prepareSessionDocument(full,s,env());
  const doc=input.action==='preview'?{blocks:previewDocument(input.blocks,s.mode)}:{blocks:input.blocks,...(input.files?{files:input.files}:{})};
  const compiled=input.action==='preview'?await checkRich(doc):full;
  const digest=createHash('sha256').update(JSON.stringify([compiled.rich_message,compiled.files.map(f=>f.sha256)])).digest('hex');
  if(s.revision===input.revision&&s.state==='ready'&&s.digest===digest&&input.action==='preview')return {...s,completed:true,unchanged:true,retry_automatically:false};
  const claim=await sessions.claim(owner,s.id,input.revision,input.sequence,digest,input.action);s=claim;
  const beforeSend=async()=>{guard(claim);const current=await sessions.get(owner,claim.id);if(current?.state!=='pending'||current.revision!==claim.revision)throw Error('Rich generation stopped or changed')};
  let ok=false,messageId=s.messageId,apiError:unknown;
  try{
   await beforeSend();
   if(s.mode==='private'&&input.action==='preview'){
    const r=await(options.call??callRichBotApi)(s.bot,'sendRichMessageDraft',{chat_id:Number(s.chatId),draft_id:s.draftId,rich_message:compiled.rich_message,can_stop:env().TELEGRAM_RICH_STOP_EVENTS_ENABLED==='true',keep_on_stop:false},[],{signal:options.signal,guard:()=>guard(claim),beforeSend});ok=r.bot===s.bot&&r.result===true;
   }else{
    const operation=s.messageId?'edit':'send';
    const result=await(options.write??writeRich)(operation,{...doc,bot_alias:s.bot,chat:s.chat,idempotency_key:`rich-session:${s.id}:${s.sequence}`,...(s.messageId?{message_id:s.messageId}:{})},{env,signal:options.signal,beforeSend,prepare:c=>prepareSessionDocument(c,claim,env())});
    ok=result.completed===true;if('message_id'in result&&typeof result.message_id==='number')messageId=result.message_id;if('api_error'in result)apiError=result.api_error;
   }
  }catch(error){if(error instanceof BotApiError)apiError=error.details;/* Never replay uncertain operations. */}
  const result=await sessions.settle(claim,ok,messageId);
  return {...result,completed:ok,retry_automatically:false,...(apiError?{api_error:apiError}:{})};
 }finally{await resource.close()}
}
