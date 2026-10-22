import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { AsyncReportQueue } from "../lib/telegram/delivery/async-queue";
import { PostgresQueueStore } from "../lib/telegram/delivery/postgres-store";
import { PgPoolDatabase } from "../lib/telegram/delivery/pg-pool-adapter";
import { postgresConnectionConfig } from "../lib/telegram/delivery/postgres-config";
import { ReportQueue } from "../lib/telegram/delivery/queue";
import { SqliteQueueStore } from "../lib/telegram/delivery/sqlite-store";
import { BotApiDeliveryTransport } from "../lib/telegram/delivery/bot-transport";
import { planReport } from "../lib/telegram/report-plan";
import type { ReportJob } from "../lib/telegram/delivery/types";

function summary(job: ReportJob | undefined) {
  if (!job) throw new Error("Unknown report");
  return { id: job.id, fingerprint: job.fingerprint, botAlias: job.botAlias, chatId: job.chatId, state: job.state,
    chunks: job.chunks.map(({ text: _text, ...chunk }) => chunk), createdAt: job.createdAt, updatedAt: job.updatedAt };
}
async function readInput(): Promise<Record<string, unknown>> {
  const parts: Buffer[] = []; let bytes = 0;
  for await (const part of process.stdin) {
    const buffer = Buffer.from(part); bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error("CLI input exceeds 1 MiB");
    parts.push(buffer);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new Error("Provide one JSON object on stdin"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CLI input must be a JSON object");
  return value as Record<string, unknown>;
}
function only(input: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error("Unsupported CLI input field");
}
function str(input: Record<string, unknown>, key: string): string {
  if (typeof input[key] !== "string" || !input[key]) throw new Error(`Missing string field: ${key}`);
  return input[key] as string;
}
function dispatchAllowed(job: ReportJob, fingerprint: string) {
  if (process.env.TELEGRAM_DELIVERY_ALLOW_DISPATCH !== "true") throw new Error("Live dispatch is disabled; owner configuration and recipient/content authorization are required");
  if (fingerprint !== job.fingerprint) throw new Error("Fingerprint mismatch");
  let scopes: unknown;
  try { scopes = JSON.parse(process.env.TELEGRAM_DELIVERY_ALLOWED_DESTINATIONS_JSON || "null"); } catch { throw new Error("Invalid live delivery destination policy"); }
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 100
    || scopes.some(scope => !scope || typeof scope !== "object" || Array.isArray(scope)
      || Object.keys(scope).sort().join(',') !== 'botAlias,chatId'
      || typeof scope.botAlias !== 'string' || typeof scope.chatId !== 'string')) throw new Error("An explicit live delivery destination policy is required");
  if (!scopes.some(scope => scope.botAlias === job.botAlias && scope.chatId === job.chatId)) throw new Error("Destination is outside the owner-configured delivery scope");
}
async function main() {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help") {
    console.log("Telegram delivery CLI: plan | draft | enqueue | status | recover | confirm | dispatch | demo\nPass input JSON on stdin. SQLite commands use TELEGRAM_DELIVERY_DB on a private durable volume. PostgreSQL requires an explicitly enabled approved database. No migration runs automatically. Live dispatch is disabled unless separately configured and authorized. demo uses only a mock transport and temporary database."); return;
  }
  if (command === "demo") {
    const folder = mkdtempSync(join(tmpdir(), "telegram-queue-demo-")); const store = new SqliteQueueStore(join(folder, "queue.sqlite"));
    try {
      const queue = new ReportQueue(store); const job = queue.draft({ idempotencyKey: "demo", botAlias: "mock", chatId: "-10012345", text: "第一段报告\nSecond report chunk", maxChunkLength: 12 });
      queue.enqueue(job.id, job.fingerprint); let messages = 0;
      while (queue.get(job.id)!.state === "queued") await queue.dispatchNext(job.id, job.fingerprint, { send: async r => ({ chatId: r.chatId, messageId: ++messages }) });
      console.log(JSON.stringify({ simulated: true, external_messages_sent: 0, job: summary(queue.get(job.id)) }));
    } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
    return;
  }
  if (!["plan", "draft", "enqueue", "status", "recover", "confirm", "dispatch"].includes(command)) throw new Error("Unknown CLI command");
  const input = await readInput();
  if (command === "plan") {
    only(input, ["text", "maxChunkLength"]);
    console.log(JSON.stringify(planReport(str(input, "text"), input.maxChunkLength as number | undefined))); return;
  }
  const backend = process.env.TELEGRAM_DELIVERY_BACKEND || "sqlite";
  let queue: ReportQueue | AsyncReportQueue; let close: () => void | Promise<void>;
  if (backend === "postgres") {
    const config = postgresConnectionConfig(process.env);
    const pool = new Pool(config);
    // pg removes failed idle clients. Handle its EventEmitter error without
    // crashing an in-flight delivery or printing connection/provider details.
    pool.on("error", () => { process.stderr.write('{"warning":"Delivery database idle connection failed"}\n'); });
    queue = new AsyncReportQueue(new PostgresQueueStore(new PgPoolDatabase(pool)));
    close = async () => {
      try { await pool.end(); }
      catch { throw new Error("Delivery database shutdown failed"); }
    };
  } else if (backend === "sqlite") {
    const path = process.env.TELEGRAM_DELIVERY_DB;
    if (!path) throw new Error("TELEGRAM_DELIVERY_DB must identify a private durable database");
    const store = new SqliteQueueStore(path); queue = new ReportQueue(store); close = () => store.close();
  } else throw new Error("Unsupported delivery storage backend");
  try {
    let result: ReportJob | undefined;
    if (command === "draft") {
      only(input, ["idempotencyKey", "botAlias", "chatId", "text", "maxChunkLength"]);
      result = await queue.draft({ idempotencyKey: str(input, "idempotencyKey"), botAlias: str(input, "botAlias"), chatId: str(input, "chatId"), text: str(input, "text"), maxChunkLength: input.maxChunkLength as number | undefined });
    } else if (command === "status" || command === "recover") {
      only(input, ["id"]); result = command === "status" ? await queue.get(str(input, "id")) : await queue.recoverStale(str(input, "id"));
    } else if (command === "enqueue") {
      only(input, ["id", "fingerprint"]); result = await queue.enqueue(str(input, "id"), str(input, "fingerprint"));
    } else if (command === "confirm") {
      only(input, ["id", "fingerprint", "chunkIndex", "attemptId", "receipt", "evidenceReference"]);
      result = await queue.confirmUnknownDelivery(str(input, "id"), str(input, "fingerprint"), { chunkIndex: input.chunkIndex as number, attemptId: str(input, "attemptId"), receipt: input.receipt as { chatId: string; messageId: number }, evidenceReference: str(input, "evidenceReference") });
    } else {
      only(input, ["id", "fingerprint"]); const id = str(input, "id"), fingerprint = str(input, "fingerprint");
      const job = await queue.get(id); if (!job) throw new Error("Unknown report"); dispatchAllowed(job, fingerprint);
      result = await queue.dispatchNext(id, fingerprint, new BotApiDeliveryTransport());
    }
    console.log(JSON.stringify(summary(result)));
  } finally { await close(); }
}
main().catch(error => { console.error(JSON.stringify({ error: error instanceof Error ? error.message : "Delivery command failed" })); process.exitCode = 1; });
