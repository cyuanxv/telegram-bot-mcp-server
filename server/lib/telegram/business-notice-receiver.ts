import { businessNotice } from './business-lifecycle';
import type { BusinessNoticeStore } from './business-notice-store';
import type { BotInboxPolicy } from './inbox/types';
type Resource = { store: Pick<BusinessNoticeStore,'record'>; close(): void | Promise<void> };
const response = (status: number, code: string) => Response.json({ ok: status === 200, status: code }, { status, headers: { 'cache-control': 'no-store' } });
/** Called only after webhook authentication. Explicit per-bot opt-in; disabled
 * mode neither opens the journal nor alters the existing inbox receiver. */
export async function receiveBusinessNotice(update: unknown, alias: string, policy: BotInboxPolicy | undefined,
  enabled: () => boolean, open: (guard: () => void) => Promise<Resource>, now = Date.now()): Promise<Response | undefined> {
  if (!enabled() || !policy) return undefined;
  let event;
  try { event = businessNotice(update,alias,policy,now); }
  catch { return response(400,'invalid_business_notice'); }
  if (!event) return undefined;
  const guard = () => { if (!enabled()) throw Error('Business journal disabled'); };
  let resource: Resource | undefined;
  try {
    guard(); resource = await open(guard); guard(); const status = await resource.store.record(event); guard();
    return response(status === 'conflict' ? 409 : 200, `business_${status}`);
  } catch { return response(503,'business_storage_unavailable'); }
  finally { try { await resource?.close(); } catch {} }
}
