import { z } from 'zod';
import { Pool } from 'pg';
import { PgPoolDatabase } from './delivery/pg-pool-adapter';
import { postgresConnectionConfig } from './delivery/postgres-config';
import { BusinessNoticeStore } from './business-notice-store';
import { businessNoticeEnabled } from './business-notice-config';
import { inboxConfig, inboxPolicyGuard } from './inbox/config';
import { decimalId } from './inbox/normalize';

export const businessNoticeReadSchema = z.object({
  bot_alias: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  business_connection_id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  after_sequence: z.string().regex(/^(0|[1-9][0-9]{0,18})$/).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
type Resource = { store: Pick<BusinessNoticeStore,'list'>; close(): void | Promise<void> };
type Options = { env?: () => Record<string,string|undefined>; now?: () => number; signal?: AbortSignal; open?: (guard: () => void) => Promise<Resource> };
async function openProduction(guard: () => void): Promise<Resource> {
  guard(); const pool = new Pool(postgresConnectionConfig(process.env)); pool.on('error', () => {});
  return { store: new BusinessNoticeStore(new PgPoolDatabase(pool,{guard})), close: () => pool.end() };
}
/** Owner-authenticated MCP entry. This reads observations even if a connection
 * was disabled: it never presents them as current rights or message history. */
export async function readBusinessNotices(input: unknown, options: Options = {}) {
  const args = businessNoticeReadSchema.parse(input), env = options.env ?? (() => process.env), now = options.now ?? Date.now;
  if (!businessNoticeEnabled(args.bot_alias,env()) || env().TELEGRAM_BUSINESS_NOTICE_READ_ENABLED !== 'true') throw Error('Business journal reading disabled');
  const policies = inboxConfig(env())?.bots, policy = policies && Object.hasOwn(policies,args.bot_alias) ? policies[args.bot_alias] : undefined;
  if (!policy?.allowedBusinessConnectionIds?.includes(args.business_connection_id)) throw Error('Business journal scope denied');
  const receiverGuard = inboxPolicyGuard(env,args.bot_alias,policy,options.signal);
  const guard = () => {
    receiverGuard();
    if (!businessNoticeEnabled(args.bot_alias,env()) || env().TELEGRAM_BUSINESS_NOTICE_READ_ENABLED !== 'true') throw Error('Business journal scope changed');
  };
  const start = now(), after = decimalId(args.after_sequence ?? '0','nonnegative');
  if (!Number.isSafeInteger(start) || start < 0) throw Error('Invalid Business journal clock');
  let resource: Resource | undefined;
  try {
    guard(); resource = await (options.open ?? openProduction)(guard); guard();
    const rows = await resource.store.list({botAlias:args.bot_alias,connectionId:args.business_connection_id,chatIds:[...policy.allowedChatIds],afterSequence:after,limit:args.limit,now:start});
    // Close before the final release check: revocation during asynchronous cleanup must not leak a result.
    try { await resource.close(); } catch {}
    resource = undefined;
    guard(); const end = now();
    if (!Number.isSafeInteger(end) || end < start) throw Error('Invalid Business journal clock');
    const notices = rows.filter(row => row.event.expiresAt > end).map(({sequence,event}) => {
      const o = event.observation;
      return {sequence,update_id:event.updateId,received_at:event.receivedAt,expires_at:event.expiresAt,
        ...(o.kind === 'connection' ? {kind:o.kind,observed_enabled:o.enabled,connected_at:o.connectedAt,observed_rights:o.rights}
          : {kind:o.kind,chat_id:o.chatId,message_count:o.messageIds.length,message_ids:o.messageIds.slice(0,100),message_ids_truncated:o.messageIds.length>100})};
    });
    guard();
    return {bot_alias:args.bot_alias,business_connection_id:args.business_connection_id,notices,
      next_after_sequence:rows.at(-1)?.sequence ?? after,current_permissions_verified:false,notification_log_only:true,sent:false};
  } catch { throw Error('Business journal unavailable or scope changed'); }
  finally { try { await resource?.close(); } catch {} }
}
