import type { TransactionalSql } from './delivery/postgres-store';
import { checkedBusinessNotice, type BusinessNotice } from './business-lifecycle';
import { decimalId } from './inbox/normalize';
import { applyBusinessDeletion, type BusinessDeletionGate } from './business-deletions';

/** Notification journal only: no inferred current grant, no Telegram mutation,
 * inbox deletion only under the separate explicit gate. Never auto-creates a schema or runtime database privileges. */
export class BusinessNoticeStore {
  private database: TransactionalSql;
  private deletionGate?: BusinessDeletionGate;
  constructor(database: TransactionalSql, deletionGate?: BusinessDeletionGate) { this.database = database; this.deletionGate=deletionGate; }
  async list(input: { botAlias: string; connectionId: string; chatIds: string[]; afterSequence?: string; limit?: number; now: number }) {
    const { botAlias, connectionId, now } = input;
    const after = decimalId(input.afterSequence ?? '0','nonnegative'), limit = input.limit ?? 20;
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(botAlias) || !/^[A-Za-z0-9_-]{1,256}$/.test(connectionId)
      || !Array.isArray(input.chatIds) || input.chatIds.length < 1 || input.chatIds.length > 100
      || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('Invalid Business journal query');
    const chats = input.chatIds.map(id => decimalId(id,'chat'));
    if (new Set(chats).size !== chats.length) throw Error('Duplicate Business chat scope');
    return this.database.transaction(async sql => {
      const rows = (await sql.query(`SELECT sequence::text,document FROM public.telegram_business_notices
        WHERE bot_alias=$1 AND connection_id=$2 AND sequence>$3::bigint AND expires_at>$4
        AND (document->'observation'->>'kind'='connection' OR document->'observation'->>'chatId'=ANY($5::text[]))
        ORDER BY sequence ASC LIMIT $6`, [botAlias,connectionId,after,now,chats,limit])).rows;
      let previous = BigInt(after);
      return rows.map(row => {
        const event = checkedBusinessNotice(row.document as BusinessNotice), sequence = decimalId(String(row.sequence));
        if (event.botAlias !== botAlias || event.connectionId !== connectionId || event.expiresAt <= now
          || (event.observation.kind === 'deleted' && !chats.includes(event.observation.chatId)) || BigInt(sequence) <= previous) throw Error('Invalid Business journal result');
        previous = BigInt(sequence);
        return { sequence,event };
      });
    });
  }
  async record(input: BusinessNotice): Promise<'stored' | 'duplicate' | 'conflict'> {
    const event = checkedBusinessNotice(structuredClone(input));
    const deletion=event.observation.kind==='deleted'?this.deletionGate?.(event.botAlias):undefined;
    return this.database.transaction(async sql => {
      deletion?.guard();
      if(deletion?.enabled)await sql.query('LOCK TABLE public.telegram_inbox_events IN SHARE ROW EXCLUSIVE MODE');
      await sql.query('LOCK TABLE public.telegram_business_notices IN SHARE ROW EXCLUSIVE MODE');
      const prior = (await sql.query('SELECT fingerprint FROM public.telegram_business_notices WHERE bot_alias=$1 AND update_id=$2', [event.botAlias,event.updateId])).rows[0];
      if (prior) {
        if(prior.fingerprint !== event.fingerprint)return 'conflict';
        if(deletion?.enabled)await applyBusinessDeletion(sql,event);
        deletion?.guard();return 'duplicate';
      }
      const count = Number((await sql.query('SELECT COUNT(*) AS n FROM public.telegram_business_notices')).rows[0]?.n);
      if (!Number.isSafeInteger(count) || count >= 10000) throw Error('Business journal capacity reached');
      await sql.query('INSERT INTO public.telegram_business_notices(bot_alias,update_id,connection_id,fingerprint,expires_at,document) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [event.botAlias,event.updateId,event.connectionId,event.fingerprint,event.expiresAt,JSON.stringify(event)]);
      if(deletion?.enabled)await applyBusinessDeletion(sql,event);
      deletion?.guard();
      return 'stored';
    });
  }
}
