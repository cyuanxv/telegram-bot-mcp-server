export type BotConfig = { token: string; label?: string };
export type AccountConfig = { session: string; apiId?: number; apiHash?: string; label?: string };

function parseRegistry(name: string, env: Record<string, string | undefined>): Record<string, unknown> {
  const value = env[name];
  if (!value?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`Invalid JSON configuration in ${name}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} configuration must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function selectAlias<T>(registry: Record<string, T>, alias: string | undefined, kind: string): string {
  if (alias) return alias;
  if (Object.hasOwn(registry, "default")) return "default";
  const aliases = Object.keys(registry);
  if (aliases.length > 1) throw new Error(`Multiple ${kind} aliases are configured; specify an alias or configure default`);
  return aliases[0];
}

export function getBots(env: Record<string, string | undefined> = process.env): Record<string, BotConfig> {
  const raw = parseRegistry("TELEGRAM_BOTS_JSON", env);
  const bots: Record<string, BotConfig> = Object.create(null);
  for (const [alias, value] of Object.entries(raw)) {
    const config = typeof value === "string" ? { token: value } : value;
    if (!config || typeof config !== "object" || Array.isArray(config)
      || typeof (config as BotConfig).token !== "string" || !(config as BotConfig).token.trim()
      || ((config as BotConfig).label !== undefined && typeof (config as BotConfig).label !== "string")) {
      throw new Error(`Invalid bot configuration for alias ${alias}`);
    }
    bots[alias] = config as BotConfig;
  }
  if (env.TELEGRAM_BOT_TOKEN && !bots.default) {
    bots.default = { token: env.TELEGRAM_BOT_TOKEN, label: "Default bot" };
  }
  return bots;
}

export function getChats(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const chats = parseRegistry("TELEGRAM_CHATS_JSON", env);
  const out: Record<string, string> = Object.create(null);
  for (const [alias, value] of Object.entries(chats)) {
    if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === ""
      || (typeof value === "number" && !Number.isSafeInteger(value))) {
      throw new Error(`Invalid chat configuration for alias ${alias}`);
    }
    out[alias] = String(value);
  }
  if (env.TELEGRAM_CHAT_ID && !out.default) out.default = env.TELEGRAM_CHAT_ID;
  if (env.TELEGRAM_CHAT_ID && !out["demo-group"]) out["demo-group"] = env.TELEGRAM_CHAT_ID;
  return out;
}

export function resolveBot(alias?: string): { alias: string; config: BotConfig } {
  const bots = getBots();
  const key = selectAlias(bots, alias, "bot");
  if (!key || !Object.hasOwn(bots, key)) throw new Error(`Unknown bot alias: ${alias ?? "(default)"}`);
  if (!bots[key].token) throw new Error(`Bot alias ${key} has no token configured`);
  return { alias: key, config: bots[key] };
}

export function resolveChat(chat?: string | number): string {
  if (chat === undefined || chat === null || chat === "") {
    const chats = getChats();
    if (chats.default) return chats.default;
    if (chats["demo-group"]) return chats["demo-group"];
    throw new Error("No default Telegram chat is configured");
  }
  const value = String(chat);
  const chats = getChats();
  return Object.hasOwn(chats, value) ? chats[value] : value;
}

export function getAccounts(env: Record<string, string | undefined> = process.env): Record<string, AccountConfig> {
  const raw = parseRegistry("TELEGRAM_ACCOUNTS_JSON", env);
  const accounts: Record<string, AccountConfig> = Object.create(null);
  for (const [alias, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid account configuration for alias ${alias}`);
    const config = value as AccountConfig;
    if (typeof config.session !== "string" || (config.apiId !== undefined && (!Number.isSafeInteger(config.apiId) || config.apiId <= 0))
      || (config.apiHash !== undefined && typeof config.apiHash !== "string")
      || (config.label !== undefined && typeof config.label !== "string")) {
      throw new Error(`Invalid account configuration for alias ${alias}`);
    }
    accounts[alias] = config;
  }
  return accounts;
}

export function resolveAccount(alias?: string): { alias: string; config: AccountConfig } {
  const accounts = getAccounts();
  const key = selectAlias(accounts, alias, "account");
  if (!key || !Object.hasOwn(accounts, key)) throw new Error(`Unknown Telegram account alias: ${alias ?? "(default)"}`);
  const config = accounts[key];
  const apiId = config.apiId ?? Number(process.env.TELEGRAM_API_ID || 0);
  const apiHash = config.apiHash ?? process.env.TELEGRAM_API_HASH;
  if (!config.session.trim() || !Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash?.trim()) throw new Error(`Telegram account ${key} is missing valid session/apiId/apiHash`);
  return { alias: key, config: { ...config, apiId, apiHash } };
}
