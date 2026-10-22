import type { SqlExecutor, SqlResult, TransactionalSql } from "./postgres-store";
export interface PgClient {
  query(sql: string, values?: unknown[]): Promise<SqlResult>;
  release(destroy?: boolean): void;
}
export interface PgPool { connect(): Promise<PgClient> }
/** Structural adapter for an already-authorized pg Pool. Never accepts URLs or creates credentials. */
export class PgPoolDatabase implements TransactionalSql {
  private pool: PgPool; private guard?: () => void;
  constructor(pool: PgPool, options: { guard?: () => void } = {}) { this.pool = pool; this.guard = options.guard; }
  async transaction<T>(change: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    this.guard?.();
    let client: PgClient;
    try { client = await this.pool.connect(); } catch { throw new Error("Delivery database connection failed"); }
    let began = false; let destroy = false; let queryFailed = false;
    const sql: SqlExecutor = { query: async (query, values) => {
      try { this.guard?.(); } catch (error) { queryFailed = true; throw error; }
      try { return await client.query(query, values); }
      catch { queryFailed = true; throw new Error("Delivery database operation failed"); }
    } };
    try {
      await sql.query("BEGIN"); began = true;
      await sql.query("SET LOCAL statement_timeout = '5000ms'");
      await sql.query("SET LOCAL lock_timeout = '5000ms'");
      const result = await change(sql);
      if (queryFailed) throw new Error("Delivery database transaction was aborted by an earlier query failure");
      const committed = await sql.query("COMMIT");
      if (committed.command !== "COMMIT") throw new Error("Delivery database did not acknowledge a committed transaction");
      began = false;
      return result;
    } catch (error) {
      if (began) { try { await client.query("ROLLBACK"); } catch { destroy = true; } }
      else destroy = true;
      throw error;
    } finally { client.release(destroy); }
  }
}
