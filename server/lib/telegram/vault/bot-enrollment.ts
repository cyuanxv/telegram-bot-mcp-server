import {loadVaultKeyring} from './keyring';
import { createHash, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import { getBots } from "../config";
import { readBotApiJson } from "../bot-api";
import { postgresConnectionConfig } from "../delivery/postgres-config";
import { PgPoolDatabase } from "../delivery/pg-pool-adapter";
import { PostgresCredentialVault } from "./postgres-vault";
import { sealCredential, openCredential, validateContext, VaultError, type SealedCredential } from "./crypto";

type Env = Record<string, string | undefined>;
type Resource = { vault: Pick<PostgresCredentialVault, "loadSealed" | "save">; close(): Promise<void> };
type Dependencies = { env?: () => Env; fetcher?: typeof fetch; open?: (env: Env, guard: () => void) => Promise<Resource> };
const json = (status: number, data: unknown) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const equal = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
async function openStore(env: Env, guard: () => void): Promise<Resource> {
  guard(); const pool = new Pool(postgresConnectionConfig(env));
  return { vault: new PostgresCredentialVault(new PgPoolDatabase(pool, { guard })), close: () => pool.end() };
}

/** Private server-to-server endpoint, never an MCP tool. Staging does not activate a Bot. */
export async function enrollBot(request: Request, dependencies: Dependencies = {}) {
  const env = dependencies.env ?? (() => process.env), snapshot = { ...env() };
  if (snapshot.TELEGRAM_BOT_ENROLLMENT_ENABLED !== "true") return json(503, { status: "enrollment_disabled" });
  if (request.method !== "POST") return json(405, { status: "method_not_allowed" });
  const auth = snapshot.TELEGRAM_BOT_ENROLLMENT_AUTH;
  if (!auth || auth.length < 32 || auth.length > 256) return json(503, { status: "enrollment_auth_not_configured" });
  const supplied = request.headers.get("authorization");
  if (!supplied || supplied.length > 4096 || !equal(supplied, `Bearer ${auth}`)) return json(401, { status: "unauthorized" });
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return json(415, { status: "json_required" });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
  let body: Record<string, unknown>;
  try {
    const value = await readBotApiJson(new Response(request.body), signal, 8192);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
    body = value as Record<string, unknown>;
    const allowed = body.action === "inspect" ? ["action", "token"] : ["action", "token", "alias", "expected_bot_id", ...(body.action === "rotate" ? ["expected_revision", "confirm"] : [])];
    if (!["inspect", "stage", "rotate"].includes(String(body.action)) || Object.keys(body).some(k => !allowed.includes(k))
      || typeof body.token !== "string" || !/^[1-9][0-9]{0,15}:[A-Za-z0-9_-]{20,128}$/.test(body.token)) throw Error();
    if (body.action !== "inspect" && (typeof body.alias !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(body.alias)
      || !Number.isSafeInteger(body.expected_bot_id) || (body.expected_bot_id as number) <= 0)) throw Error();
    if (body.action === "rotate" && (body.confirm !== "replace_token" || !Number.isSafeInteger(body.expected_revision) || (body.expected_revision as number) < 1 || (body.expected_revision as number) >= Number.MAX_SAFE_INTEGER)) throw Error();
  } catch { return json(400, { status: "invalid_request" }); }
  const token = body.token as string;
  const guard = () => {
    const current = env();
    if (signal.aborted || Object.keys({ ...snapshot, ...current }).filter(k => k.startsWith("TELEGRAM_")).some(k => current[k] !== snapshot[k])) throw Error("configuration_changed");
  };
  try { guard(); } catch { return json(409, { status: "configuration_changed" }); }
  let id: number, username: string;
  try {
    const response = await (dependencies.fetcher ?? fetch)(`https://api.telegram.org/bot${token}/getMe`, {
      method: "POST", body: "{}", headers: { "content-type": "application/json" }, redirect: "error", cache: "no-store", signal,
    });
    const data = await readBotApiJson(response, signal, 32768) as { ok?: unknown; result?: { id?: unknown; is_bot?: unknown; username?: unknown } };
    if (!response.ok || data?.ok !== true || data.result?.is_bot !== true || !Number.isSafeInteger(data.result.id) || (data.result.id as number) <= 0
      || typeof data.result.username !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(data.result.username)) throw Error();
    id = data.result.id as number; username = data.result.username;
    if (String(id) !== token.split(":")[0]) throw Error();
    guard();
  } catch { return json(502, { status: "bot_verification_failed", retry_automatically: false }); }
  if (body.action === "inspect") return json(200, { status: "identity_verified", bot_id: id, username, saved: false, activated: false });
  if (id !== body.expected_bot_id) return json(409, { status: "bot_identity_mismatch", saved: false });
  const context = { ownerId: snapshot.TELEGRAM_VAULT_OWNER_ID!, alias: body.alias as string, purpose: "bot_token" as const };
  let keyring:ReturnType<typeof loadVaultKeyring>|undefined;
  try {
    validateContext(context);
    if (Object.hasOwn(getBots(snapshot), context.alias)) return json(409, { status: "alias_in_use", saved: false });
    keyring=loadVaultKeyring(snapshot);
  } catch { keyring?.dispose(); return json(503, { status: "vault_configuration_invalid", saved: false }); }
  let resource: Resource | undefined;
  let attemptedSave = false;
  try {
    guard(); resource = await (dependencies.open ?? openStore)(snapshot, guard); guard();
    const keys = keyring!.keys;
    const existing: SealedCredential | undefined = await resource.vault.loadSealed(context); guard();
    if (body.action === "rotate") {
      if (!existing) return json(404, { status: "bot_not_staged", saved: false });
      if (existing.revision !== body.expected_revision) return json(409, { status: "state_changed", saved: false });
      const stored = openCredential(context, existing, keys, Date.now());
      if (!("token" in stored) || stored.token.split(":")[0] !== String(id)) return json(409, { status: "bot_identity_mismatch", saved: false });
      if (equal(stored.token, token)) return json(409, { status: "token_unchanged", saved: false });
      const revision = existing.revision + 1;
      const envelope = sealCredential(context, { token }, keys, snapshot.TELEGRAM_VAULT_KEY_ID!, { revision, createdAt: Date.now() });
      guard(); attemptedSave = true; await resource.vault.save(envelope, existing.revision); guard();
      // Directory joins bind the prior credential revision. No implicit reactivation.
      return json(200, { status: "token_replaced", bot_id: id, username, alias: context.alias, revision, activated: false, requires_reactivation: true });
    }
    if (existing) {
      const stored = openCredential(context, existing, keys, Date.now());
      if (!("token" in stored) || !equal(stored.token, token)) return json(409, { status: "alias_in_use", saved: false });
      return json(200, { status: "staged", bot_id: id, username, alias: context.alias, revision: existing.revision, reused: true, activated: false });
    }
    const envelope = sealCredential(context, { token }, keys, snapshot.TELEGRAM_VAULT_KEY_ID!, { revision: 1, createdAt: Date.now() });
    guard(); attemptedSave = true; await resource.vault.save(envelope, 0); guard();
    return json(200, { status: "staged", bot_id: id, username, alias: context.alias, revision: 1, reused: false, activated: false });
  } catch (error) { if (error instanceof VaultError && error.code === "revision_conflict") return json(409, { status: "state_changed", retry_automatically: false }); return json(503, { status: attemptedSave ? "storage_unconfirmed" : "storage_unavailable", retry_automatically: false }); }
  finally { keyring?.dispose(); try { await resource?.close(); } catch { /* Never expose driver errors or turn a committed save into a repeat. */ } }
}
