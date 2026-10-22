import { copy, validReceipt, type QueueStore, type ReportJob } from "./types";

export const MAX_STORED_REPORTS = 1000;
export function requireSameDraft(existing: ReportJob, supplied: ReportJob): ReportJob {
  if (existing.fingerprint !== supplied.fingerprint) throw new Error("Idempotency key already belongs to different content or destination");
  return copy(existing);
}
export function checkJob(job: ReportJob) {
  const bad = () => { throw new Error("Unsupported or corrupted report record; dispatch refused"); };
  if (job?.schemaVersion !== 1 || typeof job.id !== "string" || !job.id
    || typeof job.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(job.idempotencyKey)
    || typeof job.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(job.fingerprint)
    || typeof job.botAlias !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(job.botAlias)
    || typeof job.chatId !== "string" || !/^-?[1-9][0-9]{0,19}$/.test(job.chatId)
    || (job.threadId!==undefined&&(!Number.isSafeInteger(job.threadId)||job.threadId<1))
    || !Number.isSafeInteger(job.createdAt) || !Number.isSafeInteger(job.updatedAt)
    || !["draft", "queued", "sending", "retry_wait", "unknown", "rejected", "delivered"].includes(job.state)
    || !Array.isArray(job.chunks) || job.chunks.length < 1 || job.chunks.length > 64) bad();
  let units = 0, foundUnsent = false;
  const messageIds = new Set<number>();
  for (let i = 0; i < job.chunks.length; i++) {
    const c = job.chunks[i];
    if (!c || c.index !== i + 1 || typeof c.text !== "string" || !c.text.trim() || !c.text.isWellFormed()
      || c.text.length > 4096 || !Number.isSafeInteger(c.attempts) || c.attempts < 0 || c.attempts > 3
      || !["pending", "sending", "retry_wait", "unknown", "rejected", "sent"].includes(c.state)) bad();
    units += c.text.length;
    if (foundUnsent && c.state !== "pending") bad();
    if (c.state !== "sent") foundUnsent = true;
    if (c.state === "pending") { if (c.attempts !== 0 || c.receipt || c.attemptId || c.startedAt !== undefined || c.retryAt !== undefined) bad(); }
    else if (c.attempts < 1 || typeof c.attemptId !== "string" || !c.attemptId || !Number.isSafeInteger(c.startedAt)) bad();
    if (c.state === "sent") {
      if (!validReceipt(c.receipt, job.chatId,job.threadId) || messageIds.has(c.receipt!.messageId)) bad();
      messageIds.add(c.receipt!.messageId);
    } else if (c.receipt) bad();
    if (c.state === "retry_wait" && (!Number.isSafeInteger(c.retryAt) || c.retryAt! < 0)) bad();
  }
  if (units > 131072) bad();
  const next = job.chunks.find(c => c.state !== "sent");
  const expected = !next ? "delivered" : next.state === "pending" ? "queued" : next.state;
  if (job.state === "draft") { if (job.chunks.some(c => c.state !== "pending")) bad(); }
  else if (job.state !== expected) bad();
}
/** Deterministic test adapter. Never claim this adapter survives a restart. */
export class MemoryQueueStore implements QueueStore {
  private jobs = new Map<string, ReportJob>();
  private keys = new Map<string, string>();
  create(job: ReportJob) {
    const existingId = this.keys.get(job.idempotencyKey);
    if (existingId) return requireSameDraft(this.jobs.get(existingId)!, job);
    if (this.jobs.size >= MAX_STORED_REPORTS) throw new Error("Report storage capacity reached");
    if (this.jobs.has(job.id)) throw new Error("Report ID collision");
    checkJob(job); this.jobs.set(job.id, copy(job)); this.keys.set(job.idempotencyKey, job.id);
    return copy(job);
  }
  get(id: string) { const job = this.jobs.get(id); return job ? copy(job) : undefined; }
  update<T>(id: string, change: (job: ReportJob) => T): T {
    const previous = this.jobs.get(id);
    if (!previous) throw new Error("Unknown report");
    const job = copy(previous); const result = change(job);
    checkJob(job); this.jobs.set(id, copy(job)); return copy(result);
  }
}
