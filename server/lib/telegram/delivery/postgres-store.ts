import { copy, type AsyncQueueStore, type ReportJob } from "./types";
import { checkJob, MAX_STORED_REPORTS, requireSameDraft } from "./store";

export type SqlResult = { rows: Record<string, unknown>[]; command?: string };
export interface SqlExecutor { query(sql: string, values?: unknown[]): Promise<SqlResult> }
/** Each callback owns one committed/rolled-back transaction on one connection. */
export interface TransactionalSql { transaction<T>(change: (sql: SqlExecutor) => Promise<T>): Promise<T> }

/** Shared-database adapter. No credentials, schema creation or network client are created here. */
export class PostgresQueueStore implements AsyncQueueStore {
  private database: TransactionalSql;
  constructor(database: TransactionalSql) { this.database = database; }
  private decode(row: Record<string, unknown> | undefined): ReportJob | undefined {
    if (!row) return undefined;
    const job = copy(row.document) as ReportJob; checkJob(job); return job;
  }
  create(supplied: ReportJob): Promise<ReportJob> {
    const job = copy(supplied);
    checkJob(job);
    return this.database.transaction(async sql => {
      // Serializes creates, including the global capacity check and duplicate-key check.
      // It does not hold a lock while any Telegram transport runs.
      await sql.query("LOCK TABLE public.telegram_delivery_reports IN SHARE ROW EXCLUSIVE MODE");
      const prior = this.decode((await sql.query("SELECT document FROM public.telegram_delivery_reports WHERE idempotency_key=$1", [job.idempotencyKey])).rows[0]);
      if (prior) return requireSameDraft(prior, job);
      const count = Number((await sql.query("SELECT COUNT(*) AS n FROM public.telegram_delivery_reports")).rows[0]?.n);
      if (!Number.isSafeInteger(count) || count >= MAX_STORED_REPORTS) throw new Error("Report storage capacity reached");
      await sql.query("INSERT INTO public.telegram_delivery_reports(id,idempotency_key,document) VALUES($1,$2,$3::jsonb)", [job.id, job.idempotencyKey, JSON.stringify(job)]);
      return copy(job);
    });
  }
  get(id: string): Promise<ReportJob | undefined> {
    return this.database.transaction(async sql => this.decode((await sql.query("SELECT document FROM public.telegram_delivery_reports WHERE id=$1", [id])).rows[0]));
  }
  update<T>(id: string, change: (job: ReportJob) => T): Promise<T> {
    return this.database.transaction(async sql => {
      const job = this.decode((await sql.query("SELECT document FROM public.telegram_delivery_reports WHERE id=$1 FOR UPDATE", [id])).rows[0]);
      if (!job) throw new Error("Unknown report");
      const identity = { id: job.id, key: job.idempotencyKey };
      const result = change(job); checkJob(job);
      if (job.id !== identity.id || job.idempotencyKey !== identity.key) throw new Error("Report storage identity cannot change");
      // clone before writing: thenables/nonserializable callback results cannot commit a partial mutation.
      const answer = copy(result);
      await sql.query("UPDATE public.telegram_delivery_reports SET document=$1::jsonb WHERE id=$2", [JSON.stringify(job), id]);
      return answer;
    });
  }
}
