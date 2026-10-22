import { createHash, timingSafeEqual } from "node:crypto";
import { normalizedUpdate } from "./normalize";
import type { InboxConfig, InboxStore } from "./types";
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
export const WEBHOOK_BODY_TIMEOUT_MS = 5000;
class InputError extends Error { status: number; constructor(status: number) { super("Invalid webhook request"); this.status = status; } }
function response(status: number, code: string) { return Response.json({ ok: status === 200, status: code }, { status, headers: { "cache-control": "no-store" } }); }
export function webhookSecretMatches(supplied: string | null, expected: string) {
  if (supplied === null || supplied.length > 256 || !/^[A-Za-z0-9_-]*$/.test(supplied)) return false;
  return timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(expected).digest());
}
export async function readWebhookBody(request: Request, limit = MAX_WEBHOOK_BYTES, deadlineMs = WEBHOOK_BODY_TIMEOUT_MS): Promise<unknown> {
  if (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity") throw new InputError(415);
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get("content-type") || "")) throw new InputError(415);
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > limit)) throw new InputError(413);
  const reader = request.body?.getReader(); if (!reader) throw new InputError(400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new InputError(408)), deadlineMs); });
  try {
    const chunks: Uint8Array[] = []; let bytes = 0, chunkReads = 0;
    while (true) {
      const part = await Promise.race([reader.read(), timedOut]); if (part.done) break;
      if (++chunkReads > 8192) throw new InputError(413);
      if (!(part.value instanceof Uint8Array)) throw new InputError(400);
      bytes += part.value.byteLength; if (bytes > limit) throw new InputError(413); chunks.push(part.value);
    }
    const buffer = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer), (key, value, context?: { source?: string }) => {
        // Node 24 exposes each original primitive token. Inspect before Number rounding
        // can turn a fractional/exponent ID into an apparently safe integer.
        if (typeof value === "number" && ["id", "update_id", "message_id"].includes(key)) {
          if (!context?.source || !/^-?(?:0|[1-9][0-9]*)$/.test(context.source)) throw new InputError(400);
          return context.source;
        }
        if (typeof value === "number" && ["date", "total_amount", "subscription_expiration_date"].includes(key)) {
          if (!context?.source || !/^(?:0|[1-9][0-9]*)$/.test(context.source) || !Number.isSafeInteger(value)) throw new InputError(400);
        }
        return value;
      });
    } catch { throw new InputError(400); }
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
/** Webhook authentication and parsing precede the optional payment handler. Each handler enforces its own scope before opening storage. */
export async function handleWebhook(request: Request, botAlias: string, config: InboxConfig | undefined,
  openStore: () => Promise<{ store: InboxStore; close: () => void | Promise<void> }>, now = Date.now(), paymentHandler?: (update: unknown) => Promise<Response | undefined>, guard: () => void = () => {}) {
  if (!config) return response(503, "receiver_disabled");
  if (request.method !== "POST") return response(405, "method_not_allowed");
  const policy = Object.hasOwn(config.bots, botAlias) ? config.bots[botAlias] : undefined;
  if (!policy || !webhookSecretMatches(request.headers.get("x-telegram-bot-api-secret-token"), policy.secretToken)) return response(401, "unauthorized");
  try { guard(); } catch { return response(503, "receiver_policy_changed"); }
  let event, update;
  try { update = await readWebhookBody(request); }
  catch (error) { return response(error instanceof InputError ? error.status : 400, "invalid_update"); }
  try { guard(); } catch { return response(503, "receiver_policy_changed"); }
  if (paymentHandler) {
    try { const handled = await paymentHandler(update); if (handled) return handled; }
    catch { return response(503, "payment_handler_unavailable"); }
  }
  try { guard(); } catch { return response(503, "receiver_policy_changed"); }
  try { event = normalizedUpdate(update, botAlias, policy, now); }
  catch (error) { return response(error instanceof InputError ? error.status : 400, "invalid_update"); }
  if (!event) return response(200, "ignored");
  let resource: Awaited<ReturnType<typeof openStore>> | undefined;
  try {
    guard(); resource = await openStore(); guard(); const result = await resource.store.record(event);
    return response(result === "conflict" ? 409 : 200, result);
  } catch { return response(503, "storage_unavailable"); }
  finally { try { await resource?.close(); } catch { /* No provider error or payload is logged. */ } }
}
