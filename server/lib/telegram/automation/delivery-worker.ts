import { createHash, timingSafeEqual } from "node:crypto";
import type { WorkflowMcp } from "../workflow-mcp";
type Env = Record<string, string | undefined>;
type Workflow = Pick<WorkflowMcp, "report">;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (status: number, result: unknown) => Response.json(result, { status, headers: { "cache-control": "no-store" } });
function sameSecret(supplied: string | null, secret: string) {
  return supplied !== null && supplied.length <= 4096 && timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(`Bearer ${secret}`).digest());
}
/** One bounded cloud invocation. Only previously enqueued, explicitly configured snapshots can be dispatched. */
export async function runDeliveryWorker(request: Request, env: () => Env, workflow: Workflow, now = Date.now()) {
  const config = env();
  if (config.TELEGRAM_DELIVERY_WORKER_ENABLED !== "true") return json(503, { status: "worker_disabled" });
  if (!config.CRON_SECRET?.trim()) return json(503, { status: "worker_auth_not_configured" });
  if (!sameSecret(request.headers.get("authorization"), config.CRON_SECRET)) return json(401, { status: "unauthorized" });
  if (!["GET", "POST"].includes(request.method)) return json(405, { status: "method_not_allowed" });
  // No report IDs, targets, content or fingerprint are accepted from the request.
  let ids: unknown;
  try { ids = JSON.parse(config.TELEGRAM_DELIVERY_WORKER_REPORT_IDS_JSON || "null"); } catch { return json(503, { status: "invalid_worker_configuration" }); }
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== "string" || !uuid.test(id)) || new Set(ids).size !== ids.length) return json(503, { status: "invalid_worker_configuration" });
  const skipped: { id: string; state: string }[] = [];
  // Scan at most ten configured jobs per invocation, with time-based rotation to prevent starvation.
  const start = ids.length ? Math.floor(now / 60000) % ids.length : 0;
  for (let i = 0; i < Math.min(ids.length, 10); i++) {
    const id = ids[(start + i) % ids.length] as string;
    if (request.signal.aborted || env().TELEGRAM_DELIVERY_WORKER_ENABLED !== "true") return json(409, { status: "cancelled", skipped });
    try {
      const job = await workflow.report("status", id, undefined, request.signal);
      if (job.state !== "queued" && job.state !== "retry_wait") { skipped.push({ id, state: job.state }); continue; }
      const active = job.chunks.find(c => c.state !== "sent");
      if (active?.state === "retry_wait" && (active.retryAt === undefined || active.retryAt > now)) { skipped.push({ id, state: "retry_not_due" }); continue; }
      const current = env();
      let currentIds: unknown;
      try { currentIds = JSON.parse(current.TELEGRAM_DELIVERY_WORKER_REPORT_IDS_JSON || "null"); } catch { return json(409, { status: "configuration_changed" }); }
      if (request.signal.aborted || current.TELEGRAM_DELIVERY_WORKER_ENABLED !== "true" || current.CRON_SECRET !== config.CRON_SECRET || !Array.isArray(currentIds) || !currentIds.includes(id)) return json(409, { status: "configuration_changed" });
      // The queue atomically claims before sending and independently rechecks scope/dispatch enablement.
      const result = await workflow.report("dispatch", id, job.fingerprint, request.signal);
      return json(200, { status: "processed", id, state: result.state, skipped, automatic_unknown_retry: false });
    } catch {
      // Includes ambiguous storage acknowledgements. Stop; never try another send in this invocation.
      return json(503, { status: "check_report_state_before_retry", id, automatic_unknown_retry: false });
    }
  }
  return json(200, { status: "idle", skipped });
}
