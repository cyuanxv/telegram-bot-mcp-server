import {z} from 'zod';
import {getChats} from './config';
import {inboxConfig} from './inbox/config';
type Env=Record<string,string|undefined>;
/** Configuration-only diagnostics. Never opens storage or contacts Telegram. */
export function draftConfiguration(env:Env){
 const auth=env.TELEGRAM_DRAFT_WORKFLOW_AUTH;
 let targets:'configuration_valid'|'configuration_invalid'='configuration_invalid',targetCount:number|null=null,stopTargetCount:number|null=null;
 try{
  const raw=env.TELEGRAM_DRAFT_PREVIEW_TARGETS_JSON;if(!raw||raw.length>16384)throw Error();
  const alias=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  const rows=z.array(z.object({bot_alias:alias,chat:alias}).strict()).min(1).max(100).parse(JSON.parse(raw));
  const chats=getChats(env);
  if(rows.some(r=>!Object.hasOwn(chats,r.chat)||! /^[1-9][0-9]{0,15}$/.test(chats[r.chat])||!Number.isSafeInteger(Number(chats[r.chat]))))throw Error();
  targetCount=rows.length;targets='configuration_valid';
  try{const policies=inboxConfig(env)?.bots;stopTargetCount=rows.filter(r=>policies?.[r.bot_alias]?.acceptDraftStops===true&&policies[r.bot_alias].allowedChatIds.includes(chats[r.chat])).length}catch{stopTargetCount=null}
 }catch{}
 return {
  workflow_enabled:env.TELEGRAM_DRAFT_WORKFLOW_ENABLED==='true',preview_enabled:env.TELEGRAM_DRAFT_PREVIEW_ENABLED==='true',stop_events_enabled:env.TELEGRAM_DRAFT_STOP_EVENTS_ENABLED==='true',
  server_auth:typeof auth==='string'&&auth.length>=32&&auth.length<=256?'configuration_valid':'configuration_invalid',
  owner:/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(env.TELEGRAM_VAULT_OWNER_ID??'')?'configuration_valid':'configuration_invalid',
  targets,target_count:targetCount,stop_target_count:stopTargetCount,
  storage:'not_checked',webhook_subscription:'not_checked',live_acceptance:'not_checked',
 };
}
