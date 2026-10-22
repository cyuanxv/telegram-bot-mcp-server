import { z } from 'zod';
import { WorkflowMcp } from '../workflow-mcp';
import { decimalId } from './normalize';
const schema=z.object({
  botAlias:z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  chatIds:z.array(z.string()).min(1).max(100).optional(),
  afterSequence:z.string().optional(),
  limit:z.number().int().min(1).max(100).optional(),
}).strict();
/** CLI and chat use exactly the same guarded query and final release checks.
 * No separate direct database path, writes or Telegram message sends. */
export async function readInboxForCli(input:unknown,workflow:Pick<WorkflowMcp,'inbox'>=new WorkflowMcp()){
  const args=schema.parse(input);
  if(args.chatIds){args.chatIds=args.chatIds.map(c=>decimalId(c,'chat'));if(new Set(args.chatIds).size!==args.chatIds.length)throw Error('Duplicate inbox chat');}
  if(args.afterSequence!==undefined)decimalId(args.afterSequence,'nonnegative');
  const result=await workflow.inbox({bot_alias:args.botAlias,chat_ids:args.chatIds,after_sequence:args.afterSequence,limit:args.limit});
  return {rows:result.rows,nextAfterSequence:result.next_after_sequence,asOfUnixMs:result.as_of_unix_ms,note:result.note};
}
