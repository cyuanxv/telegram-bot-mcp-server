import { createHash, randomUUID } from "node:crypto";
import { planReport } from "../report-plan";
import { copy, DefiniteRejection, validReceipt, type DeliveryTransport, type QueueStore, type ReportJob, type Receipt } from "./types";

export const DELIVERY_LEASE_MS = 60_000;
export const MAX_DELIVERY_ATTEMPTS = 3;
const MAX_RETRY_SECONDS = 7 * 24 * 60 * 60;
export function reportFingerprint(botAlias: string, chatId: string, chunks: string[], threadId?:number) {
  return createHash("sha256").update(JSON.stringify({ version: 1, format: "plain_text", botAlias, chatId, chunks, ...(threadId===undefined?{}:{threadId}) })).digest("hex");
}
function bound(job: ReportJob, expected: string) {
  if (expected !== job.fingerprint || reportFingerprint(job.botAlias, job.chatId, job.chunks.map(c => c.text),job.threadId) !== job.fingerprint) {
    throw new Error("Report content or destination does not match the approved fingerprint");
  }
}
function refresh(job: ReportJob) {
  const next = job.chunks.find(c => c.state !== "sent");
  job.state = !next ? "delivered" : next.state === "pending" ? "queued" : next.state === "sent" ? "delivered" : next.state;
}
function nowValue(now: () => number) {
  const value = now(); if (!Number.isSafeInteger(value) || value < 0 || value > 8_000_000_000_000_000) throw new Error("Invalid delivery clock");
  return value;
}
export type DraftInput = { idempotencyKey: string; botAlias: string; chatId: string; threadId?:number; text: string; maxChunkLength?: number };
export type DeliveryClaim = { botAlias: string; chatId: string; threadId?:number; text: string; attemptId: string; index: number };
export type DeliveryOutcome = { receipt?: Receipt; failure?: unknown };
export type Reconciliation = { chunkIndex: number; attemptId: string; receipt: Receipt; evidenceReference: string };
export function draftJob(input: DraftInput, clock: () => number): ReportJob {
    if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)) throw new Error("Invalid report idempotency key");
    if (typeof input.botAlias !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(input.botAlias)) throw new Error("An explicit stable bot alias is required");
    if (typeof input.chatId !== "string" || !/^-?[1-9][0-9]{0,19}$/.test(input.chatId)) throw new Error("An explicit decimal Telegram chat ID is required; aliases and usernames are not accepted");
    if(input.threadId!==undefined&&(!Number.isSafeInteger(input.threadId)||input.threadId<1))throw Error('Invalid report thread');
    const plan = planReport(input.text, input.maxChunkLength);
    const now = nowValue(clock);
    const job: ReportJob = {
      schemaVersion: 1, id: randomUUID(), idempotencyKey: input.idempotencyKey,
      fingerprint: reportFingerprint(input.botAlias, input.chatId, plan.chunks.map(c => c.text),input.threadId),
      botAlias: input.botAlias, chatId: input.chatId, ...(input.threadId===undefined?{}:{threadId:input.threadId}), state: "draft", createdAt: now, updatedAt: now,
      chunks: plan.chunks.map(c => ({ index: c.index, text: c.text, state: "pending", attempts: 0 })),
    };
    return job;
}
export function enqueueJob(job: ReportJob, expectedFingerprint: string, clock: () => number) {

      bound(job, expectedFingerprint);
      if (job.state === "draft") { job.state = "queued"; job.updatedAt = nowValue(clock); }
      else if (job.state !== "queued") throw new Error("Report is not eligible to enqueue");
      return job;
}
export function claimJob(job: ReportJob, expectedFingerprint: string, clock: () => number): DeliveryClaim {

      bound(job, expectedFingerprint);
      const now = nowValue(clock);
      if (job.state !== "queued" && job.state !== "retry_wait") throw new Error(`Report dispatch blocked in state ${job.state}`);
      const chunk = job.chunks.find(c => c.state !== "sent");
      if (!chunk || !["pending", "retry_wait"].includes(chunk.state)) throw new Error("Report chunk cannot be dispatched");
      if (chunk.retryAt !== undefined && now < chunk.retryAt) throw new Error("Telegram retry delay has not elapsed");
      if (chunk.attempts >= MAX_DELIVERY_ATTEMPTS) throw new Error("Delivery attempt budget exhausted");
      chunk.state = "sending"; chunk.attempts++; chunk.attemptId = randomUUID(); chunk.startedAt = now;
      delete chunk.retryAt; delete chunk.failureCode;
      job.state = "sending"; job.updatedAt = now;
      return { botAlias: job.botAlias, chatId: job.chatId, ...(job.threadId===undefined?{}:{threadId:job.threadId}), text: chunk.text, attemptId: chunk.attemptId, index: chunk.index };
}
export async function performDelivery(claim: DeliveryClaim, transport: DeliveryTransport): Promise<DeliveryOutcome> {
    let receipt: Receipt | undefined; let failure: unknown;
    try {
      const result = await transport.send(copy(claim));
      if (!validReceipt(result, claim.chatId,claim.threadId)) throw new Error("Unverifiable delivery receipt");
      receipt = { chatId: result.chatId, messageId: result.messageId, ...(result.threadId===undefined?{}:{threadId:result.threadId}) };
    } catch (error) { failure = error; }

  return { receipt, failure };
}
export function settleJob(job: ReportJob, expectedFingerprint: string, claim: DeliveryClaim, outcome: DeliveryOutcome, clock: () => number) {
  const { receipt, failure } = outcome;

      bound(job, expectedFingerprint);
      const chunk = job.chunks[claim.index - 1];
      if (chunk.attemptId !== claim.attemptId || chunk.state !== "sending") throw new Error("Delivery result arrived after state changed; manual reconciliation is required");
      if (receipt) { chunk.state = "sent"; chunk.receipt = receipt; }
      else if (failure instanceof DefiniteRejection) {
        const seconds = failure.retryAfterSeconds ?? 60;
        if (failure.kind === "rate_limited" && chunk.attempts < MAX_DELIVERY_ATTEMPTS
          && Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= MAX_RETRY_SECONDS) {
          chunk.state = "retry_wait"; chunk.retryAt = nowValue(clock) + seconds * 1000; chunk.failureCode = "rate_limited";
        } else { chunk.state = "rejected"; chunk.failureCode = "definite_rejection"; }
      } else { chunk.state = "unknown"; chunk.failureCode = "delivery_unknown"; }
      job.updatedAt = nowValue(clock); refresh(job); return job;
}
export function recoverJob(job: ReportJob, clock: () => number) {

      const now = nowValue(clock);
      for (const chunk of job.chunks) {
        if (chunk.state === "sending" && chunk.startedAt !== undefined && now - chunk.startedAt >= DELIVERY_LEASE_MS) {
          chunk.state = "unknown"; chunk.failureCode = "worker_interrupted"; job.updatedAt = now;
        }
      }
      if (job.state !== "draft") refresh(job);
      return job;
}
export function confirmJob(job: ReportJob, expectedFingerprint: string, input: Reconciliation, clock: () => number) {

      bound(job, expectedFingerprint);
      if (!Number.isSafeInteger(input.chunkIndex)) throw new Error("Invalid chunk index");
      const chunk = job.chunks[input.chunkIndex - 1];
      if (job.state !== "unknown" || !chunk || chunk.state !== "unknown" || chunk.attemptId !== input.attemptId) throw new Error("Unknown delivery does not match the selected attempt");
      if (!validReceipt(input.receipt, job.chatId,job.threadId)) throw new Error("Receipt does not match the report destination");
      if (typeof input.evidenceReference !== "string" || !input.evidenceReference.trim() || input.evidenceReference.length > 512) throw new Error("An external verification reference is required");
      chunk.receipt = { chatId: input.receipt.chatId, messageId: input.receipt.messageId, ...(input.receipt.threadId===undefined?{}:{threadId:input.receipt.threadId}) };
      chunk.reconciliationEvidence = input.evidenceReference; chunk.state = "sent";
      job.updatedAt = nowValue(clock); refresh(job); return job;
}

export function validateTransportConfig(job: ReportJob | undefined, expectedFingerprint: string, transport: DeliveryTransport) {
  if (!job) throw new Error("Unknown report"); bound(job, expectedFingerprint);
  transport.validateConfiguration?.({ botAlias: job.botAlias, chatId: job.chatId, ...(job.threadId===undefined?{}:{threadId:job.threadId}) });
}
