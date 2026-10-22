import {approvedInboxPolicies} from './config';
import {validateBotScope} from '../vault/bot-scope';
type Env=Record<string,string|undefined>;
/** chat_id is internal authorization context; it is never sent to answerCallbackQuery. */
export function assertCallbackAnswerRequest(alias:string,method:string,params:Record<string,unknown>,env:Env){
 if(method!=='answerCallbackQuery'||Object.keys(params).sort().join(',')!=='cache_time,callback_query_id,chat_id,show_alert,text'
  ||typeof params.callback_query_id!=='string'||!params.callback_query_id||params.callback_query_id.length>256
  ||typeof params.chat_id!=='string'||!params.chat_id||typeof params.text!=='string'||!params.text.isWellFormed()||Array.from(params.text).length>200
  ||typeof params.show_alert!=='boolean'||params.cache_time!==0)throw Error('Callback answer request denied');
 if(env.TELEGRAM_WORKFLOW_MCP_ENABLED!=='true'||env.TELEGRAM_CALLBACK_ANSWER_ENABLED!=='true')throw Error('Callback answer disabled');
 const policies=approvedInboxPolicies(env),policy=Object.hasOwn(policies.bots,alias)?policies.bots[alias]:undefined;
 if(!policy?.acceptCallbacks||!policy.allowedChatIds.includes(params.chat_id))throw Error('Callback answer target denied');
}
export function assertVaultCallbackAnswer(alias:string,method:string,params:Record<string,unknown>,env:Env,saved:unknown){
 assertCallbackAnswerRequest(alias,method,params,env);const policy=validateBotScope(saved);
 if(!policy.methods.includes('answerCallbackQuery')||!policy.chat_ids.includes(params.chat_id as string))throw Error('Callback answer scope denied');
}
