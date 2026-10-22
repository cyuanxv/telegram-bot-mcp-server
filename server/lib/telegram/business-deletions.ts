import { businessNoticeEnabled } from './business-notice-config';
import type { BusinessNotice } from './business-lifecycle';
import type { SqlExecutor } from './delivery/postgres-store';
type Env = Record<string,string|undefined>;
export type BusinessDeletionGate = (alias: string) => { enabled: boolean; guard(): void };
export function businessDeletionEnabled(alias: string, env: Env): boolean {
  return env.TELEGRAM_BUSINESS_DELETE_APPLY_ENABLED === 'true' && businessNoticeEnabled(alias,env);
}
export function businessDeletionGate(env: () => Env = () => process.env): BusinessDeletionGate {
  return alias => {
    const enabled = businessDeletionEnabled(alias,env());
    return {enabled,guard:()=>{if(businessDeletionEnabled(alias,env())!==enabled)throw Error('Business deletion policy changed')}};
  };
}
/** Caller owns one guarded transaction and locks inbox before notice/deletion
 * tables. Metadata markers intentionally outlive the short-lived notice log;
 * enabling this storage/retention requires separate approval. */
export async function applyBusinessDeletion(sql: SqlExecutor, event: BusinessNotice): Promise<void> {
  if (event.observation.kind !== 'deleted') throw Error('Expected Business deletion notice');
  const {chatId,messageIds}=event.observation;
  await sql.query('LOCK TABLE public.telegram_business_deletions IN SHARE ROW EXCLUSIVE MODE');
  await sql.query(`INSERT INTO public.telegram_business_deletions(bot_alias,connection_id,chat_id,message_id,created_at)
    SELECT $1,$2,$3,id,$5 FROM unnest($4::text[]) AS ids(id) ON CONFLICT DO NOTHING`,[event.botAlias,event.connectionId,chatId,messageIds,event.receivedAt]);
  const count=Number((await sql.query('SELECT COUNT(*) AS n FROM public.telegram_business_deletions')).rows[0]?.n);
  if(!Number.isSafeInteger(count)||count>100000)throw Error('Business deletion marker capacity reached');
  await sql.query(`DELETE FROM public.telegram_inbox_events WHERE bot_alias=$1 AND chat_id=$2
    AND document->>'businessConnectionId'=$3 AND document->>'messageId'=ANY($4::text[])`,[event.botAlias,chatId,event.connectionId,messageIds]);
}
