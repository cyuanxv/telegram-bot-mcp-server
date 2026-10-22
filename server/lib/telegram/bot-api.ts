import type {RichFile} from './rich-compiler.mjs';
import {assertCallbackAnswerRequest} from './inbox/answer-policy';
import {assertAvatarRequest} from "./avatar-policy";
import {assertAvatarWriteScope,buildAvatarMultipart,type AvatarUpload} from './avatar-bytes';
import { assertInboxControlRequest } from "./inbox/control-policy";
import {assertVaultBotScope} from "./vault/bot-scope";
import { resolveRuntimeBot } from "./vault/runtime-bots";
import { assertMediaUploadScope, buildMediaMultipart, type ByteAttachment } from "./media-bytes";

export type AttachmentInput = { url: string; filename?: string; contentType?: string };
export const BOT_API_TIMEOUT_MS = 30_000;
export const BOT_API_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export type BotApiFailureCode = "network_error" | "timeout" | "invalid_response" | "response_too_large" | "telegram_error" | "rate_limited" | "chat_migrated";
export type BotApiFailure = {
  code: BotApiFailureCode;
  http_status?: number;
  telegram_error_code?: number;
  retry_after_seconds?: number;
  migrate_to_chat_id?: string;
  delivery_unknown: boolean;
  automatic_retry_performed: false;
};

export class BotApiError extends Error {
  readonly details: BotApiFailure;
  // Compatibility projection only. Never retain a raw upstream response/error.
  readonly telegram: { ok: false; error_code?: number; parameters?: { retry_after?: number; migrate_to_chat_id?: string } };
  constructor(message: string, details: BotApiFailure) {
    super(message);
    this.name = "BotApiError";
    this.details = details;
    this.telegram = { ok: false, ...(details.telegram_error_code === undefined ? {} : { error_code: details.telegram_error_code }), parameters: {
      ...(details.retry_after_seconds === undefined ? {} : { retry_after: details.retry_after_seconds }),
      ...(details.migrate_to_chat_id === undefined ? {} : { migrate_to_chat_id: details.migrate_to_chat_id }),
    } };
  }
}
function failure(code: BotApiFailureCode, message: string, extra: Partial<BotApiFailure> = {}) {
  return new BotApiError(message, { code, delivery_unknown: true, automatic_retry_performed: false, ...extra });
}
function boundedInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

// Applies the same absolute request deadline to every body chunk, including a stalled body.
export async function readBotApiJson(response: Response, signal: AbortSignal, maxBytes = BOT_API_MAX_RESPONSE_BYTES): Promise<unknown> {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    throw failure("timeout", "Telegram Bot API request timed out; delivery is unknown");
  }
  const reader = response.body?.getReader();
  if (!reader) throw failure("invalid_response", "Telegram Bot API returned an invalid response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(failure("timeout", "Telegram Bot API request timed out; delivery is unknown"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    while (true) {
      if (signal.aborted) throw failure("timeout", "Telegram Bot API request timed out; delivery is unknown");
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw failure("response_too_large", "Telegram Bot API response exceeded the size limit");
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
    catch { throw failure("invalid_response", "Telegram Bot API returned an invalid response"); }
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    // Do not wait indefinitely for an upstream stream's cancellation hook.
    void reader.cancel().catch(() => {});
  }
}

export async function callBotApi(
  botAlias: string | undefined, method: string,
  params: Record<string, unknown> = {}, attachments: Record<string, AttachmentInput> = {}, options: { signal?: AbortSignal; guard?: () => void; beforeSend?: () => Promise<void> } = {},
) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(method)) throw new Error("Invalid Telegram Bot API method name");
  if (["getmanagedbottoken", "replacemanagedbottoken"].includes(method.toLowerCase())) {
    throw new Error("Token operations require a secure credential handoff/storage flow; no Telegram request was made");
  }
  if (Object.keys(attachments).length > 0) throw new Error("Server-side attachment URL downloads are disabled pending a safe uploader. Use Telegram file_id or a supported media URL parameter instead");
  // Serialize before dispatch: serialization errors cannot indicate an ambiguous send.
  const serialized = JSON.stringify(params);
  return dispatchBotRequest(botAlias, method, serialized, "application/json", options.signal, JSON.parse(serialized),undefined,options.guard,undefined,options.beforeSend);
}

export async function callBotApiBytes(botAlias: string | undefined, method: string, params: Record<string, unknown>, attachments: ByteAttachment[], options: { signal?: AbortSignal; guard?: () => void } = {}) {
  assertMediaUploadScope(botAlias, params?.chat_id);
  const snapshot = JSON.parse(JSON.stringify(params));
  const { body } = buildMediaMultipart(method, snapshot, attachments);
  const guard=()=>{assertMediaUploadScope(botAlias,snapshot.chat_id);options.guard?.()};
  return dispatchBotRequest(botAlias, method, body, undefined, options.signal, snapshot,undefined,guard);
}

/** Internal Rich Messages transport. Called only with validated compiler output. */
export async function callRichBotApi(alias:string,method:'sendRichMessage'|'editMessageText'|'sendRichMessageDraft',params:Record<string,unknown>,files:RichFile[],options:{signal?:AbortSignal;guard?:()=>void;beforeSend?:()=>Promise<void>}={}){
 const guard=()=>{if(alias!=='default'||process.env.TELEGRAM_RICH_MESSAGES_ENABLED!=='true')throw Error('Rich messages disabled');assertMediaUploadScope(alias,method==='sendRichMessageDraft'&&typeof params.chat_id==='number'&&Number.isSafeInteger(params.chat_id)&&params.chat_id>0?String(params.chat_id):params.chat_id);options.guard?.()};guard();
 if(files.length===0)return callBotApi(alias,method,params,{}, {...options,guard});
 const body=new FormData();for(const [k,v]of Object.entries(params))body.append(k,typeof v==='string'?v:JSON.stringify(v));
 for(const f of files)body.append(f.id,new Blob([new Uint8Array(Buffer.from(f.base64,'base64'))],{type:f.content_type}),f.filename);
 return dispatchBotRequest(alias,method,body,undefined,options.signal,params,undefined,guard,undefined,options.beforeSend);
}

/** Dedicated avatar upload; no chat target, arbitrary multipart fields or remote downloads. */
export async function callBotAvatarBytes(alias:string,input:AvatarUpload,options:{signal?:AbortSignal;guard?:()=>void;expectedBotId?:string}={}){
  const guard=()=>{assertAvatarWriteScope(alias);options.guard?.()};guard();
  const {body,photo}=buildAvatarMultipart(input);
  return dispatchBotRequest(alias,'setMyProfilePhoto',body,undefined,options.signal,{photo},'avatar_control',guard,options.expectedBotId);
}

/** Internal avatar-only transport; no generic method or target selection. */
export async function callBotAvatarApi(alias:string|undefined,method:string,params:Record<string,unknown>={},_attachments:Record<string,AttachmentInput>={},options:{signal?:AbortSignal;guard?:()=>void;expectedBotId?:string}={}){
 if(!alias||Object.keys(_attachments).length)throw Error('Invalid avatar request');
 assertAvatarRequest(method,params,options.expectedBotId);
 const serialized=JSON.stringify(params);
 return dispatchBotRequest(alias,method,serialized,'application/json',options.signal,JSON.parse(serialized),'avatar_control',options.guard,options.expectedBotId);
}

/** Only the fixed, approved inbox connector uses this channel; generic MCP calls
 * cannot supply its purpose marker or choose an arbitrary webhook destination. */
export async function callInboxControl(botAlias: string, method: string, params: Record<string,unknown> = {}, options: {signal?: AbortSignal} = {}) {
  const body = JSON.stringify(params), snapshot = JSON.parse(body);
  assertInboxControlRequest(botAlias,method,snapshot,process.env);
  return dispatchBotRequest(botAlias,method,body,'application/json',options.signal,snapshot,'inbox_control');
}

/** Internal stored-callback flow only: transport omits the trusted chat context. */
export async function callStoredCallbackAnswer(alias:string,params:Record<string,unknown>,options:{chatId:string;signal?:AbortSignal;guard?:()=>void}){
 if(Object.keys(params).sort().join(',')!=='cache_time,callback_query_id,show_alert,text')throw Error('Callback answer request denied');
 const body=JSON.stringify(params),context={...JSON.parse(body),chat_id:options.chatId};
 assertCallbackAnswerRequest(alias,'answerCallbackQuery',context,process.env);
 return dispatchBotRequest(alias,'answerCallbackQuery',body,'application/json',options.signal,context,'callback_answer',options.guard);
}

async function dispatchBotRequest(botAlias: string | undefined, method: string, body: BodyInit, contentType?: string, externalSignal?: AbortSignal, scopeParams: Record<string, unknown> = {}, purpose?: "inbox_control"|"avatar_control"|"callback_answer", beforeDispatch?: () => void, expectedBotId?:string, beforeSend?:()=>Promise<void>) {
  beforeDispatch?.();
  const scopeSnapshot = JSON.parse(JSON.stringify(scopeParams)) as Record<string, unknown>;
  if (purpose==='avatar_control'){assertAvatarRequest(method,scopeSnapshot,expectedBotId);if(['setMyProfilePhoto','removeMyProfilePhoto'].includes(method))assertAvatarWriteScope(botAlias!);}
  else if (purpose==='callback_answer') assertCallbackAnswerRequest(botAlias!,method,scopeSnapshot,process.env);
  else if (purpose) assertInboxControlRequest(botAlias!,method,scopeSnapshot,process.env);
  else assertVaultBotScope(botAlias, method, scopeSnapshot);
  if (externalSignal?.aborted) throw failure("network_error", "Telegram request was cancelled before dispatch", { delivery_unknown: false });
  const controller = new AbortController();
  const requestSignal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(failure("timeout", "Telegram Bot API request timed out; delivery is unknown"));
    }, BOT_API_TIMEOUT_MS);
  });
  try {
    const operation = async () => {
      const { alias, config } = await resolveRuntimeBot(botAlias, { signal: requestSignal, request: {method,params:scopeSnapshot,...(purpose?{purpose}:{}),...(expectedBotId?{expectedBotId}:{})} });
      if(beforeSend)await beforeSend();
      if (requestSignal.aborted) throw failure("network_error", "Telegram request was cancelled before dispatch", { delivery_unknown: false });
      if(purpose==='avatar_control'){assertAvatarRequest(method,scopeSnapshot,expectedBotId);if(['setMyProfilePhoto','removeMyProfilePhoto'].includes(method))assertAvatarWriteScope(alias);if(expectedBotId&&config.token.split(':')[0]!==expectedBotId)throw Error('Avatar Bot identity changed');}
      else if (purpose==='callback_answer') assertCallbackAnswerRequest(alias,method,scopeSnapshot,process.env);
      else if (purpose) assertInboxControlRequest(alias,method,scopeSnapshot,process.env);
      else assertVaultBotScope(alias, method, scopeSnapshot);
      beforeDispatch?.();
      let response: Response;
      try {
        response = await fetch(`https://api.telegram.org/bot${config.token}/${method}`, {
          method: "POST", headers: contentType ? { "content-type": contentType } : {}, body,
          cache: "no-store", signal: requestSignal, redirect: "error",
        });
      } catch {
        if (controller.signal.aborted) throw failure("timeout", "Telegram Bot API request timed out; delivery is unknown");
        throw failure("network_error", "Telegram Bot API network request failed; delivery is unknown");
      }
      let raw: unknown;
      try { raw = await readBotApiJson(response, requestSignal); }
      catch (error) {
        if (error instanceof BotApiError) throw error;
        throw failure("network_error", "Telegram Bot API response could not be read; delivery is unknown");
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw failure("invalid_response", "Telegram Bot API returned an invalid response");
      const data = raw as Record<string, unknown>;
      if (response.ok && data.ok === true && Object.hasOwn(data, "result")) return { bot: alias, result: data.result };
      if (data.ok !== false) throw failure("invalid_response", "Telegram Bot API returned an invalid response", { http_status: response.status });
      const parameters = data.parameters && typeof data.parameters === "object" && !Array.isArray(data.parameters) ? data.parameters as Record<string, unknown> : {};
      const errorCode = boundedInteger(data.error_code) ? data.error_code : undefined;
      if (errorCode === undefined || errorCode < 400 || errorCode > 599 || errorCode !== response.status) {
        throw failure("invalid_response", "Telegram Bot API returned an inconsistent error response", { http_status: response.status });
      }
      const retryAfter = boundedInteger(parameters.retry_after) ? parameters.retry_after : undefined;
      const migration = typeof parameters.migrate_to_chat_id === "number" && Number.isSafeInteger(parameters.migrate_to_chat_id) ? String(parameters.migrate_to_chat_id) : undefined;
      const code = errorCode === 429 || response.status === 429 ? "rate_limited" : migration !== undefined ? "chat_migrated" : "telegram_error";
      // Deliberately do not echo description, headers, URLs, or arbitrary provider fields.
      const message = code === "rate_limited" ? "Too Many Requests" : code === "chat_migrated" ? "Telegram chat migrated; confirm the new destination before resending" : `Telegram Bot API rejected the request (HTTP ${response.status})`;
      throw failure(code, message, {
        http_status: response.status, ...(errorCode === undefined ? {} : { telegram_error_code: errorCode }),
        ...(retryAfter === undefined ? {} : { retry_after_seconds: retryAfter }),
        ...(migration === undefined ? {} : { migrate_to_chat_id: migration }), delivery_unknown: response.status >= 500,
      });
    };
    return await Promise.race([operation(), timedOut]);
  } finally { clearTimeout(timer!); }
}
