import { BotApiError, callBotApi } from "../bot-api";
import { getBots, resolveBot } from "../config";
import { validateContext } from "../vault/crypto";
import { assertVaultBotScope } from "../vault/bot-scope";
import { DefiniteRejection, type DeliveryTransport, type TransportRequest } from "./types";

/** Opt-in adapter. Constructing it does not send; ReportQueue dispatch must be explicitly called. */
export class BotApiDeliveryTransport implements DeliveryTransport {
  private signal?: AbortSignal;
  constructor(signal?: AbortSignal) { this.signal = signal; }
  validateConfiguration(target: { botAlias: string; chatId: string; threadId?:number }) {
    try {
      if (Object.hasOwn(getBots(), target.botAlias)) resolveBot(target.botAlias);
      else {
        // Local configuration only: activation and saved permissions are checked
        // by callBotApi's runtime resolver immediately before the actual send.
        if (process.env.TELEGRAM_VAULT_BOTS_ENABLED !== "true") throw new Error("disabled");
        validateContext({ownerId: process.env.TELEGRAM_VAULT_OWNER_ID!, alias: target.botAlias, purpose: "bot_token"});
        assertVaultBotScope(target.botAlias, "sendMessage", {chat_id: target.chatId, ...(target.threadId === undefined ? {} : {message_thread_id: target.threadId})});
      }
    }
    catch { throw new Error("Selected bot is not configured correctly; no delivery was attempted"); }
  }
  async send(request: TransportRequest) {
    try {
      const response = await callBotApi(request.botAlias, "sendMessage", { chat_id: request.chatId, text: request.text, ...(request.threadId===undefined?{}:{message_thread_id:request.threadId}) }, {}, { signal: this.signal });
      const result = response.result as { message_id?: unknown; message_thread_id?:unknown; chat?: { id?: unknown } } | undefined;
      const id = result?.chat?.id;
      if (!Number.isSafeInteger(result?.message_id) || (typeof id !== "number" && typeof id !== "string")
        || (typeof id === "number" && !Number.isSafeInteger(id)) || String(id) !== request.chatId || (request.threadId!==undefined&&result?.message_thread_id!==request.threadId)) {
        throw new Error("Delivery response did not contain a matching receipt");
      }
      return { chatId: String(id), messageId: result!.message_id as number, ...(request.threadId===undefined?{}:{threadId:request.threadId}) };
    } catch (error) {
      if (error instanceof BotApiError && error.details.delivery_unknown === false) {
        // The shared Bot API layer omits malformed hints. An omitted hint therefore
        // cannot safely select a shorter fallback wait; refuse retry eligibility.
        const delay = error.details.retry_after_seconds;
        const retryable = error.details.code === "rate_limited" && Number.isSafeInteger(delay) && delay! >= 0;
        throw new DefiniteRejection(retryable ? "rate_limited" : "rejected", retryable ? delay : undefined);
      }
      // Never surface raw responses, provider descriptions or credentials to the ledger.
      throw new Error("Telegram delivery outcome is unknown");
    }
  }
}
