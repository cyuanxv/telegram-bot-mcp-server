import {z} from 'zod';
import {getChats} from './config';
import {callBotApi,callInboxControl} from './bot-api';
import {inboxConfig} from './inbox/config';
import {inboxEndpoint} from './inbox/control-policy';
const alias=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const messageDraftSchema=z.object({
 bot_alias:alias,chat:alias,draft_id:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 text:z.string().max(8192).refine(s=>Array.from(s).length<=4096&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s)),
 message_thread_id:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),confirm:z.literal(true),
}).strict();
type Options={env?:()=>Record<string,string|undefined>;call?:typeof callBotApi;signal?:AbortSignal;guard?:()=>void;beforeSend?:()=>Promise<void>;stopButton?:boolean;control?:typeof callInboxControl};
/** A single ephemeral preview update. Never persists, finalizes or retries. */
export async function sendMessageDraft(input:unknown,options:Options={}){
 const args=messageDraftSchema.parse(input),env=options.env??(()=>process.env),snapshot={...env()};
 if(snapshot.TELEGRAM_DRAFT_PREVIEW_ENABLED!=='true')throw Error('Draft preview disabled');
 const raw=snapshot.TELEGRAM_DRAFT_PREVIEW_TARGETS_JSON;
 let targets:unknown;try{if(!raw||raw.length>16384)throw Error();targets=JSON.parse(raw)}catch{throw Error('Invalid draft preview scope')}
 if(!Array.isArray(targets)||!targets.length||targets.length>100||targets.some(t=>!t||typeof t!=='object'||Array.isArray(t)||Object.keys(t).some(k=>!['bot_alias','chat'].includes(k))||!alias.safeParse(t.bot_alias).success||!alias.safeParse(t.chat).success)||!targets.some(t=>t.bot_alias===args.bot_alias&&t.chat===args.chat))throw Error('Draft preview target denied');
 const chats=getChats(snapshot),chatId=Object.hasOwn(chats,args.chat)?chats[args.chat]:undefined;
 if(!chatId||!/^([1-9][0-9]{0,15})$/.test(chatId)||!Number.isSafeInteger(Number(chatId)))throw Error('Draft preview requires a configured private chat');
 const signal=AbortSignal.any([AbortSignal.timeout(30000),...(options.signal?[options.signal]:[])]);
 const guard=()=>{options.guard?.();const current=env();if(signal.aborted||Object.keys({...snapshot,...current}).filter(k=>k.startsWith('TELEGRAM_')).some(k=>snapshot[k]!==current[k]))throw Error('Draft preview scope changed')};
 const call=options.call??callBotApi;
 guard();
 const observed=await call(args.bot_alias,'getChat',{chat_id:chatId},{},{signal,guard});
 guard();const chat=observed.result as Record<string,unknown>;
 if(observed.bot!==args.bot_alias||!chat||chat.type!=='private'||String(chat.id)!==chatId)throw Error('Draft preview chat mismatch');
 if(options.stopButton===true){
  const policy=inboxConfig(snapshot)?.bots[args.bot_alias];
  if(snapshot.TELEGRAM_DRAFT_STOP_EVENTS_ENABLED!=='true'||snapshot.TELEGRAM_DRAFT_WORKFLOW_ENABLED!=='true'||!options.beforeSend||policy?.acceptDraftStops!==true||!policy.allowedChatIds.includes(chatId))throw Error('Draft stop receiver not approved');
  const webhook=await(options.control??callInboxControl)(args.bot_alias,'getWebhookInfo',{}, {signal});
  guard();const info=webhook.result as Record<string,unknown>;
  if(webhook.bot!==args.bot_alias||!info||info.url!==inboxEndpoint(args.bot_alias,snapshot)||!Array.isArray(info.allowed_updates)||!info.allowed_updates.includes('stopped_message_generation'))throw Error('Draft stop webhook not ready');
 }
 const params={chat_id:chatId,draft_id:args.draft_id,text:args.text,...(options.stopButton===true?{can_stop:true,keep_on_stop:false}:{}),...(args.message_thread_id?{message_thread_id:args.message_thread_id}:{})};
 try{
  guard();const ack=await call(args.bot_alias,'sendMessageDraft',params,{},{signal,guard,beforeSend:options.beforeSend});guard();
  if(ack.bot!==args.bot_alias||ack.result!==true)throw Error();
  return {status:'preview_acknowledged',bot_alias:args.bot_alias,chat:args.chat,draft_id:args.draft_id,persisted:false,final_message_sent:false,retry_automatically:false};
 }catch{return {status:'preview_unconfirmed',persisted:false,final_message_sent:false,retry_automatically:false}}
}
