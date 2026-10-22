import { createHash } from "node:crypto";
import { z } from "zod";
import { planReport } from "./report-plan";

// Provided snapshot only. No data collection, configuration, storage or transport.
const singleLine = (max: number) => z.string().min(1).max(max).refine(value => value.trim() === value && value.isWellFormed() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value));
const utc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/).refine(value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1970 && date.toISOString() === value.replace("Z", ".000Z");
});
const count = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const timeZone = singleLine(64).refine(value => {
  if (value !== "UTC" && !/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
});
const windowSchema = z.object({ start_utc: utc, end_utc: utc, time_zone: timeZone }).strict().refine(value => value.start_utc < value.end_utc);
const sourceSchema = z.object({ label: singleLine(100), reference: singleLine(300).optional(), confirmed: z.boolean(), complete_through_utc: utc }).strict();
const evidence = {
  definition: singleLine(500), definition_confirmed: z.boolean(), source: sourceSchema,
  window: windowSchema,
};
const ratioSchema = z.object({ ...evidence, numerator: count.nullable(), denominator: count.nullable() }).strict();
const retentionSchema = ratioSchema.extend({ followup_window: windowSchema }).strict();
const modesSchema = z.object({ ...evidence, coverage_complete: z.boolean(), modes: z.array(z.object({ mode: singleLine(80), count: count.nullable() }).strict()).min(1).max(30) }).strict().refine(value => new Set(value.modes.map(item => item.mode.normalize("NFC"))).size === value.modes.length);
const costSchema = z.object({ ...evidence, currency: z.literal("USD"), amount: z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$/).nullable(), window_precision: z.enum(["exact", "coarse"]) }).strict();

export const composeReportSchema = z.object({
  title: singleLine(120), window: windowSchema, generated_at_utc: utc,
  metrics: z.object({
    new_user_next_day_retention: retentionSchema.optional(),
    active_next_day_retention: retentionSchema.optional(),
    chat_rate: ratioSchema.optional(),
    mode_message_counts: modesSchema.optional(),
    openrouter_cost: costSchema.optional(),
  }).strict(),
  max_chunk_length: z.number().int().min(1).max(4096).default(4000),
}).strict();

type Window = z.infer<typeof windowSchema>;
type Ratio = z.infer<typeof ratioSchema>;
type Retention = z.infer<typeof retentionSchema>;
type Evidence = Pick<Ratio, "window" | "source" | "definition" | "definition_confirmed">;
type Reason = "not_provided" | "definition_unconfirmed" | "source_unconfirmed" | "incomplete_data" | "window_mismatch" | "invalid_next_day_window" | "missing_value" | "zero_denominator" | "coarse_cost_window";
type MetricResult = { status: "known" | "unknown"; value: string | null; reason?: Reason; details: string[] };
const reasonText: Record<Reason, string> = {
  not_provided: "未提供快照", definition_unconfirmed: "统计口径未确认", source_unconfirmed: "来源未确认",
  incomplete_data: "窗口数据尚未完整", window_mismatch: "统计窗口与日报不一致", invalid_next_day_window: "次日窗口未明确对应相邻完整自然日",
  missing_value: "数据缺失", zero_denominator: "分母为零", coarse_cost_window: "只有粗聚合，不能确认为该窗口准确成本",
};
function unknown(reason: Reason, details: string[] = []): MetricResult { return { status: "unknown", value: null, reason, details }; }
function localParts(instant: string, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const field = (key: string) => parts.find(part => part.type === key)!.value;
  return { day: `${field("year")}-${field("month")}-${field("day")}`, clock: `${field("hour")}:${field("minute")}:${field("second")}` };
}
function windowText(window: Window) {
  const a = localParts(window.start_utc, window.time_zone), b = localParts(window.end_utc, window.time_zone);
  return `${a.day} ${a.clock} 至 ${b.day} ${b.clock} (${window.time_zone}，左闭右开；UTC ${window.start_utc} 至 ${window.end_utc})`;
}
function fullLocalDay(window: Window) {
  const a = localParts(window.start_utc, window.time_zone), b = localParts(window.end_utc, window.time_zone);
  const beforeStart = localParts(new Date(Date.parse(window.start_utc) - 1000).toISOString(), window.time_zone);
  const beforeEnd = localParts(new Date(Date.parse(window.end_utc) - 1000).toISOString(), window.time_zone);
  // Some zones skip or repeat midnight. Require the actual date boundary,
  // rather than assuming 00:00 or a 24-hour interval defines a complete day.
  return beforeStart.day !== a.day && beforeEnd.day === a.day && b.day > a.day;
}
function sameWindow(a: Window, b: Window) { return a.start_utc === b.start_utc && a.end_utc === b.end_utc && a.time_zone === b.time_zone; }
function details(metric: Evidence): string[] {
  return [`口径：${metric.definition}`, `来源：${metric.source.label}${metric.source.reference ? ` (${metric.source.reference})` : ""}`, `数据完整至：${metric.source.complete_through_utc}`, `统计窗口：${windowText(metric.window)}`];
}
function evidenceFailure(metric: Evidence, generatedAt: string, end = metric.window.end_utc): Reason | undefined {
  if (!metric.definition_confirmed) return "definition_unconfirmed";
  if (!metric.source.confirmed) return "source_unconfirmed";
  if (end > generatedAt || metric.source.complete_through_utc < end || metric.source.complete_through_utc > generatedAt) return "incomplete_data";
}
function ratioValue(metric: Ratio, context: string[]): MetricResult {
  if (metric.numerator === null || metric.denominator === null) return unknown("missing_value", context);
  const numerator = BigInt(metric.numerator), denominator = BigInt(metric.denominator);
  if (numerator > denominator) throw new Error("invalid_report_snapshot");
  if (denominator === 0n) return unknown("zero_denominator", context);
  const scaled = (numerator * 10_000n + denominator / 2n) / denominator;
  return { status: "known", value: `${scaled / 100n}.${(scaled % 100n).toString().padStart(2, "0")}% (${numerator}/${denominator})`, details: context };
}
function retention(metric: Retention | undefined, generatedAt: string, reportingWindow: Window): MetricResult {
  if (!metric) return unknown("not_provided");
  const context = [...details(metric), `次日观察窗口：${windowText(metric.followup_window)}`];
  const failure = evidenceFailure(metric, generatedAt, metric.followup_window.end_utc);
  if (failure) return unknown(failure, context);
  if (!sameWindow(metric.followup_window, reportingWindow)) return unknown("window_mismatch", context);
  if (!fullLocalDay(metric.window) || !fullLocalDay(metric.followup_window) || metric.window.end_utc !== metric.followup_window.start_utc || metric.window.time_zone !== metric.followup_window.time_zone) return unknown("invalid_next_day_window", context);
  return ratioValue(metric, context);
}

export function composeReport(input: unknown) {
  const parsed = composeReportSchema.safeParse(input);
  if (!parsed.success) throw new Error("invalid_report_snapshot");
  const report = parsed.data;
  if (report.window.end_utc > report.generated_at_utc || !fullLocalDay(report.window)) throw new Error("invalid_report_snapshot");
  const metric = report.metrics;
  const output: Record<string, MetricResult> = {
    new_user_next_day_retention: retention(metric.new_user_next_day_retention, report.generated_at_utc, report.window),
    active_next_day_retention: retention(metric.active_next_day_retention, report.generated_at_utc, report.window),
  };
  if (!metric.chat_rate) output.chat_rate = unknown("not_provided");
  else {
    const chat = metric.chat_rate, context = details(chat), failure = evidenceFailure(chat, report.generated_at_utc);
    output.chat_rate = failure ? unknown(failure, context) : !sameWindow(chat.window, report.window) ? unknown("window_mismatch", context) : ratioValue(chat, context);
  }
  if (!metric.mode_message_counts) output.mode_message_counts = unknown("not_provided");
  else {
    const modes = metric.mode_message_counts, context = details(modes), failure = evidenceFailure(modes, report.generated_at_utc);
    if (failure) output.mode_message_counts = unknown(failure, context);
    else if (!sameWindow(modes.window, report.window)) output.mode_message_counts = unknown("window_mismatch", context);
    else {
      const complete = modes.coverage_complete && modes.modes.every(item => item.count !== null);
      const total = complete ? modes.modes.reduce((sum, item) => sum + BigInt(item.count!), 0n).toString() : null;
      output.mode_message_counts = { status: complete ? "known" : "unknown", value: total, ...(!complete ? { reason: "missing_value" as const } : {}), details: [...context, ...modes.modes.map(item => `${item.mode}：${item.count ?? "未知"}`), ...(!modes.coverage_complete ? ["模式覆盖范围未确认，不能计算总计。"] : [])] };
    }
  }
  if (!metric.openrouter_cost) output.openrouter_cost = unknown("not_provided");
  else {
    const cost = metric.openrouter_cost, context = details(cost), failure = evidenceFailure(cost, report.generated_at_utc);
    output.openrouter_cost = failure ? unknown(failure, context)
      : cost.window_precision !== "exact" ? unknown("coarse_cost_window", context)
      : !sameWindow(cost.window, report.window) ? unknown("window_mismatch", context)
      : cost.amount === null ? unknown("missing_value", context)
      : { status: "known", value: `USD ${cost.amount}`, details: context };
  }
  const labels = { new_user_next_day_retention: "新增次留", active_next_day_retention: "活跃次留", chat_rate: "聊天率", mode_message_counts: "模式聊天条数（总计）", openrouter_cost: "OpenRouter 成本" };
  const text = [report.title, `日报窗口：${windowText(report.window)}`, `快照生成时间：${report.generated_at_utc}`, "", ...Object.entries(labels).flatMap(([key, label]) => {
    const result = output[key];
    return [`${label}：${result.status === "known" ? result.value : `未知（${reasonText[result.reason!]}）`}`, ...result.details.map(line => `  ${line}`), ""];
  }), "依据提供的快照生成；来源与口径确认状态由输入声明，未联网核验。", "仅为草稿，未保存、入队或发送。"].join("\n");
  const snapshot = JSON.stringify(report);
  return { schema_version: 1, snapshot_sha256: createHash("sha256").update(snapshot).digest("hex"), text, metrics: output, source_verified_live: false, persisted: false, enqueued: false, sent: false, plan: planReport(text, report.max_chunk_length) };
}
