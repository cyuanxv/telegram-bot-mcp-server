import {inboxEndpoint} from './control-policy';
import {matchingMessageId} from '../message-receipt';
import { callBotApi,callInboxControl } from "../bot-api";
import {workflowRegistry} from "../vault/workflow-registry";
import { inboxConfig } from "./config";
import { openProductionWorkflow, type WorkflowFactory } from "../workflow-mcp";
type Input={bot_alias:string;chat:string;text:string;buttons:{text:string;data:string}[][];message_thread_id?:number;disable_notification?:boolean};
type Dependencies={env?:()=>Record<string,string|undefined>;registry?:()=>{bots:string[];chats:Record<string,string>};open?:WorkflowFactory;signal?:AbortSignal;call?:(bot:string,method:string,params:Record<string,unknown>)=>Promise<unknown>};
function validText(v:unknown,max:number){return typeof v==='string'&&v.trim().length>0&&v.length<=max&&v.isWellFormed()}
export async function sendCallbackMessage(input:Input,deps:Dependencies={}){
 input=structuredClone(input);
 if(!input||Object.keys(input).some(k=>!['bot_alias','chat','text','buttons','message_thread_id','disable_notification'].includes(k))||!validText(input.bot_alias,64)||!validText(input.chat,128)||!validText(input.text,4000)
  ||!Array.isArray(input.buttons)||input.buttons.length<1||input.buttons.length>8
  ||(input.message_thread_id!==undefined&&(!Number.isSafeInteger(input.message_thread_id)||input.message_thread_id<1))
  ||(input.disable_notification!==undefined&&typeof input.disable_notification!=='boolean'))throw Error('Invalid callback message arguments');
 let count=0;
 const keyboard=input.buttons.map(row=>{
  if(!Array.isArray(row)||row.length<1||row.length>8)throw Error('Invalid callback button row');
  return row.map(b=>{count++;if(!b||Object.keys(b).sort().join(',')!=='data,text'||!validText(b.text,64)||!validText(b.data,64)||Buffer.byteLength(b.data,'utf8')>64)throw Error('Invalid callback button');return {text:b.text,callback_data:b.data}});
 });
 if(count>32)throw Error('Too many callback buttons');
 const env=deps.env??(()=>process.env);
 if(deps.signal?.aborted||env().TELEGRAM_CALLBACK_SEND_ENABLED!=='true'||env().TELEGRAM_CALLBACK_ANSWER_ENABLED!=='true'||env().TELEGRAM_WORKFLOW_MCP_ENABLED!=='true')throw Error('Callback sending disabled');
 const runtime=deps.registry?undefined:await workflowRegistry(env,deps.signal),registry=deps.registry??runtime!.read;let target:string|undefined;
 const guard=()=>{
  const settings=env();if(deps.signal?.aborted||settings.TELEGRAM_CALLBACK_SEND_ENABLED!=='true'||settings.TELEGRAM_CALLBACK_ANSWER_ENABLED!=='true'||settings.TELEGRAM_WORKFLOW_MCP_ENABLED!=='true')throw Error('Callback sending disabled');
  const configured=registry(),policy=inboxConfig(settings)?.bots[input.bot_alias];
  if(!configured.bots.includes(input.bot_alias)||!Object.hasOwn(configured.chats,input.chat)||!policy||policy.acceptCallbacks!==true||!policy.retainText)throw Error('Callback receiver not ready for destination');
  const chat=configured.chats[input.chat];if(!policy.allowedChatIds.includes(chat)||(target!==undefined&&target!==chat))throw Error('Callback destination changed or not approved');target=chat;
 };
 guard();let resource:Awaited<ReturnType<WorkflowFactory>>|undefined;
 try{resource=await(deps.open??openProductionWorkflow)(guard);guard();if(!resource.callbackAnswers)throw Error('Callback ledger missing');await resource.callbackAnswers.assertReady()}
 catch{throw Error('Callback storage not ready; no message sent')}
 finally{try{await resource?.close()}catch{}}
 guard();
 const call=deps.call??((bot,method,params)=>method==='getWebhookInfo'?callInboxControl(bot,method,params,{signal:deps.signal}):callBotApi(bot,method,params,{}, {signal:deps.signal,guard}));
 let webhook;try{webhook=await call(input.bot_alias,'getWebhookInfo',{}) as {bot?:string;result?:{url?:unknown;allowed_updates?:unknown}}}catch{throw Error('Callback webhook inspection failed; no message sent')}
 if(webhook.bot!==input.bot_alias||webhook.result?.url!==inboxEndpoint(input.bot_alias,env())||!Array.isArray(webhook.result.allowed_updates)||!webhook.result.allowed_updates.includes('callback_query'))throw Error('Callback webhook not ready; no message sent');
 guard();
 try{
  const data=await call(input.bot_alias,'sendMessage',{chat_id:target,text:input.text,reply_markup:{inline_keyboard:keyboard},disable_notification:input.disable_notification??true,...(input.message_thread_id===undefined?{}:{message_thread_id:input.message_thread_id})}) as {bot?:string;result?:{message_id?:number}};
  const messageId=matchingMessageId(data,input.bot_alias,target!,input.message_thread_id);
  if(messageId!==undefined)return {sent:true,message_id:messageId,requires_local_computer:false};
 }catch{/* Unknown dispatch is never retried. */}
 return {sent:null,status:'delivery_unconfirmed',retry_automatically:false};
}
