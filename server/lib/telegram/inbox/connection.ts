import { callInboxControl } from "../bot-api";
import { inboxEndpoint, inboxRegistrationParameters } from "./control-policy";
import { inboxConfig } from "./config";

type Env = Record<string, string | undefined>;
type Caller = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const productionCall: Caller = (method, params) => callInboxControl("default", method, params);

function info(value: unknown, alias: string) {
  const envelope = value as { bot?: string; result?: { url?: unknown; pending_update_count?: unknown } };
  if (!envelope || envelope.bot !== alias || typeof envelope.result?.url !== "string") throw new Error("Invalid webhook status response");
  return envelope.result as { url: string; pending_update_count?: unknown; last_error_date?: unknown; last_error_message?: unknown; allowed_updates?: unknown };
}
/** Read-only diagnostics. Never returns the existing webhook URL or token. */
export async function inspectBotInbox(alias: string, call: Caller = (method, params) => callInboxControl(alias, method, params), settings: Env = process.env) {
  const endpoint = inboxEndpoint(alias,settings);
  const current = info(await call("getWebhookInfo", {}), alias);
  return { destination: alias, webhook: current.url === "" ? "absent" : current.url === endpoint ? "this_service" : "other_service",
    ...(Array.isArray(current.allowed_updates) ? {allowed_updates:current.allowed_updates.filter(x=>typeof x==='string' && /^[a-z_]{1,64}$/.test(x))} : {}),
    pending_updates: Number.isSafeInteger(current.pending_update_count) && Number(current.pending_update_count) >= 0 ? current.pending_update_count : null,
    // Telegram reports the last error, not necessarily a currently active failure.
    // Do not return raw provider text: it can contain an endpoint or other details.
    delivery_error_recorded: (typeof current.last_error_message === "string" && current.last_error_message.length > 0) || (Number.isSafeInteger(current.last_error_date) && Number(current.last_error_date) > 0),
    last_delivery_error_at_unix_seconds: Number.isSafeInteger(current.last_error_date) && Number(current.last_error_date) > 0 ? current.last_error_date : null };
}
export async function inspectDefaultInbox(call: Caller = productionCall) { return inspectBotInbox("default", call); }
/** Called only after user approval. Existing webhooks are never replaced. */
export async function connectBotInbox(alias: string, env: () => Env = () => process.env, call: Caller = (method, params) => callInboxControl(alias, method, params, { signal }), signal?: AbortSignal) {
  const initialEnv = { ...env() }, endpoint = inboxEndpoint(alias,initialEnv);
  const guard = () => {
    if (signal?.aborted) throw new Error("Inbox setup cancelled; inspect before retrying");
    const current = env();
    if (Object.keys({...initialEnv,...current}).filter(k => k.startsWith('TELEGRAM_')).some(k => initialEnv[k] !== current[k])) throw new Error("Inbox configuration changed; inspect before retrying");
  };
  const policy = () => {
    const policies = inboxConfig(env())?.bots;
    const configured = policies && Object.hasOwn(policies, alias) ? policies[alias] : undefined;
    if (!configured) throw new Error("Inbox receiver must be configured before registration");
    return configured;
  };
  const initial = policy(); guard();
  const existing = await inspectBotInbox(alias, call,env());
  guard();
  if (existing.webhook === "this_service" && initialEnv.TELEGRAM_INBOX_SYNC_APPROVED_UPDATES === "true") {
    const expected = inboxRegistrationParameters(alias, initialEnv);
    const current = info(await call("getWebhookInfo", {}), alias); guard();
    if (current.url !== endpoint) throw new Error("Webhook changed before subscription sync");
    if (!Array.isArray(current.allowed_updates)) return {...existing,changed:false,status:"subscriptions_unknown_preserved"};
    const wanted = expected.allowed_updates;
    if (current.allowed_updates.some(x => typeof x !== "string" || !wanted.includes(x))) return {...existing,changed:false,status:"subscriptions_outside_policy_preserved",allowed_updates:current.allowed_updates.filter(x=>typeof x==='string' && /^[a-z_]{1,64}$/.test(x))};
    if (wanted.some(x => !(current.allowed_updates as unknown[]).includes(x))) {
      const result = await call("setWebhook", expected); guard();
      if ((result as {bot?:string})?.bot !== alias || (result as {result?:boolean}).result !== true) throw new Error("Subscription sync unconfirmed; inspect before retrying");
      const checked = info(await call("getWebhookInfo", {}), alias); guard();
      return {...existing, changed:true, status:checked.url === endpoint && Array.isArray(checked.allowed_updates) && wanted.every(x => (checked.allowed_updates as unknown[]).includes(x)) ? "subscriptions_synced" : "subscription_sync_unconfirmed"};
    }
  }
  if (existing.webhook !== "absent") return { ...existing, changed: false, status: "existing_webhook_preserved" };
  if (existing.pending_updates !== 0) return { ...existing, changed: false, status: "pending_updates_require_review" };
  const live = policy();
  if (JSON.stringify(live) !== JSON.stringify(initial)) throw new Error("Inbox policy changed during setup");
  // Telegram provides no compare-and-set for webhooks. Inspection and registration
  // are consecutive; operators must not configure this bot concurrently elsewhere.
  guard();
  const result = await call("setWebhook", inboxRegistrationParameters(alias, initialEnv));
  if ((result as { bot?: string })?.bot !== alias || (result as { result?: boolean }).result !== true) throw new Error("Webhook registration not confirmed; inspect before retrying");
  guard();
  const confirmed = await inspectBotInbox(alias, call,env()); guard();
  return { ...confirmed, changed: true, status: confirmed.webhook === "this_service" ? "registered" : "registration_unconfirmed" };
}

export async function connectDefaultInbox(env: () => Env = () => process.env, call: Caller = productionCall) {
  return connectBotInbox("default", env, call);
}
