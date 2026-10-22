import { createHash } from 'node:crypto';
import { z } from 'zod';
import { checkedBusinessNotice, type BusinessNotice } from './business-lifecycle';
import { applyBusinessDeletion, businessDeletionEnabled } from './business-deletions';
import { businessNoticeEnabled } from './business-notice-config';
import { approvedInboxPolicies } from './inbox/config';
import { decimalId } from './inbox/normalize';
import type { SqlExecutor, TransactionalSql } from './delivery/postgres-store';

const id = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
export const backfillScopeSchema = z.object({
  bot_alias: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  connection_id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  chat_ids: z.array(z.string()).min(1).max(100),
  after_sequence: id,
  through_sequence: id,
}).strict();
export type BackfillScope = z.infer<typeof backfillScopeSchema>;
function scopeOf(input: unknown): BackfillScope {
  const s=backfillScopeSchema.parse(input);
  decimalId(s.after_sequence,'nonnegative');decimalId(s.through_sequence,'nonnegative');
  if(BigInt(s.through_sequence)<=BigInt(s.after_sequence))throw Error('Backfill range must be nonempty');
  s.chat_ids=s.chat_ids.map(v=>decimalId(v,'chat')).sort();
  if(new Set(s.chat_ids).size!==s.chat_ids.length)throw Error('Duplicate backfill chat');
  return s;
}
/** CLI-only operation. Explicit operator execution is still required; flags do
 * not themselves represent human approval. No Telegram API or schema changes. */
export function backfillGuard(input: unknown, apply: boolean, env:()=>Record<string,string|undefined>=()=>process.env) {
  const scope=scopeOf(input);
  const snapshot=()=>{
    const e=env();
    if(e.TELEGRAM_BUSINESS_BACKFILL_ENABLED!=='true'||!businessNoticeEnabled(scope.bot_alias,e)
      ||(apply&&!businessDeletionEnabled(scope.bot_alias,e)))throw Error('Business backfill disabled');
    const policy=approvedInboxPolicies(e).bots[scope.bot_alias];
    if(!policy?.allowedBusinessConnectionIds?.includes(scope.connection_id)
      ||scope.chat_ids.some(c=>!policy.allowedChatIds.includes(c)))throw Error('Business backfill scope denied');
    return JSON.stringify(policy);
  };
  const initial=snapshot();
  return {scope,guard:()=>{if(snapshot()!==initial)throw Error('Business backfill scope changed')}};
}
async function select(sql:SqlExecutor,scope:BackfillScope) {
  // Include still-stored expired notices for deletion repair. Never return their
  // documents to the CLI. This does not recover already purged history.
  const rows=(await sql.query(`SELECT sequence::text,document FROM public.telegram_business_notices
    WHERE bot_alias=$1 AND connection_id=$2 AND sequence>$3::bigint AND sequence<=$4::bigint
      AND document->'observation'->>'kind'='deleted'
      AND document->'observation'->>'chatId'=ANY($5::text[])
    ORDER BY sequence ASC LIMIT 101`,[scope.bot_alias,scope.connection_id,scope.after_sequence,scope.through_sequence,scope.chat_ids])).rows;
  if(rows.length>100)throw Error('Backfill range exceeds 100 notices; choose a smaller range');
  let previous=BigInt(scope.after_sequence),total=0;
  const events:{sequence:string;event:BusinessNotice}[]=rows.map(row=>{
    const sequence=decimalId(String(row.sequence)),event=checkedBusinessNotice(row.document as BusinessNotice);
    if(BigInt(sequence)<=previous||BigInt(sequence)>BigInt(scope.through_sequence)||event.botAlias!==scope.bot_alias
      ||event.connectionId!==scope.connection_id||event.observation.kind!=='deleted'||!scope.chat_ids.includes(event.observation.chatId))throw Error('Invalid backfill record');
    previous=BigInt(sequence);total+=event.observation.messageIds.length;
    return {sequence,event};
  });
  if(total>10000)throw Error('Backfill range exceeds 10000 message references');
  const digest=createHash('sha256').update(JSON.stringify({version:1,scope,events})).digest('hex');
  return {events,summary:{version:1,scope,digest,notice_count:events.length,message_references:total,
    historical_coverage:'stored_notices_only' as const}};
}
export class BusinessBackfill {
  private db:TransactionalSql; private guard:()=>void; private scope:BackfillScope;
  constructor(db:TransactionalSql,scope:BackfillScope,guard:()=>void){this.db=db;this.scope=scopeOf(scope);this.guard=guard;}
  async plan(){
    const scope=structuredClone(this.scope);this.guard();
    const result=await this.db.transaction(async sql=>{this.guard();const result=await select(sql,scope);this.guard();return result.summary;});
    this.guard();return result;
  }
  async apply(expectedDigest:string){
    const scope=structuredClone(this.scope);
    if(!/^[0-9a-f]{64}$/.test(expectedDigest))throw Error('Expected reviewed plan digest');
    this.guard();
    return this.db.transaction(async sql=>{
      this.guard();
      // Same global ordering as live deletion processing. Prevent changes between
      // the reviewed-record comparison and removal; live delivery waits briefly.
      await sql.query('LOCK TABLE public.telegram_inbox_events IN SHARE ROW EXCLUSIVE MODE');
      await sql.query('LOCK TABLE public.telegram_business_notices IN SHARE ROW EXCLUSIVE MODE');
      const current=await select(sql,scope);
      if(current.summary.digest!==expectedDigest)throw Error('Backfill plan changed; review a new plan');
      for(const {event} of current.events){this.guard();await applyBusinessDeletion(sql,event);}
      this.guard();return {...current.summary,applied_notices:current.events.length,telegram_mutated:false};
    });
  }
}
