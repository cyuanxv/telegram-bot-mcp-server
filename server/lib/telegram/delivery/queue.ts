import type { DeliveryTransport, QueueStore, ReportJob } from "./types";
import { validateTransportConfig, draftJob, enqueueJob, claimJob, performDelivery, settleJob, recoverJob, confirmJob, type DraftInput, type Reconciliation } from "./state";
export { DELIVERY_LEASE_MS, MAX_DELIVERY_ATTEMPTS } from "./state";
/** No scheduler. Every dispatch commits one claim before calling the supplied transport. */
export class ReportQueue {
  private store: QueueStore; private clock: () => number;
  constructor(store: QueueStore, clock: () => number = Date.now) { this.store = store; this.clock = clock; }
  draft(input: DraftInput) { return this.store.create(draftJob(input, this.clock)); }
  get(id: string) { return this.store.get(id); }
  enqueue(id: string, fingerprint: string) { return this.store.update(id, job => enqueueJob(job, fingerprint, this.clock)); }
  async dispatchNext(id: string, fingerprint: string, transport: DeliveryTransport): Promise<ReportJob> {
    if (transport.validateConfiguration) validateTransportConfig(this.store.get(id), fingerprint, transport);
    const claim = this.store.update(id, job => claimJob(job, fingerprint, this.clock));
    const outcome = await performDelivery(claim, transport);
    return this.store.update(id, job => settleJob(job, fingerprint, claim, outcome, this.clock));
  }
  recoverStale(id: string) { return this.store.update(id, job => recoverJob(job, this.clock)); }
  confirmUnknownDelivery(id: string, fingerprint: string, input: Reconciliation) { return this.store.update(id, job => confirmJob(job, fingerprint, input, this.clock)); }
}
