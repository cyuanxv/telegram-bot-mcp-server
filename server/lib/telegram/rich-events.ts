import {timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {actionToken,openRichSessions,richSessionGuard} from './rich-stream';
import {callStoredCallbackAnswer} from './bot-api';
import type {BotInboxPolicy} from './inbox/types';
const id=z.union([z.string().regex(/^-?[1-9][0-9]{0,15}$/),z.number().int().safe()]).transform(String);
const reply=(status:string)=>Response.json({ok:true,status});
/** Invoked only after authenticated webhook parsing. Never trust callback data as a command. */
export async function receiveRichEvent(update:unknown,bot:string,policy:BotInboxPolicy|undefined,env:Record<string,string|undefined>=process.env){
 if(env.TELEGRAM_RICH_STREAM_ENABLED!=='true'||!update||typeof update!=='object')return;
 const u=update as Record<string,unknown>,owner=env.TELEGRAM_VAULT_OWNER_ID;if(!owner)return;
 if(u.callback_query&&env.TELEGRAM_RICH_CALLBACKS_ENABLED==='true'){
  const parsed=z.object({id:z.string(),from:z.object({id}),data:z.string(),message:z.object({message_id:id,chat:z.object({id})})}).safeParse(u.callback_query);if(!parsed.success)return;
  const q=parsed.data;if(!q.data.startsWith('r2:'))return;
  const match=/^r2:([a-f0-9]{32}):([as]):([A-Za-z0-9_-]{16})$/.exec(q.data);if(!match||!policy?.acceptCallbacks||!policy.allowedChatIds.includes(q.message.chat.id))return reply('rich_callback_ignored');
  const allowed=z.array(z.string().regex(/^[1-9][0-9]{0,15}$/)).parse(JSON.parse(env.TELEGRAM_RICH_CALLBACK_USERS_JSON??'[]'));if(!allowed.includes(q.from.id))return reply('rich_callback_user_denied');
  const hex=match[1],sessionId=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  const r=await openRichSessions(env);
  try{const s=await r.sessions.get(owner,sessionId);if(!s||s.bot!==bot||s.chatId!==q.message.chat.id||String(s.messageId)!==q.message.message_id||Date.now()>=s.expiresAt)return reply('rich_callback_expired_or_mismatch');richSessionGuard(s,env);
   const expected=actionToken(s,match[2]==='a'?'ack':'stop',env);if(expected.length!==q.data.length||!timingSafeEqual(Buffer.from(expected),Buffer.from(q.data)))return reply('rich_callback_invalid');
   const result=await r.sessions.change(owner,s.id,undefined,v=>{if(match[2]==='a')v.acknowledged=true;else if(v.state!=='final')v.state='stopped'});
   // Effects are idempotent. Answer failure never rolls back a committed stop.
   try{await callStoredCallbackAnswer(bot,{callback_query_id:q.id,text:match[2]==='a'?'已确认收到':result.state==='final'?'生成已完成':'已停止生成',show_alert:false,cache_time:0},{chatId:s.chatId})}catch{}
   return reply('rich_callback_applied');
  }finally{await r.close()}
 }
 if(u.stopped_message_generation&&env.TELEGRAM_RICH_STOP_EVENTS_ENABLED==='true'){
  const parsed=z.object({chat:z.object({id,type:z.literal('private')}),draft_id:z.number().int().positive(),message_thread_id:z.never().optional()}).safeParse(u.stopped_message_generation);
  const event=u.stopped_message_generation as Record<string,unknown>;
  if(!parsed.success){console.info('rich_stop_diagnostic',JSON.stringify({status:'invalid_shape',draftType:typeof event.draft_id,threadType:typeof event.message_thread_id,threadZero:event.message_thread_id===0,issues:parsed.error.issues.map(x=>({path:x.path.join('.'),code:x.code}))}));return;}
  if(!policy?.acceptDraftStops||!policy.allowedChatIds.includes(parsed.data.chat.id)){console.info('rich_stop_diagnostic',JSON.stringify({status:'scope_denied'}));return;}

  // Stop event identifies a draft, not a client-supplied session. Exact owner+Bot+chat binding.
  const {Pool}=await import('pg');const {postgresConnectionConfig}=await import('./delivery/postgres-config');const pool=new Pool(postgresConnectionConfig(env));
  try{const rows=await pool.query("SELECT document FROM public.telegram_rich_sessions WHERE owner_id=$1 AND document->>'bot'=$2 AND document->>'chatId'=$3 AND document->>'draftId'=$4",[owner,bot,parsed.data.chat.id,String(parsed.data.draft_id)]);if(rows.rows.length!==1){console.info('rich_stop_diagnostic',JSON.stringify({status:'draft_not_unique',matches:rows.rows.length,draftId:parsed.data.draft_id}));return;}
   const r=await openRichSessions(env);try{const s=await r.sessions.get(owner,rows.rows[0].document.id);if(s&&s.mode==='private'){richSessionGuard(s,env);if(s.state!=='final'&&s.state!=='stopped')await r.sessions.stop(owner,s.id);return reply('rich_generation_stopped')}}finally{await r.close()}
  }finally{await pool.end()}
 }
}
