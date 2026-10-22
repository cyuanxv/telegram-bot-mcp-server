import {resolveRichMedia} from './rich-assets';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {BotApiError,callRichBotApi} from './bot-api';
import {checkRich,richPreview} from './rich-compiler.mjs';
import {workflowRegistry} from './vault/workflow-registry';
import {matchingMessageId} from './message-receipt';
import {assertMediaUploadScope} from './media-bytes';
import {openProductionWorkflow,type WorkflowFactory} from './workflow-mcp';
export const richDocumentSchema=z.object({blocks:z.array(z.unknown()).min(1).max(100),files:z.array(z.unknown()).max(4).optional()}).strict();
export const richSendSchema=richDocumentSchema.extend({bot_alias:z.literal('default'),chat:z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),idempotency_key:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),disable_notification:z.boolean().optional(),message_thread_id:z.number().int().positive().optional()}).strict();
export const richEditSchema=richSendSchema.omit({disable_notification:true,message_thread_id:true}).extend({message_id:z.number().int().positive()}).strict();
export const richStatusSchema=z.object({bot_alias:z.literal('default'),operation:z.enum(['send','edit']),idempotency_key:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/)}).strict();
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
type Dependencies={env?:()=>Record<string,string|undefined>;registry?:()=>{bots:string[];chats:Record<string,string>};open?:WorkflowFactory;signal?:AbortSignal;call?:typeof callRichBotApi;beforeSend?:()=>Promise<void>;prepare?:(compiled:Awaited<ReturnType<typeof checkRich>>)=>void};
export async function previewRich(input:unknown){return richPreview(await checkRich(richDocumentSchema.parse(input)))}
export async function writeRich(operation:'send'|'edit',raw:unknown,deps:Dependencies={}){
 const input=(operation==='send'?richSendSchema:richEditSchema).parse(structuredClone(raw));
 const compiled=await checkRich({blocks:input.blocks,...(input.files?{files:input.files}:{})});
 resolveRichMedia(compiled,(deps.env??(()=>process.env))());
 if(deps.prepare)deps.prepare(compiled);else if(compiled.rich_message.html.includes('data="rich-action:'))throw Error('Action buttons require a rich session');
 const env=deps.env??(()=>process.env);const baseGuard=()=>{if(deps.signal?.aborted||env().TELEGRAM_RICH_MESSAGES_ENABLED!=='true'||env().TELEGRAM_WORKFLOW_MCP_ENABLED!=='true'||env().TELEGRAM_MEDIA_DEDUP_ENABLED!=='true')throw Error('Rich messages disabled')};baseGuard();
 const runtime=deps.registry?undefined:await workflowRegistry(env,deps.signal),registry=deps.registry??runtime!.read;let target:string|undefined;
 const guard=()=>{baseGuard();const r=registry();if(input.chat!=='demo-group'&&!deps.prepare)throw Error('Use rich session for private destinations');if(!r.bots.includes(input.bot_alias)||!Object.hasOwn(r.chats,input.chat))throw Error('Unconfigured rich destination');const chat=r.chats[input.chat];assertMediaUploadScope(input.bot_alias,chat,env());if(target!==undefined&&target!==chat)throw Error('Rich destination changed');target=chat};guard();
 const edit=operation==='edit'?richEditSchema.parse(input):undefined;
 const send=operation==='send'?richSendSchema.parse(input):undefined;
 const method=edit?'editMessageText':'sendRichMessage';
 const params={chat_id:target!,rich_message:compiled.rich_message,...(edit?{message_id:edit.message_id}:{disable_notification:send!.disable_notification??true,...(send!.message_thread_id?{message_thread_id:send!.message_thread_id}:{})})};
 const key=hash(JSON.stringify(['rich-v1',operation,input.bot_alias,input.idempotency_key]));
 const fingerprint=hash(JSON.stringify([input.bot_alias,params,compiled.files.map(({id,filename,content_type,sha256})=>({id,filename,content_type,sha256}))]));
 let resource:Awaited<ReturnType<WorkflowFactory>>|undefined;let claim;
 try{resource=await(deps.open??openProductionWorkflow)(guard);guard();if(!resource.mediaLedger)throw Error('No ledger');claim=await resource.mediaLedger.claim({key,fingerprint,createdAt:Date.now()})}
 catch{throw Error('Rich claim unavailable or key conflict; no request dispatched')}
 finally{try{await resource?.close()}catch{}}
 guard();const common={operation,...compiled.metrics,retry_automatically:false};
 if(claim.state==='sent')return {...common,completed:true,message_id:claim.messageId,reused:true,receipt_persisted:true};
 if(claim.state!=='claimed')return {...common,completed:null,status:'delivery_unconfirmed',reused:true};
 let nativeTypes:string[]=[];let messageId:number|undefined,apiError:BotApiError['details']|undefined;
 try{guard();const result=await(deps.call??callRichBotApi)(input.bot_alias,method,params,compiled.files,{signal:deps.signal,guard,beforeSend:deps.beforeSend});const id=matchingMessageId(result,input.bot_alias,target!,send?.message_thread_id);const msg=(result as {result?:{rich_message?:{blocks?:unknown[]}}}).result;if(id!==undefined&&(!edit||id===edit.message_id)&&Array.isArray(msg?.rich_message?.blocks)&&msg.rich_message.blocks.length>0){messageId=id;nativeTypes=msg.rich_message.blocks.map(b=>{const t=(b as {type?:unknown})?.type;return typeof t==='string'&&/^[a-z_]{1,40}$/.test(t)?t:'unknown'})}}
 catch(e){if(e instanceof BotApiError)apiError=e.details}
 let persisted=false,settleResource:Awaited<ReturnType<WorkflowFactory>>|undefined;
 try{settleResource=await(deps.open??openProductionWorkflow)(()=>{});if(!settleResource.mediaLedger)throw Error('No ledger');await settleResource.mediaLedger.settle(key,fingerprint,messageId===undefined?'unknown':'sent',messageId);persisted=true}catch{}finally{try{await settleResource?.close()}catch{}}
 return messageId===undefined?{...common,completed:null,status:'delivery_unconfirmed',receipt_persisted:persisted,...(apiError?{api_error:apiError}:{})}:{...common,completed:true,message_id:messageId,reused:false,receipt_persisted:persisted,rich_message_returned:true,native_block_types:nativeTypes};
}
export async function richStatus(raw:unknown,deps:Dependencies={}){
 const input=richStatusSchema.parse(raw);const env=deps.env??(()=>process.env);const guard=()=>{if(deps.signal?.aborted||env().TELEGRAM_WORKFLOW_MCP_ENABLED!=='true')throw Error('Status disabled')};guard();let r:Awaited<ReturnType<WorkflowFactory>>|undefined;
 try{r=await(deps.open??openProductionWorkflow)(guard);guard();if(!r.mediaLedger)throw Error('No ledger');const result=await r.mediaLedger.get(hash(JSON.stringify(['rich-v1',input.operation,input.bot_alias,input.idempotency_key])));return {found:!!result,status:result?.state??'not_found',...(result?.state==='sent'?{message_id:result.messageId}:{}),retry_automatically:false,note:'Stored receipt only; unknown/inflight may already have delivered. Do not resend with a new key.'}}
 catch{throw Error('Rich status unavailable')}finally{try{await r?.close()}catch{}}
}
