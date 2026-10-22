import {draftConfiguration} from './draft-configuration';
import {loadVaultKeyring} from './vault/keyring';
import { getBots, getChats, getAccounts } from "./config";
import { inboxConfig } from "./inbox/config";
import { postgresConnectionConfig } from "./delivery/postgres-config";

type Environment = Record<string, string | undefined>;

// Report only fixed labels, counts and booleans. Configuration errors may contain
// attacker-controlled aliases or secret values, so never include their messages.
function registryCheck(read: () => Record<string, unknown>) {
  try {
    const count = Object.keys(read()).length;
    return { status: count ? "configured" : "missing", count };
  } catch { return { status: "invalid", count: null }; }
}

/** No network, database queries, environment writes or credentials in the result. */
export function configurationStatus(env: Environment = process.env) {
  const bots = registryCheck(() => getBots(env));
  const chats = registryCheck(() => getChats(env));
  const accounts = registryCheck(() => getAccounts(env));
  let completeAccounts: number | null = null;
  if (accounts.status !== "invalid") {
    completeAccounts = Object.values(getAccounts(env)).filter(a => {
      const id = a.apiId ?? Number(env.TELEGRAM_API_ID || 0);
      return a.session.trim() && Number.isSafeInteger(id) && id > 0 && (a.apiHash ?? env.TELEGRAM_API_HASH)?.trim();
    }).length;
  }
  let database = "disabled";
  if (env.TELEGRAM_DELIVERY_POSTGRES_ENABLED === "true") {
    try { postgresConnectionConfig(env); database = "configuration_valid"; }
    catch { database = "configuration_invalid"; }
  }
  let inbox: { status: string; bot_count: number | null; callback_bot_count: number | null } = {
    status: "disabled", bot_count: 0, callback_bot_count: 0,
  };
  if (env.TELEGRAM_WEBHOOK_ENABLED === "true") {
    try {
      const policies = inboxConfig(env)!.bots;
      const configuredBots = getBots(env);
      inbox = {
        status: Object.keys(policies).every(alias => Object.hasOwn(configuredBots, alias)) ? "configuration_valid" : "bot_not_configured",
        bot_count: Object.keys(policies).length,
        callback_bot_count: Object.values(policies).filter(p => p.acceptCallbacks === true).length,
      };
    } catch { inbox = { status: "configuration_invalid", bot_count: null, callback_bot_count: null }; }
  }
  const enrollment=env.TELEGRAM_BOT_ENROLLMENT_ENABLED==='true',management=env.TELEGRAM_BOT_MANAGEMENT_ENABLED==='true';
  const auth=env.TELEGRAM_BOT_ENROLLMENT_AUTH;
  const authValid=typeof auth==='string'&&auth.length>=32&&auth.length<=256;
  let keyValid=false;try{const ring=loadVaultKeyring(env);ring.dispose();keyValid=true}catch{}
  const vaultValid=keyValid&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(env.TELEGRAM_VAULT_KEY_ID??'')&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(env.TELEGRAM_VAULT_OWNER_ID??'');
  return {
    check: "configuration_only",
    bots, chats, accounts: { ...accounts, complete_count: completeAccounts },
    database: { status: database, connectivity: "not_checked", schema: "not_checked", permissions: "not_checked" },
    inbox, drafts:draftConfiguration(env),
    switches: {
      workflow: env.TELEGRAM_WORKFLOW_MCP_ENABLED === "true",
      report_dispatch: env.TELEGRAM_DELIVERY_ALLOW_DISPATCH === "true",
      inbox_read: env.TELEGRAM_INBOX_MCP_ENABLED === "true",
      callback_send: env.TELEGRAM_CALLBACK_SEND_ENABLED === "true",
      callback_answer: env.TELEGRAM_CALLBACK_ANSWER_ENABLED === "true",
      rich_messages: env.TELEGRAM_RICH_MESSAGES_ENABLED === "true",
      media_bytes: env.TELEGRAM_MEDIA_BYTES_ENABLED === "true",
      media_deduplication: env.TELEGRAM_MEDIA_DEDUP_ENABLED === "true",
      personal_accounts: env.TELEGRAM_MTPROTO_ENABLED === "true",
    },
    onboarding: {
      mode: enrollment||management?"private_bot_management":"cloud_environment_configuration",
      backend_entry_configured: enrollment&&management&&authValid&&vaultValid&&database==='configuration_valid',
      enrollment_enabled:enrollment,management_enabled:management,
      server_auth:authValid?"configuration_valid":"configuration_invalid",
      vault:vaultValid?"configuration_valid":"configuration_invalid",
      runtime_bots_enabled:env.TELEGRAM_VAULT_BOTS_ENABLED==='true',
      persistent_scope_enabled:env.TELEGRAM_VAULT_SCOPE_STORE_ENABLED==='true',
      web_entry:"not_checked",live_acceptance:"not_checked",
    },
    note: "Configuration and switches do not prove credentials, destination permissions, webhook registration, storage schema or delivery. No feature was enabled and no message was sent.",
    requires_local_computer: false,
  };
}
