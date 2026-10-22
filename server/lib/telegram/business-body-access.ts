import { getBots } from './config';
import { inspectBusinessConnection } from './business-inspect';
import { businessDeletionEnabled } from './business-deletions';

export type BusinessInspector = (bot: string, connection: string, signal?: AbortSignal) => Promise<{
  bot_alias: string; business_connection_id: string; is_enabled: boolean;
}>;
export function businessBodyReadEnabled(alias: string, env: Record<string,string|undefined>): boolean {
  if (env.TELEGRAM_BUSINESS_BODY_READ_ENABLED !== 'true') return false;
  // Vault scopes do not yet authorize Business access.
  try { return Object.hasOwn(getBots(env),alias) && businessDeletionEnabled(alias,env); } catch { return false; }
}

/** A fresh connection-level observation, not an atomic or per-chat permission
 * guarantee. can_read_messages means mark-as-read and is deliberately NOT used
 * as a body-reading grant. No stored notification or cache grants access. */
export async function assertBusinessConnections(bot: string, connections: string[], guard: () => void,
  callerSignal: AbortSignal, inspect: BusinessInspector = inspectBusinessConnection): Promise<void> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(bot) || !Array.isArray(connections) || connections.length > 100
    || new Set(connections).size !== connections.length || connections.some(id => !/^[A-Za-z0-9_-]{1,256}$/.test(id))) throw Error('Business connection verification failed');
  const stop = new AbortController(), signal = AbortSignal.any([callerSignal,stop.signal]);
  guard(); if (signal.aborted) throw Error('Business connection verification failed');
  let next = 0;
  // Bound concurrent Telegram reads. All workers share the request deadline.
  const worker = async () => {
    while (next < connections.length) {
      guard(); if (signal.aborted) throw Error('Business connection verification failed');
      const connection = connections[next++];
      const value = await inspect(bot,connection,signal);
      guard(); if (signal.aborted || value?.bot_alias !== bot || value?.business_connection_id !== connection || value.is_enabled !== true) throw Error('Business connection verification failed');
    }
  };
  // Abort waiting even if an injected/custom transport does not honor the signal.
  let aborted: (() => void) | undefined;
  const cancellation = new Promise<never>((_,reject) => {
    aborted = () => reject(Error('Business connection verification failed'));
    signal.addEventListener('abort',aborted,{once:true});
    if (signal.aborted) aborted();
  });
  try { await Promise.race([Promise.all(Array.from({length:Math.min(4,connections.length)},worker)),cancellation]); guard(); }
  catch { stop.abort(); throw Error('Business connection verification failed'); }
  finally { if (aborted) signal.removeEventListener('abort',aborted); }
}
