import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute } from "node:path";
import { closeSync, lstatSync, openSync } from "node:fs";
import { copy, type QueueStore, type ReportJob } from "./types";
import { checkJob, MAX_STORED_REPORTS, requireSameDraft } from "./store";

/** Node 24 persistent-volume adapter. Not suitable for ephemeral/serverless filesystems. */
export class SqliteQueueStore implements QueueStore {
  private db: DatabaseSync;
  constructor(filename: string) {
    if (!isAbsolute(filename)) throw new Error("SQLite report storage requires an absolute durable-volume path");
    if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      throw new Error("SQLite delivery storage is disabled on ephemeral serverless hosts; use an approved transactional persistent adapter");
    }
    const parent = lstatSync(dirname(filename));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0
      || typeof process.getuid !== "function" || parent.uid !== process.getuid()) {
      throw new Error("Delivery database requires a private directory owned by this service user");
    }
    try { closeSync(openSync(filename, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const file = lstatSync(filename);
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid() || (file.mode & 0o077) !== 0) {
      throw new Error("Delivery database must be a private regular file with no group or public access");
    }
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
      if (version !== 0 && version !== 1) throw new Error("Unsupported delivery database schema");
      this.db.exec("CREATE TABLE IF NOT EXISTS delivery_reports (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, document TEXT NOT NULL); PRAGMA user_version=1;");
    } catch (error) { this.db.close(); throw error; }
  }
  private decode(row: Record<string, unknown> | undefined): ReportJob | undefined {
    if (!row) return undefined;
    let job: ReportJob;
    try { job = JSON.parse(String(row.document)); } catch { throw new Error("Corrupted report record; dispatch refused"); }
    checkJob(job); return job;
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  create(job: ReportJob): ReportJob {
    return this.transaction(() => {
      const existing = this.decode(this.db.prepare("SELECT document FROM delivery_reports WHERE idempotency_key=?").get(job.idempotencyKey));
      if (existing) return requireSameDraft(existing, job);
      const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM delivery_reports").get()?.n);
      if (count >= MAX_STORED_REPORTS) throw new Error("Report storage capacity reached");
      checkJob(job);
      this.db.prepare("INSERT INTO delivery_reports(id,idempotency_key,document) VALUES(?,?,?)").run(job.id, job.idempotencyKey, JSON.stringify(job));
      return copy(job);
    });
  }
  get(id: string) { return this.decode(this.db.prepare("SELECT document FROM delivery_reports WHERE id=?").get(id)); }
  update<T>(id: string, change: (job: ReportJob) => T): T {
    return this.transaction(() => {
      const job = this.get(id); if (!job) throw new Error("Unknown report");
      const result = change(job); checkJob(job);
      this.db.prepare("UPDATE delivery_reports SET document=? WHERE id=?").run(JSON.stringify(job), id);
      return copy(result);
    });
  }
  close() { this.db.close(); }
}
