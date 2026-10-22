/** Conservative MTProto input and output boundary. Never serialize raw TL objects. */
export const SAFE_MTPROTO_METHODS = ["messages.getHistory", "messages.search", "bots.checkUsername"] as const;
export type SafeMethod = typeof SAFE_MTPROTO_METHODS[number];
export type SafeReadRequest = { method: "messages.getHistory" | "messages.search"; peer: string; limit: number; offsetId: number; query?: string };
export type SafeRequest = SafeReadRequest | { method: "bots.checkUsername"; username: string };

export function boundedInteger(value: unknown, name: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function peerName(value: unknown): string {
  // Deliberately accept primitive identifiers only. No user-supplied TL constructors.
  if (typeof value !== "string" || !/^(?:me|self|@?[A-Za-z][A-Za-z0-9_]{0,31}|-?[0-9]{1,20})$/.test(value)) {
    throw new Error("peer must be a username, me/self, or a decimal chat ID; nested TL objects and URLs are not supported");
  }
  return value;
}

export function searchQuery(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) throw new Error("query must be a string of at most 4096 characters");
  return value;
}

export function validateSafeRequest(method: string, args: Record<string, unknown>): SafeRequest {
  if (!SAFE_MTPROTO_METHODS.includes(method as SafeMethod)) {
    throw new Error("MTProto method is not in the supported read-only allowlist");
  }
  if (!args || typeof args !== "object" || Array.isArray(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) {
    throw new Error("MTProto params must be a plain object");
  }
  const allowed = method === "bots.checkUsername" ? ["username"]
    : method === "messages.search" ? ["peer", "q", "limit", "offsetId"] : ["peer", "limit", "offsetId"];
  if (Object.keys(args).some(key => !allowed.includes(key))) {
    throw new Error("MTProto params contain unsupported fields; method overrides and nested requests are not allowed");
  }
  if (method === "bots.checkUsername") {
    if (typeof args.username !== "string" || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(args.username)) throw new Error("Invalid bot username");
    return { method, username: args.username };
  }
  return {
    method: method as SafeReadRequest["method"], peer: peerName(args.peer),
    limit: boundedInteger(args.limit, "limit", 1, 100, 20),
    offsetId: boundedInteger(args.offsetId, "offsetId", 0, 2147483647, 0),
    ...(method === "messages.search" ? { query: searchQuery(args.q) } : {}),
  };
}

function read(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try { return (value as Record<string, unknown>)[key]; } catch { return undefined; }
}
function id(value: unknown): string | undefined {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return undefined;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint" && (!value || typeof value !== "object")) return undefined;
  try { const text = String(value); return /^-?[0-9]{1,40}$/.test(text) ? text : undefined; } catch { return undefined; }
}
// Keep complete selected strings until known credentials are redacted. Cutting first
// could leave an almost-complete credential prefix straddling a length boundary.
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function bool(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function integer(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined; }
function compact(value: Record<string, unknown>) { return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)); }

export function publicUser(value: unknown) {
  return compact({ id: id(read(value, "id")), username: text(read(value, "username")), firstName: text(read(value, "firstName")), lastName: text(read(value, "lastName")), bot: bool(read(value, "bot")), verified: bool(read(value, "verified")) });
}
export function publicMessage(value: unknown) {
  return compact({ id: id(read(value, "id")), date: integer(read(value, "date")), text: text(read(value, "message")), outgoing: bool(read(value, "out")), senderId: id(read(value, "senderId")), chatId: id(read(value, "chatId")), replyToMessageId: integer(read(read(value, "replyTo"), "replyToMsgId")) });
}
export function publicDialog(value: unknown) {
  return compact({ id: id(read(value, "id")), name: text(read(value, "name")), title: text(read(value, "title")), isUser: bool(read(value, "isUser")), isGroup: bool(read(value, "isGroup")), isChannel: bool(read(value, "isChannel")), unreadCount: integer(read(value, "unreadCount")) });
}

/** Defense in depth for known configured credentials, not arbitrary-message DLP. */
export function redactConfiguredSecrets(value: unknown, secrets: string[], depth = 0, field = ""): unknown {
  if (depth > 8) return undefined;
  if (typeof value === "string") {
    const clean = secrets.filter(Boolean).sort((a, b) => b.length - a.length).reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
    const max = field === "username" ? 64 : ["firstName", "lastName", "name", "title"].includes(field) ? 512 : 65536;
    return clean.slice(0, max);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(item => redactConfiguredSecrets(item, secrets, depth + 1, field));
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value))
      .filter(([key, descriptor]) => key !== "__proto__" && "value" in descriptor && descriptor.enumerable)
      .map(([key, descriptor]) => [key, redactConfiguredSecrets(descriptor.value, secrets, depth + 1, key)]));
  }
  // Do not invoke toJSON or serialize arbitrary TL class instances.
  return undefined;
}
