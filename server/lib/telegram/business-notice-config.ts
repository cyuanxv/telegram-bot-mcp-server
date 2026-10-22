import { getBots } from './config';
type Env = Record<string,string|undefined>;
/** Static bots only until Business permissions have their own vault scope. */
export function businessNoticeEnabled(alias: string, env: Env): boolean {
  if (env.TELEGRAM_BUSINESS_NOTICES_ENABLED !== 'true') return false;
  try {
    if (!Object.hasOwn(getBots(env),alias)) return false;
    const aliases: unknown = JSON.parse(env.TELEGRAM_BUSINESS_NOTICE_BOTS_JSON ?? 'null');
    return Array.isArray(aliases) && aliases.length > 0 && aliases.length <= 25
      && aliases.every(a => typeof a === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(a))
      && new Set(aliases).size === aliases.length && aliases.includes(alias);
  } catch { return false; }
}
