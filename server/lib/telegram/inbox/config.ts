import { decimalId } from "./normalize";
import { getChats, getBots } from "../config";
import type { InboxConfig, BotInboxPolicy } from "./types";
export function inboxConfig(env: Record<string, string | undefined>): InboxConfig | undefined {
  if (env.TELEGRAM_WEBHOOK_ENABLED !== "true") return undefined;
  return approvedInboxPolicies(env);
}
export function approvedInboxPolicies(env: Record<string, string | undefined>): InboxConfig {
  if (env.TELEGRAM_WEBHOOK_RETENTION_APPROVED !== "true") throw new Error("Inbox retention scope has not been configured");
  let raw: unknown; try { raw = JSON.parse(env.TELEGRAM_WEBHOOK_BOTS_JSON || "null"); } catch { throw new Error("Invalid inbox configuration"); }
  // Optional onboarding shortcut for the existing default bot/destination.
  // Explicit JSON remains authoritative; never silently widen that policy.
  if (!env.TELEGRAM_WEBHOOK_BOTS_JSON && env.TELEGRAM_INBOX_ALLOW_DEFAULT_DESTINATION === "true") {
    const chatId = getChats(env).default;
    if (!chatId || !getBots(env).default) throw new Error("Default inbox destination is not configured");
    const retain = env.TELEGRAM_INBOX_DEFAULT_RETAIN_TEXT;
    const days = env.TELEGRAM_INBOX_DEFAULT_RETENTION_DAYS;
    if (!["true", "false"].includes(retain ?? "") || !/^(?:[1-9]|[12][0-9]|30)$/.test(days ?? "")) throw new Error("Default inbox retention must be explicit");
    let allowedChatIds: unknown = [chatId];
    if (env.TELEGRAM_INBOX_DEFAULT_ALLOWED_CHAT_IDS_JSON !== undefined) {
      try { allowedChatIds = JSON.parse(env.TELEGRAM_INBOX_DEFAULT_ALLOWED_CHAT_IDS_JSON); }
      catch { throw new Error("Invalid explicit default inbox destinations"); }
      if (!Array.isArray(allowedChatIds) || !allowedChatIds.includes(chatId)) throw new Error("Explicit inbox destinations must retain the default destination");
    }
    raw = { default: { secretToken: env.TELEGRAM_INBOX_DEFAULT_WEBHOOK_SECRET, allowedChatIds, retainText: retain === "true", retentionDays: Number(days), ...(env.TELEGRAM_INBOX_DEFAULT_ACCEPT_CALLBACKS==='true'?{acceptCallbacks:true}:{}), ...(env.TELEGRAM_INBOX_DEFAULT_ACCEPT_DRAFT_STOPS==='true'?{acceptDraftStops:true}:{}) } };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length < 1 || Object.keys(raw).length > 25) throw new Error("Invalid inbox configuration");
  const bots: Record<string, BotInboxPolicy> = Object.create(null);
  for (const [alias, value] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(alias) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid inbox bot configuration");
    const p = value as BotInboxPolicy;
    if (Object.keys(p).some(key => !["secretToken", "allowedChatIds", "allowedBusinessConnectionIds", "retainText", "retentionDays", "acceptCallbacks", "acceptDraftStops"].includes(key))
      || typeof p.secretToken !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(p.secretToken)
      || !Array.isArray(p.allowedChatIds) || p.allowedChatIds.length < 1 || p.allowedChatIds.length > 100
      || (p.acceptDraftStops !== undefined && typeof p.acceptDraftStops !== "boolean")
      || (p.acceptCallbacks !== undefined && typeof p.acceptCallbacks !== "boolean")
      || typeof p.retainText !== "boolean" || !Number.isSafeInteger(p.retentionDays) || p.retentionDays < 1 || p.retentionDays > 30) throw new Error("Invalid inbox bot configuration");
    const ids = p.allowedChatIds.map(id => { if (typeof id !== "string") throw new Error("Chat IDs must be exact decimal strings"); return decimalId(id, "chat"); });
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate inbox chat scope");
    const connections = p.allowedBusinessConnectionIds ?? [];
    if (!Array.isArray(connections) || connections.length > 100 || connections.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) || new Set(connections).size !== connections.length) throw new Error("Invalid Business connection scope");
    bots[alias] = { allowedBusinessConnectionIds: [...connections], secretToken: p.secretToken, allowedChatIds: ids, retainText: p.retainText, retentionDays: p.retentionDays, ...(p.acceptDraftStops === undefined ? {} : { acceptDraftStops: p.acceptDraftStops }), ...(p.acceptCallbacks === undefined ? {} : { acceptCallbacks: p.acceptCallbacks }) };
  }
  return { bots };
}

/** Rechecks the selected receiver policy as observed by this process. A deployment's
 * old process environment cannot observe a different deployment's settings. */
export function inboxPolicyGuard(env: () => Record<string,string|undefined>, alias: string,
  initial: BotInboxPolicy | undefined, signal?: AbortSignal): () => void {
  const snapshot = initial === undefined ? undefined : JSON.stringify(initial);
  return () => {
    if (signal?.aborted) throw new Error('Inbox request cancelled');
    const policies = inboxConfig(env())?.bots;
    const current = policies && Object.hasOwn(policies,alias) ? policies[alias] : undefined;
    if (snapshot === undefined || current === undefined || JSON.stringify(current) !== snapshot) throw new Error('Inbox receiver policy changed');
  };
}
