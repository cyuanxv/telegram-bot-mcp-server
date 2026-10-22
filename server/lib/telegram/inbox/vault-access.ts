import { getBots } from '../config';
import type { SqlExecutor } from '../delivery/postgres-store';
import { validateBotScope } from '../vault/bot-scope';
import { validateContext } from '../vault/crypto';

type Env = Record<string, string | undefined>;
export type InboxAuthorizer = (sql: SqlExecutor, alias: string, chatIds: string[]) => Promise<(() => void) | void>;
const denied = () => { throw new Error('Inbox Bot is not active in the approved scope'); };
const positive = (n: unknown) => Number.isSafeInteger(Number(n)) && Number(n) > 0;
/** The caller separately enforces approved retention/receiver policy. Lock only
 * metadata, never decrypt a token. Locks stay held through inbox read/commit so
 * a completed directory revocation takes effect for subsequent transactions. */
export function authorizeInboxBot(env: () => Env = () => process.env, now: () => number = Date.now): InboxAuthorizer {
  return async (sql, alias, chatIds) => {
    const snapshot = { ...env() };
    if (Object.hasOwn(getBots(snapshot), alias)) return;
    const guard = () => {
      const current = env();
      if (snapshot.TELEGRAM_VAULT_BOTS_ENABLED !== 'true' || snapshot.TELEGRAM_VAULT_SCOPE_STORE_ENABLED !== 'true'
        || Object.keys({...snapshot,...current}).filter(k => k.startsWith('TELEGRAM_')).some(k => snapshot[k] !== current[k])) denied();
    };
    guard();
    const owner = snapshot.TELEGRAM_VAULT_OWNER_ID!;
    validateContext({ownerId:owner,alias,purpose:'bot_token'});
    // Lock vault first: permission edits/rotation take its exclusive lock. Activation
    // shares it, then locks scope and directory in this same order.
    const vault = (await sql.query("SELECT revision,envelope->'expiresAt' AS expires_at FROM public.telegram_credential_vault WHERE owner_id=$1 AND alias=$2 AND purpose='bot_token' FOR SHARE", [owner,alias])).rows[0];
    const scope = (await sql.query('SELECT bot_id,vault_revision,revision,policy FROM public.telegram_bot_scope WHERE owner_id=$1 AND alias=$2 FOR SHARE', [owner,alias])).rows[0];
    const directory = (await sql.query('SELECT bot_id,vault_revision,scope_revision,active FROM public.telegram_bot_directory WHERE owner_id=$1 AND alias=$2 FOR SHARE', [owner,alias])).rows[0];
    if (!vault || !scope || !directory || directory.active !== true
      || ![vault.revision,scope.bot_id,scope.vault_revision,scope.revision,directory.bot_id,directory.vault_revision,directory.scope_revision].every(positive)
      || Number(vault.revision) !== Number(directory.vault_revision) || Number(scope.vault_revision) !== Number(vault.revision)
      || Number(scope.bot_id) !== Number(directory.bot_id) || Number(scope.revision) !== Number(directory.scope_revision)) denied();
    const policy = validateBotScope(scope.policy);
    if (chatIds.length === 0 || chatIds.some(id => !policy.chat_ids.includes(id))) denied();
    const finalGuard = () => {
      guard();
      if (vault.expires_at !== null && vault.expires_at !== undefined
        && (typeof vault.expires_at !== 'number' || !Number.isSafeInteger(vault.expires_at) || vault.expires_at <= now())) denied();
    };
    finalGuard();
    return finalGuard;
  };
}
