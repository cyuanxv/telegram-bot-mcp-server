import { createHash } from "node:crypto";
import type { AnswerState } from "./callback-answers";
import { callStoredCallbackAnswer } from "../bot-api";
import { openProductionWorkflow, type WorkflowFactory } from "../workflow-mcp";
import { approvedInboxPolicies } from "./config";
import { decimalId, validateInboxEvent } from "./normalize";
import type { InboxEvent } from "./types";
type Input = { bot_alias: string; sequence: string; text?: string; show_alert?: boolean };
type Dependencies = {
 env?: () => Record<string, string | undefined>; open?: WorkflowFactory; now?: () => number; signal?: AbortSignal;
 call?: (bot: string, method: string, params: Record<string, unknown>) => Promise<unknown>;
};
// Conservative product deadline measured from receipt; not a Telegram guarantee.
export const CALLBACK_ANSWER_MAX_AGE_MS = 10000;
/** Explicit owner action only. No timer, automatic interpretation or retry. */
export async function answerStoredCallback(input: Input, dependencies: Dependencies = {}) {
 input = structuredClone(input);
 if (!input || Object.keys(input).some(k => !["bot_alias", "sequence", "text", "show_alert"].includes(k))
  || typeof input.bot_alias !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(input.bot_alias)
  || typeof input.sequence !== "string" || (input.text !== undefined && (typeof input.text !== "string" || !input.text.isWellFormed() || [...input.text].length > 200))
  || (input.show_alert !== undefined && typeof input.show_alert !== "boolean")) throw Error("Invalid callback answer arguments");
 const sequence = decimalId(input.sequence), env = dependencies.env ?? (() => process.env), now = dependencies.now ?? Date.now;
 let selected: InboxEvent | undefined;
 const guard = () => {
  const settings = env();
  if (dependencies.signal?.aborted || settings.TELEGRAM_WORKFLOW_MCP_ENABLED !== "true" || settings.TELEGRAM_CALLBACK_ANSWER_ENABLED !== "true") throw Error("Callback answering disabled");
  const config = approvedInboxPolicies(settings);
  const policy = Object.hasOwn(config.bots,input.bot_alias) ? config.bots[input.bot_alias] : undefined;
  if (!policy || policy.acceptCallbacks !== true) throw Error("Callback scope not approved");
  if (selected) {
   const time = now();
   if (!Number.isSafeInteger(time) || time < selected.receivedAt || time - selected.receivedAt > CALLBACK_ANSWER_MAX_AGE_MS || selected.expiresAt <= time) throw Error("Callback answer window expired");
   if (selected.botAlias !== input.bot_alias || selected.updateType !== "callback_query" || !policy.allowedChatIds.includes(selected.chatId) || selected.businessConnectionId !== undefined) throw Error("Callback scope changed or unavailable");
  }
  return policy;
 };
 let claim: AnswerState | undefined, key="",fingerprint="";
 const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
 const initial = guard(); let resource: Awaited<ReturnType<WorkflowFactory>> | undefined;
 try {
  resource = await (dependencies.open ?? openProductionWorkflow)(guard); guard();
  const rows = await resource.inbox.list({ botAlias: input.bot_alias, chatIds: [...initial.allowedChatIds], afterSequence: (BigInt(sequence)-1n).toString(), limit: 1, now: now() });
  if (rows.length !== 1 || rows[0].sequence !== sequence) throw Error("Callback unavailable");
  selected = structuredClone(rows[0].event); validateInboxEvent(selected); guard();
  if(!resource.callbackAnswers)throw Error("Callback ledger not configured");
  key=digest([input.bot_alias,selected.callbackQueryId]);
  fingerprint=digest([key,input.text??"",input.show_alert??false]);
  claim=await resource.callbackAnswers.claim({key,fingerprint,sequence,createdAt:now()});
 } catch { throw Error("Callback unavailable or no longer authorized; no answer sent"); }
 finally { try { await resource?.close(); } catch { /* cleanup never grants authority */ } }
 guard();
 if(claim!=="claimed")return {answered:claim==="answered"?true:null,sequence,status:claim==="answered"?"already_answered":"answer_unconfirmed",reused:true,retry_automatically:false};
 const settle=async(state:"answered"|"unknown")=>{
  let bookkeeping: Awaited<ReturnType<WorkflowFactory>>|undefined;
  try {
   // Only settle the committed claim; revocation cannot authorize another send.
   bookkeeping=await (dependencies.open??openProductionWorkflow)(()=>{});
   if(!bookkeeping.callbackAnswers)return false;
   await bookkeeping.callbackAnswers.settle(key,fingerprint,state);return true;
  }catch{return false}finally{try{await bookkeeping?.close()}catch{}}
 };
 const call = dependencies.call ?? ((bot, method, params) => callStoredCallbackAnswer(bot,params, {chatId:selected!.chatId, signal: dependencies.signal,guard }));
 try {
  const result = await call(input.bot_alias,"answerCallbackQuery",{callback_query_id:selected!.callbackQueryId,text:input.text??"",show_alert:input.show_alert??false,cache_time:0});
  const value = result as {bot?: string; result?: unknown};
  const confirmed=value?.bot===input.bot_alias && value.result===true;
  const receipt_persisted=await settle(confirmed?"answered":"unknown");
  return { answered: confirmed ? true : null, receipt_persisted, sequence, status:confirmed?"answered":"answer_unconfirmed", retry_automatically:false };
 } catch { const receipt_persisted=await settle("unknown");return { answered:null,receipt_persisted,sequence,status:"answer_unconfirmed",retry_automatically:false }; }
}
