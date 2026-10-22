import type { InboxAuthorizer } from "./vault-access";
import type { SqlExecutor, TransactionalSql } from "../delivery/postgres-store";
import { decimalId, validateInboxEvent } from "./normalize";
import type { InboxEvent, InboxStore, InboxRecordResult } from "./types";
import type { BusinessDeletionGate } from '../business-deletions';
export class PostgresInboxStore implements InboxStore {
  private database: TransactionalSql;
  private authorize?: InboxAuthorizer;
  private deletionGate?: BusinessDeletionGate;
  constructor(database: TransactionalSql, authorize?: InboxAuthorizer, deletionGate?: BusinessDeletionGate) { this.database = database; this.authorize = authorize; this.deletionGate=deletionGate; }
  private transaction<T>(alias: string, chats: string[], operation: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    return this.database.transaction(async sql => {
      const guard = await this.authorize?.(sql, alias, chats);
      const result = await operation(sql);
      guard?.();
      return result;
    });
  }
  async record(supplied: InboxEvent): Promise<InboxRecordResult> {
    const event = structuredClone(supplied); validateInboxEvent(event);
    const deletion=event.businessConnectionId===undefined?undefined:this.deletionGate?.(event.botAlias);
    return this.transaction(event.botAlias, [event.chatId], async sql => {
      deletion?.guard();
      await sql.query("LOCK TABLE public.telegram_inbox_events IN SHARE ROW EXCLUSIVE MODE");
      if(deletion?.enabled){
        const marker=(await sql.query('SELECT 1 FROM public.telegram_business_deletions WHERE bot_alias=$1 AND connection_id=$2 AND chat_id=$3 AND message_id=$4',[event.botAlias,event.businessConnectionId,event.chatId,event.messageId])).rows[0];
        if(marker){deletion.guard();return 'ignored_deleted'}
      }
      const prior = (await sql.query("SELECT fingerprint FROM public.telegram_inbox_events WHERE bot_alias=$1 AND update_id=$2", [event.botAlias, event.updateId])).rows[0];
      if (prior) return prior.fingerprint === event.fingerprint ? "duplicate" : "conflict";
      const count = Number((await sql.query("SELECT COUNT(*) AS n FROM public.telegram_inbox_events")).rows[0]?.n);
      if (!Number.isSafeInteger(count) || count >= 10000) throw new Error("Inbox capacity reached");
      await sql.query("INSERT INTO public.telegram_inbox_events(bot_alias,update_id,chat_id,fingerprint,expires_at,document) VALUES($1,$2,$3,$4,$5,$6::jsonb)", [event.botAlias, event.updateId, event.chatId, event.fingerprint, event.expiresAt, JSON.stringify(event)]);
      deletion?.guard();
      return "stored";
    });
  }
  async list(input: { botAlias: string; chatIds: string[]; businessConnectionIds?: string[]; afterSequence?: string; limit?: number; now: number }) {
    const { botAlias, now } = input, limit = input.limit === undefined ? 50 : input.limit, after = decimalId(input.afterSequence === undefined ? "0" : input.afterSequence, "nonnegative");
    if (typeof botAlias !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(botAlias) || !Array.isArray(input.chatIds) || input.chatIds.length < 1 || input.chatIds.length > 100
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid inbox read scope");
    const ids = input.chatIds.map(id => decimalId(id, "chat"));
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate inbox read scope");
    if (input.businessConnectionIds !== undefined && !Array.isArray(input.businessConnectionIds)) throw new Error("Invalid Business read scope");
    const connections = [...(input.businessConnectionIds ?? [])];
    if (connections.length > 100 || new Set(connections).size !== connections.length || connections.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(id))) throw new Error("Invalid Business read scope");
    const deletion=connections.length?this.deletionGate?.(botAlias):undefined;
    return this.transaction(botAlias, ids, async sql => {
      deletion?.guard();
      const suppress=deletion?.enabled?" AND NOT EXISTS (SELECT 1 FROM public.telegram_business_deletions d WHERE d.bot_alias=e.bot_alias AND d.chat_id=e.chat_id AND d.connection_id=e.document->>'businessConnectionId' AND d.message_id=e.document->>'messageId')":"";
      const rows = (await sql.query("SELECT sequence::text,document FROM public.telegram_inbox_events e WHERE bot_alias=$1 AND chat_id=ANY($2::text[]) AND sequence>$3::bigint AND expires_at>$4 AND (document->>'businessConnectionId' IS NULL OR document->>'businessConnectionId'=ANY($5::text[]))"+suppress+" ORDER BY sequence ASC LIMIT $6", [botAlias, ids, after, now, connections, limit])).rows;
      deletion?.guard();
      return rows.map(row => { const event = structuredClone(row.document) as InboxEvent; validateInboxEvent(event); return { sequence: String(row.sequence), event }; });
    });
  }
  /** Final read snapshot after live connection checks; no mutations. */
  async filterBusinessDeleted(input: { sequence: string; event: InboxEvent }[]) {
    if(!Array.isArray(input)||input.length>100)throw Error('Invalid Business release batch');
    const rows=structuredClone(input);for(const r of rows){decimalId(r.sequence);validateInboxEvent(r.event)}
    const business=rows.filter(r=>r.event.businessConnectionId!==undefined);if(!business.length)return rows;
    const alias=business[0].event.botAlias;
    if(rows.some(r=>r.event.botAlias!==alias))throw Error('Mixed Business release scope');
    const deletion=this.deletionGate?.(alias);if(!deletion?.enabled)throw Error('Business deletion protection disabled');
    const targets=business.map(({event:e})=>({connection_id:e.businessConnectionId,chat_id:e.chatId,message_id:e.messageId}));
    return this.transaction(alias,[...new Set(rows.map(r=>r.event.chatId))],async sql=>{
      deletion.guard();
      const blocked=(await sql.query(`SELECT d.connection_id,d.chat_id,d.message_id FROM public.telegram_business_deletions d
        JOIN jsonb_to_recordset($2::jsonb) AS t(connection_id text,chat_id text,message_id text)
        ON d.connection_id=t.connection_id AND d.chat_id=t.chat_id AND d.message_id=t.message_id
        WHERE d.bot_alias=$1`,[alias,JSON.stringify(targets)])).rows;
      const keys=new Set(blocked.map(r=>JSON.stringify([r.connection_id,r.chat_id,r.message_id])));
      deletion.guard();return rows.filter(({event:e})=>!keys.has(JSON.stringify([e.businessConnectionId,e.chatId,e.messageId])));
    });
  }
  /** Explicit maintenance only. The operator must obtain the applicable deletion approval before calling. */
  async purgeExpired(approvedCutoff: number) {
    if (!Number.isSafeInteger(approvedCutoff) || approvedCutoff < 0) throw new Error("Invalid retention cutoff");
    return this.database.transaction(async sql => {
      const rows = (await sql.query("DELETE FROM public.telegram_inbox_events WHERE expires_at<=$1 RETURNING sequence", [approvedCutoff])).rows;
      return { deleted: rows.length };
    });
  }
}
