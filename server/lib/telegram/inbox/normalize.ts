import { createHash } from "node:crypto";
import { MESSAGE_UPDATE_TYPES, type BotInboxPolicy, type InboxEvent, type MessageUpdateType } from "./types";
const MIN_I64 = -(1n << 63n), MAX_I64 = (1n << 63n) - 1n;
/** Never convert an unsafe JSON number into an apparently precise ID. Decimal strings preserve 64-bit IDs. */
export function decimalId(value: unknown, kind: "chat" | "positive" | "nonnegative" = "positive"): string {
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw new Error("Unsafe numeric ID"); value = String(value); }
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]{0,18})$/.test(value) || value === "-0") throw new Error("Invalid decimal ID");
  const n = BigInt(value);
  if (n < MIN_I64 || n > MAX_I64 || (kind === "positive" && n <= 0n) || (kind === "chat" && n === 0n) || (kind === "nonnegative" && n < 0n)) throw new Error("Out-of-range ID");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid update object");
  return value as Record<string, unknown>;
}
export function normalizedUpdate(raw: unknown, botAlias: string, policy: BotInboxPolicy, now: number): InboxEvent | undefined {
  const update = object(raw); const updateId = decimalId(update.update_id, "nonnegative");
  const kinds = MESSAGE_UPDATE_TYPES.filter(kind => Object.hasOwn(update, kind));
  if (kinds.length === 0) return undefined;
  if (kinds.length !== 1) throw new Error("Ambiguous update type");
  const updateType: MessageUpdateType = kinds[0];
  if (updateType === "callback_query") return normalizeCallback(update, botAlias, policy, now, updateId);
  const message = object(update[updateType]);
  const chatId = decimalId(object(message.chat).id, "chat");
  if (!policy.allowedChatIds.includes(chatId)) return undefined;
  const businessConnectionId = message.business_connection_id === undefined ? undefined : checkedConnection(message.business_connection_id);
  if (updateType.includes("business") && businessConnectionId === undefined) throw new Error("Missing Business connection ID");
  if (businessConnectionId !== undefined && !policy.allowedBusinessConnectionIds?.includes(businessConnectionId)) return undefined;
  const messageId = decimalId(message.message_id);
  if (!Number.isSafeInteger(message.date) || (message.date as number) < 0) throw new Error("Invalid message timestamp");
  const value = message.text ?? message.caption;
  if (value !== undefined && (typeof value !== "string" || value.length > 16384 || !value.isWellFormed())) throw new Error("Unsupported message text");
  const body = {
    version: 1 as const, botAlias, updateId, updateType, chatId, messageId, messageDate: message.date as number,
    ...(message.from === undefined ? {} : { senderId: decimalId(object(message.from).id) }),
    ...(message.sender_chat === undefined ? {} : { senderChatId: decimalId(object(message.sender_chat).id, "chat") }),
    ...(businessConnectionId === undefined ? {} : { businessConnectionId }),
    ...(policy.retainText && value !== undefined ? { text: value as string } : {}),
  };
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_000_000_000_000_000) throw new Error("Invalid inbox clock");
  return { ...body, fingerprint: eventFingerprint(body), receivedAt: now, expiresAt: now + policy.retentionDays * 86400000 };
}
function checkedConnection(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new Error("Invalid business connection ID");
  return value;
}
export function validateInboxEvent(event: InboxEvent) {
  if (event?.version !== 1 || typeof event.botAlias !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(event.botAlias)
    || !MESSAGE_UPDATE_TYPES.includes(event.updateType) || !/^[a-f0-9]{64}$/.test(event.fingerprint)
    || !Number.isSafeInteger(event.messageDate) || event.messageDate < 0
    || !Number.isSafeInteger(event.receivedAt) || !Number.isSafeInteger(event.expiresAt)
    || event.receivedAt < 0 || event.expiresAt <= event.receivedAt || event.expiresAt - event.receivedAt > 30 * 86400000) throw new Error("Invalid inbox event");
  decimalId(event.updateId, "nonnegative"); decimalId(event.chatId, "chat"); decimalId(event.messageId);
  if (event.senderId !== undefined) decimalId(event.senderId);
  if (event.senderChatId !== undefined) decimalId(event.senderChatId, "chat");
  if (event.businessConnectionId !== undefined) checkedConnection(event.businessConnectionId);
  if (event.text !== undefined && (typeof event.text !== "string" || event.text.length > 16384 || !event.text.isWellFormed())) throw new Error("Invalid inbox text");
  if (Object.keys(event).some(key => !["version", "botAlias", "updateId", "updateType", "chatId", "messageId", "messageDate", "senderId", "senderChatId", "businessConnectionId", "callbackQueryId", "text", "fingerprint", "receivedAt", "expiresAt"].includes(key))) throw new Error("Unsupported inbox event field");
  for (const key of ["updateId", "chatId", "messageId", "senderId", "senderChatId"] as const) {
    if (event[key] !== undefined && typeof event[key] !== "string") throw new Error("Stored IDs must be exact strings");
  }
  if (event.updateType === "callback_query") {
    callbackId(event.callbackQueryId);
    if (event.senderId === undefined || event.senderChatId !== undefined || event.businessConnectionId !== undefined) throw new Error("Invalid callback event");
    if (event.text !== undefined) callbackText(event.text);
  } else if (event.callbackQueryId !== undefined) throw new Error("Unexpected callback ID");
  if (eventFingerprint(event) !== event.fingerprint) throw new Error("Inbox fingerprint mismatch");
}

function eventFingerprint(e: Omit<InboxEvent, "fingerprint" | "receivedAt" | "expiresAt">) {
  // Explicit canonical field order survives PostgreSQL JSONB key reordering.
  const body = { version: e.version, botAlias: e.botAlias, updateId: e.updateId, updateType: e.updateType,
    chatId: e.chatId, messageId: e.messageId, messageDate: e.messageDate,
    ...(e.senderId === undefined ? {} : { senderId: e.senderId }),
    ...(e.senderChatId === undefined ? {} : { senderChatId: e.senderChatId }),
    ...(e.businessConnectionId === undefined ? {} : { businessConnectionId: e.businessConnectionId }),
    ...(e.callbackQueryId === undefined ? {} : { callbackQueryId: e.callbackQueryId }),
    ...(e.text === undefined ? {} : { text: e.text }) };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function callbackId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || !value.isWellFormed() || /[\u0000-\u0020\u007f]/.test(value)) throw new Error("Invalid callback ID");
  return value;
}
function callbackText(value: unknown): string {
  if (typeof value !== "string" || !value.isWellFormed() || Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 64) throw new Error("Invalid callback data");
  return value;
}
/** Callback payload is untrusted text, never an instruction or authorization. */
function normalizeCallback(update: Record<string, unknown>, botAlias: string, policy: BotInboxPolicy, now: number, updateId: string): InboxEvent | undefined {
  if (policy.acceptCallbacks !== true) return undefined;
  const query = object(update.callback_query);
  // Inline-mode/game/Business callbacks need separately designed scope handling.
  if (query.message === undefined || query.inline_message_id !== undefined || query.game_short_name !== undefined) return undefined;
  const message = object(query.message), chatId = decimalId(object(message.chat).id, "chat");
  if (!policy.allowedChatIds.includes(chatId) || message.business_connection_id !== undefined) return undefined;
  const messageId = decimalId(message.message_id), senderId = decimalId(object(query.from).id);
  const callbackQueryId = callbackId(query.id), data = callbackText(query.data);
  if (!Number.isSafeInteger(message.date) || (message.date as number) < 0) throw new Error("Invalid message timestamp");
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_000_000_000_000_000) throw new Error("Invalid inbox clock");
  const body = { version: 1 as const, botAlias, updateId, updateType: "callback_query" as const, chatId, messageId, messageDate: message.date as number,
    senderId, callbackQueryId, ...(policy.retainText ? { text: data } : {}) };
  return { ...body, fingerprint: eventFingerprint(body), receivedAt: now, expiresAt: now + policy.retentionDays * 86400000 };
}
