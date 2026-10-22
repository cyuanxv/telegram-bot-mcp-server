import {captureAccountPeer,restoreAccountPeer} from './mtproto-peers';
import type {Api} from 'teleproto';
import bigInt from 'big-integer';
import {openRuntimeAccount,listVaultAccountSummaries,type AccountOperation} from './vault/runtime-accounts';
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { Logger, LogLevel } from "teleproto/extensions/Logger";
import { getAccounts, resolveAccount } from "./config";
import { boundedInteger, peerName, publicDialog, publicMessage, publicUser, redactConfiguredSecrets, searchQuery, validateSafeRequest } from "./mtproto-policy";

class PublicMtprotoError extends Error {}

export function listAccounts() {
  return Object.entries(getAccounts()).map(([alias, value]) => {
    let configured = false;
    try { resolveAccount(alias); configured = true; } catch {}
    return { alias, label: value.label, configured, enabled: process.env.TELEGRAM_MTPROTO_ENABLED === "true" };
  });
}

export async function listConfiguredAccounts(){
 const existing=listAccounts();const names=new Set(existing.map(account=>account.alias));
 const stored=await listVaultAccountSummaries();return [...existing,...stored.filter(account=>!names.has(account.alias))];
}

function safeRequestError(error: unknown): Error {
  if (error instanceof PublicMtprotoError) return error;
  // Do not echo library messages, requests, session strings, URLs or raw TL data.
  const code = error && typeof error === "object" ? (error as { errorMessage?: unknown }).errorMessage : undefined;
  const safeCodes = ["AUTH_KEY_UNREGISTERED", "SESSION_REVOKED", "USER_DEACTIVATED", "USER_DEACTIVATED_BAN", "CHAT_WRITE_FORBIDDEN", "CHAT_ADMIN_REQUIRED", "PEER_ID_INVALID", "MESSAGE_TOO_LONG"];
  if (typeof code === "string" && safeCodes.includes(code)) return new Error(`Telegram MTProto request failed: ${code}`);
  if (typeof code === "string" && /^FLOOD_WAIT_[0-9]{1,6}$/.test(code)) return new Error(`Telegram MTProto request rate-limited: ${code}`);
  return new Error("Telegram MTProto request failed; sensitive error details were withheld");
}

export const MTPROTO_OPERATION_TIMEOUT_MS = 30000;
export async function withMtproto<T>(accountAlias: string | undefined, fn: (client: TelegramClient, stablePeer?:ReturnType<typeof bigInt>|Api.TypeInputPeer,rememberPeers?:(entities:unknown[])=>Promise<void>) => Promise<T>, request?:AccountOperation): Promise<T> {
  if (process.env.TELEGRAM_MTPROTO_ENABLED !== "true") {
    throw new Error("MTProto is disabled; secure account/API configuration and explicit deployment enablement are required");
  }
  let lease:Awaited<ReturnType<typeof openRuntimeAccount>>|undefined;
  const useVault=!!accountAlias&&!Object.hasOwn(getAccounts(),accountAlias)&&process.env.TELEGRAM_VAULT_ACCOUNTS_ENABLED==='true';
  let config: {session:string;apiId?:number;apiHash?:string}=useVault?{session:''}:resolveAccount(accountAlias).config;
  const originalMcpKey = process.env.MCP_API_KEY || "";
  const snapshot = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('TELEGRAM_')));
  let client: TelegramClient | undefined, expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = () => {
    if (expired) throw new PublicMtprotoError('Telegram MTProto operation timed out; result is unconfirmed; do not automatically retry');
    if (Object.keys({...snapshot,...process.env}).filter(key=>key.startsWith('TELEGRAM_')).some(key=>snapshot[key]!==process.env[key])) {
      throw new PublicMtprotoError('Telegram MTProto configuration changed; result is unconfirmed; do not automatically retry');
    }
  };
  // The SDK timeout only covers TCP connection establishment. Bound the whole
  // request, including authorization, user operation and disconnect cleanup.
  const deadline = new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>{expired=true;reject(new PublicMtprotoError('Telegram MTProto operation timed out; result is unconfirmed; do not automatically retry'))},MTPROTO_OPERATION_TIMEOUT_MS);
  });
  const operation = async () => {
    try {
      guard();
      if(useVault&&accountAlias){
        if(!request)throw new PublicMtprotoError('Account operation scope is required');
        lease=await openRuntimeAccount(accountAlias,request,{guard});config=lease.config;guard();
      }
      client = new TelegramClient(new StringSession(config.session), config.apiId!, config.apiHash!, {
        connectionRetries: 1, requestRetries: 1, timeout: 20, autoReconnect: false,
        floodSleepThreshold: 0, baseLogger: new Logger(LogLevel.NONE),
      });
      await client.connect(); guard();
      if (!(await client.isUserAuthorized())) throw new PublicMtprotoError("Telegram account session is not authorized");
      guard();
      if(lease){const user=await client.getMe();guard();if(String(user.id)!==lease.userId||user.bot||user.deleted)throw new PublicMtprotoError('Account identity mismatch');await lease.assertCurrent();guard()}
      const cached=await lease?.loadPeer?.();guard();
      // Cache reads may yield; recheck binding immediately before the business RPC.
      if(lease){await lease.assertCurrent();guard()}
      const result = await fn(client,cached?restoreAccountPeer(cached):lease&&request?.peer?bigInt(request.peer):undefined,lease?async entities=>{const peers=entities.map(captureAccountPeer).filter((p):p is NonNullable<typeof p>=>p!==undefined);await lease!.savePeers(peers);guard()}:undefined); guard();
      if(lease){await lease.assertCurrent();guard()}
      return redactConfiguredSecrets(result, [config.session, config.apiHash!, originalMcpKey, process.env.MCP_API_KEY || ""]) as T;
    } finally {
      // A late connect completion re-enters this cleanup after guard rejects it.
      await Promise.all([client?.disconnect().catch(()=>{}),lease?.close().catch(()=>{})]);
    }
  };
  try { const result=await Promise.race([operation(),deadline]); guard(); return result; }
  catch(error) { throw safeRequestError(error); }
  finally {
    clearTimeout(timer);
    // Start cancellation even when connect/RPC/cleanup itself never settles.
    // SDK disconnect is best-effort, not proof that a dispatched write failed.
    if(expired&&client)void client.disconnect().catch(()=>{});
    if(expired&&lease)void lease.close().catch(()=>{});
  }
}

export async function callMtproto(accountAlias: string | undefined, method: string, args: Record<string, unknown> = {}) {
  const request = validateSafeRequest(method, args);
  return withMtproto(accountAlias, async (client,stablePeer) => {
    if (request.method === "bots.checkUsername") {
      const result = await (client.api as any).call({ _: "bots.checkUsername", username: request.username });
      if (typeof result !== "boolean") throw new PublicMtprotoError("Unexpected result for username availability check");
      return { available: result };
    }
    // Construct a bounded convenience call rather than evaluating arbitrary TL trees.
    const messages = await client.getMessages(stablePeer??request.peer, {
      limit: request.limit, offsetId: request.offsetId,
      ...(request.method === "messages.search" ? { search: request.query } : {}),
    });
    return { messages: messages.slice(0, request.limit).map(publicMessage) };
  },{operation:request.method==='bots.checkUsername'?'check_username':request.method==='messages.search'?'search':'read_history',...('peer' in request?{peer:request.peer}:{})});
}

export async function getMtprotoMe(accountAlias?: string) {
  return withMtproto(accountAlias, async client => publicUser(await client.getMe()),{operation:'get_me'});
}

export async function listDialogs(accountAlias?: string, limit = 50) {
  boundedInteger(limit, "limit", 1, 200);
  return withMtproto(accountAlias, async (client,peer,remember)=>{const dialogs=(await client.getDialogs({limit})).slice(0,limit);if(remember)await remember(dialogs.map(dialog=>dialog.entity));return dialogs.map(publicDialog)},{operation:'list_dialogs'});
}

export async function sendMtprotoMessage(accountAlias: string | undefined, peer: string, message: string) {
  peerName(peer);
  if (typeof message !== "string" || message.length < 1 || message.length > 4096) throw new Error("message must contain 1 to 4096 characters");
  return withMtproto(accountAlias, async (client,stablePeer) => publicMessage(await client.sendMessage(stablePeer??peer, { message })),{operation:'send_message',peer});
}

export async function searchMtprotoMessages(accountAlias: string | undefined, peer: string, query: string, limit = 20) {
  peerName(peer); searchQuery(query); boundedInteger(limit, "limit", 1, 100);
  return withMtproto(accountAlias, async (client,stablePeer) => (await client.getMessages(stablePeer??peer, { search: query, limit })).slice(0, limit).map(publicMessage),{operation:'search',peer});
}
