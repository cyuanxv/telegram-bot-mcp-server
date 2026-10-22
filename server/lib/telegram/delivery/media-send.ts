import {createHash} from 'node:crypto';
import {callBotApiBytes} from '../bot-api';
import {workflowRegistry} from '../vault/workflow-registry';
import {matchingMessageId} from '../message-receipt';
import {assertMediaUploadScope,buildMediaMultipart,type ByteAttachment} from '../media-bytes';
import {openProductionWorkflow,type WorkflowFactory} from '../workflow-mcp';
const methods={photo:['sendPhoto','photo'],document:['sendDocument','document'],video:['sendVideo','video'],audio:['sendAudio','audio'],animation:['sendAnimation','animation'],voice:['sendVoice','voice'],video_note:['sendVideoNote','video_note'],sticker:['sendSticker','sticker']} as const;
export type FileSendInput={bot_alias:string;chat:string;kind:keyof typeof methods;filename:string;content_type:string;base64:string;sha256:string;idempotency_key:string;caption?:string;parse_mode?:"HTML"|"MarkdownV2";message_thread_id?:number;disable_notification?:boolean};
type Dependencies={env?:()=>Record<string,string|undefined>;registry?:()=>{bots:string[];chats:Record<string,string>};open?:WorkflowFactory;signal?:AbortSignal;now?:()=>number;call?:(bot:string,method:string,params:Record<string,unknown>,files:ByteAttachment[])=>Promise<unknown>};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&v.isWellFormed();
export async function sendFileOnce(input:FileSendInput,deps:Dependencies={}){
 input=structuredClone(input);
 if(!input||Object.keys(input).some(k=>!['bot_alias','chat','kind','filename','content_type','base64','sha256','idempotency_key','parse_mode','caption','message_thread_id','disable_notification'].includes(k))||!text(input.bot_alias,64)||!text(input.chat,128)||!Object.hasOwn(methods,input.kind)||!text(input.filename,128)||!text(input.content_type,100)||typeof input.base64!=='string'||input.base64.length>Math.ceil(2*1024*1024/3)*4||!text(input.sha256,64)||!/^[a-f0-9]{64}$/.test(input.sha256)||!text(input.idempotency_key,128)||!/^[A-Za-z0-9._:-]+$/.test(input.idempotency_key)
 ||(input.caption!==undefined&&(typeof input.caption!=='string'||!input.caption.isWellFormed()||input.caption.length>1024||['sticker','video_note'].includes(input.kind)))
 ||(input.parse_mode!==undefined&&(!['HTML','MarkdownV2'].includes(input.parse_mode)||input.caption===undefined||['sticker','video_note'].includes(input.kind)))
 ||(input.message_thread_id!==undefined&&(!Number.isSafeInteger(input.message_thread_id)||input.message_thread_id<1))||(input.disable_notification!==undefined&&typeof input.disable_notification!=='boolean'))throw Error('Invalid file send arguments');
 const env=deps.env??(()=>process.env);
 if(deps.signal?.aborted||env().TELEGRAM_WORKFLOW_MCP_ENABLED!=='true'||env().TELEGRAM_MEDIA_DEDUP_ENABLED!=='true')throw Error('Persistent media sending disabled');
 const runtime=deps.registry?undefined:await workflowRegistry(env,deps.signal),registry=deps.registry??runtime!.read;let target:string|undefined;
 const guard=()=>{const e=env();if(deps.signal?.aborted||e.TELEGRAM_WORKFLOW_MCP_ENABLED!=='true'||e.TELEGRAM_MEDIA_DEDUP_ENABLED!=='true')throw Error('Persistent media sending disabled');const r=registry();if(!r.bots.includes(input.bot_alias)||!Object.hasOwn(r.chats,input.chat))throw Error('Unconfigured media destination');const chat=r.chats[input.chat];assertMediaUploadScope(input.bot_alias,chat,e);if(target!==undefined&&target!==chat)throw Error('Media destination changed');target=chat};
 guard();const [method,field]=methods[input.kind];
 const params={...(input.parse_mode?{parse_mode:input.parse_mode}:{}),chat_id:target!,[field]:'attach://file',disable_notification:input.disable_notification??true,...(input.caption===undefined?{}:{caption:input.caption}),...(input.message_thread_id===undefined?{}:{message_thread_id:input.message_thread_id})};
 const files=[{field_name:'file',filename:input.filename,content_type:input.content_type,base64:input.base64}];
 const multipart=buildMediaMultipart(method,params,files);if(multipart.totalBytes>2*1024*1024||createHash('sha256').update(Buffer.from(input.base64,'base64')).digest('hex')!==input.sha256)throw Error('File integrity mismatch');
 const key=hash(JSON.stringify([input.bot_alias,input.idempotency_key]));
 const fingerprint=hash(JSON.stringify([input.bot_alias,target,method,input.filename,input.content_type,input.sha256,input.caption??null,input.message_thread_id??null,input.disable_notification??true,...(input.parse_mode?[input.parse_mode]:[])]));
 let resource:Awaited<ReturnType<WorkflowFactory>>|undefined;let claim;
 try{resource=await(deps.open??openProductionWorkflow)(guard);guard();if(!resource.mediaLedger)throw Error('Missing media ledger');claim=await resource.mediaLedger.claim({key,fingerprint,createdAt:(deps.now??Date.now)()})}
 catch{throw Error('Media claim unavailable or key conflict; no new upload attempted')}
 finally{try{await resource?.close()}catch{}}
 guard();
 if(claim.state==='sent')return {sent:true,message_id:claim.messageId,reused:true,sha256:input.sha256,bytes:multipart.totalBytes};
 if(claim.state!=='claimed')return {sent:null,status:'delivery_unconfirmed',reused:true,retry_automatically:false};
 let messageId:number|undefined;
 try{guard();const result=await(deps.call??((bot,method,params,files)=>callBotApiBytes(bot,method,params,files,{signal:deps.signal,guard})))(input.bot_alias,method,params,files) as {bot?:string;result?:{message_id?:number}};messageId=matchingMessageId(result,input.bot_alias,target!,input.message_thread_id)}catch{/* Never retry a possibly sent file. */}
 let persisted=false;let settleResource:Awaited<ReturnType<WorkflowFactory>>|undefined;
 try{settleResource=await(deps.open??openProductionWorkflow)(()=>{});if(!settleResource.mediaLedger)throw Error('Missing ledger');await settleResource.mediaLedger.settle(key,fingerprint,messageId===undefined?'unknown':'sent',messageId);persisted=true}catch{/* Claim stays occupied even if receipt storage fails. */}
 finally{try{await settleResource?.close()}catch{}}
 return messageId===undefined?{sent:null,status:'delivery_unconfirmed',retry_automatically:false,receipt_persisted:persisted}:{sent:true,message_id:messageId,reused:false,receipt_persisted:persisted,sha256:input.sha256,bytes:multipart.totalBytes};
}

/** Read-only lookup. This neither claims a key nor requires file bytes or an enabled send gate. */
export async function getFileSendStatus(input:{bot_alias:string;idempotency_key:string},deps:Dependencies={}){
 input=structuredClone(input);
 if(!input||Object.keys(input).sort().join(',')!=='bot_alias,idempotency_key'||!text(input.bot_alias,64)||!text(input.idempotency_key,128)||!/^[A-Za-z0-9._:-]+$/.test(input.idempotency_key))throw Error('Invalid file status arguments');
 const env=deps.env??(()=>process.env);
 if(deps.signal?.aborted||env().TELEGRAM_WORKFLOW_MCP_ENABLED!=='true')throw Error('Media status disabled');
 const runtime=deps.registry?undefined:await workflowRegistry(env,deps.signal),registry=deps.registry??runtime!.read;
 const guard=()=>{if(deps.signal?.aborted||env().TELEGRAM_WORKFLOW_MCP_ENABLED!=='true')throw Error('Media status disabled');if(!registry().bots.includes(input.bot_alias))throw Error('Unconfigured media bot')};
 guard();let resource:Awaited<ReturnType<WorkflowFactory>>|undefined;let result;
 try{resource=await(deps.open??openProductionWorkflow)(guard);guard();if(!resource.mediaLedger)throw Error('Missing media ledger');result=await resource.mediaLedger.get(hash(JSON.stringify([input.bot_alias,input.idempotency_key])))}
 catch{throw Error('Media status storage unavailable')}
 finally{try{await resource?.close()}catch{}}
 await runtime?.refresh();guard();
 return {found:result!==undefined,status:result?.state??'not_found',...(result?.state==='sent'?{message_id:result.messageId}:{}),retry_automatically:false,note:'This is the stored receipt state, not a fresh Telegram delivery check. Inflight or unknown may already have sent; do not resend with a new key.'};
}
