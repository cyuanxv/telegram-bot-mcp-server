import {z} from 'zod';
import {getChats} from './config';
import type {DraftSessions} from './draft-sessions';
import type {BotInboxPolicy} from './inbox/types';
type Env=Record<string,string|undefined>;
type Resource={sessions:Pick<DraftSessions,'stopFromTelegram'>;close:()=>Promise<void>};
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const alias=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const decimal=z.union([positive,z.string().regex(/^[1-9][0-9]{0,15}$/).refine(v=>Number.isSafeInteger(Number(v)))]);
const updateId=z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),z.string().regex(/^(0|[1-9][0-9]{0,15})$/).refine(v=>Number.isSafeInteger(Number(v)))]);
const updateSchema=z.object({update_id:updateId,stopped_message_generation:z.object({chat:z.object({id:decimal,type:z.literal('private')}),draft_id:positive,message_thread_id:positive.optional()})});
const reply=(status:number,code:string)=>Response.json({ok:status===200,status:code},{status,headers:{'cache-control':'no-store'}});
/** Invoke only after webhook secret verification. No subscriptions, sends or raw event storage. */
export async function receiveDraftStop(update:unknown,bot:string,policy:BotInboxPolicy|undefined,env:()=>Env,open:(guard:()=>void)=>Promise<Resource>):Promise<Response|undefined>{
 const snapshot={...env()};
 if(snapshot.TELEGRAM_DRAFT_STOP_EVENTS_ENABLED!=='true'||snapshot.TELEGRAM_DRAFT_WORKFLOW_ENABLED!=='true'||policy?.acceptDraftStops!==true)return undefined;
 if(!update||typeof update!=='object'||!Object.hasOwn(update,'stopped_message_generation'))return undefined;
 let event:z.infer<typeof updateSchema>;
 try{event=updateSchema.parse(update)}catch{return reply(400,'invalid_draft_stop')}
 let resource:Resource|undefined;
 try{
  alias.parse(bot);const ownerId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/).parse(snapshot.TELEGRAM_VAULT_OWNER_ID);
  const raw=snapshot.TELEGRAM_DRAFT_PREVIEW_TARGETS_JSON;if(!raw||raw.length>16384)throw Error();
  const targets=z.array(z.object({bot_alias:alias,chat:alias}).strict()).min(1).max(100).parse(JSON.parse(raw)),chats=getChats(snapshot);
  const stopped=event.stopped_message_generation,chatId=String(stopped.chat.id);
  if(!policy.allowedChatIds.includes(chatId)||!targets.some(t=>t.bot_alias===bot&&Object.hasOwn(chats,t.chat)&&chats[t.chat]===chatId))return reply(200,'draft_stop_out_of_scope');
  const guard=()=>{const current=env();if(Object.keys({...snapshot,...current}).filter(k=>k.startsWith('TELEGRAM_')).some(k=>snapshot[k]!==current[k]))throw Error('Draft stop scope changed')};
  guard();resource=await open(guard);guard();
  const result=await resource.sessions.stopFromTelegram({ownerId,botAlias:bot,chatId,draftId:stopped.draft_id,...(stopped.message_thread_id===undefined?{}:{threadId:stopped.message_thread_id})});
  guard();return reply(200,'draft_'+result);
 }catch{return reply(503,'draft_stop_unconfirmed')}
 finally{try{await resource?.close()}catch{}}
}
