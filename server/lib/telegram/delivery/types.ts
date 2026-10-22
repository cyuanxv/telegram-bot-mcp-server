export type DeliveryStatus = "draft" | "queued" | "sending" | "retry_wait" | "unknown" | "rejected" | "delivered";
export type ChunkStatus = "pending" | "sending" | "retry_wait" | "unknown" | "rejected" | "sent";
export type Receipt = { chatId: string; messageId: number; threadId?: number };
export type Chunk = {
  index: number; text: string; state: ChunkStatus; attempts: number;
  attemptId?: string; startedAt?: number; retryAt?: number;
  receipt?: Receipt; failureCode?: string; reconciliationEvidence?: string;
};
export type ReportJob = {
  schemaVersion: 1; id: string; idempotencyKey: string; fingerprint: string;
  botAlias: string; chatId: string; threadId?: number; createdAt: number; updatedAt: number;
  state: DeliveryStatus; chunks: Chunk[];
};
/** Callbacks are synchronous. update() must atomically commit or roll back. */
export interface QueueStore {
  create(job: ReportJob): ReportJob;
  get(id: string): ReportJob | undefined;
  update<T>(id: string, change: (job: ReportJob) => T): T;
}
export type TransportRequest = { botAlias: string; chatId: string; threadId?: number; text: string; attemptId: string };
export interface DeliveryTransport {
  /** Configuration-only check: must not make network requests or transmit data. */
  validateConfiguration?(target: { botAlias: string; chatId: string; threadId?: number }): void;
  send(request: TransportRequest): Promise<Receipt>;
}
/** Only transport adapters that can prove non-delivery may throw this type. */
export class DefiniteRejection extends Error {
  readonly kind: "rate_limited" | "rejected";
  readonly retryAfterSeconds?: number;
  constructor(kind: "rate_limited" | "rejected", retryAfterSeconds?: number) {
    super(kind === "rate_limited" ? "Delivery was rate limited" : "Delivery was rejected");
    this.kind = kind; this.retryAfterSeconds = retryAfterSeconds;
  }
}
export function copy<T>(value: T): T { return structuredClone(value); }
export function validReceipt(value: unknown, expectedChatId: string, expectedThreadId?:number): value is Receipt {
  if (!value || typeof value !== "object") return false;
  const r = value as Receipt;
  return r.chatId === expectedChatId && Number.isSafeInteger(r.messageId) && r.messageId > 0 && r.threadId===expectedThreadId;
}

export interface AsyncQueueStore {
  create(job: ReportJob): Promise<ReportJob>;
  get(id: string): Promise<ReportJob | undefined>;
  update<T>(id: string, change: (job: ReportJob) => T): Promise<T>;
}
