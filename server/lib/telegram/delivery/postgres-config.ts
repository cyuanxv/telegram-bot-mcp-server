/** Validate an explicitly enabled PostgreSQL transport without connecting or exposing its URL. */
export function postgresConnectionConfig(env: Record<string, string | undefined>) {
  if (env.TELEGRAM_DELIVERY_POSTGRES_ENABLED !== "true") throw new Error("PostgreSQL delivery storage is disabled until its target and access are explicitly approved");
  const connectionString = env.TELEGRAM_DELIVERY_DATABASE_URL;
  if (!connectionString) throw new Error("Approved PostgreSQL delivery configuration is missing");
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new Error("Invalid PostgreSQL delivery configuration"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2 || url.hash || url.search) {
    throw new Error("PostgreSQL delivery requires a database URL without query/fragment options; verified TLS is mandatory");
  }
  // Some managed providers use their own CA. Trust only the explicitly supplied
  // certificate; keep certificate and hostname verification enabled.
  const ca = env.TELEGRAM_DELIVERY_DATABASE_CA_PEM;
  if (ca !== undefined && (!ca.trim().startsWith("-----BEGIN CERTIFICATE-----") || !ca.trim().endsWith("-----END CERTIFICATE-----") || ca.length > 32768)) {
    throw new Error("Invalid PostgreSQL CA certificate configuration");
  }
  return { connectionString, ssl: { rejectUnauthorized: true as const, ...(ca ? { ca } : {}) }, max: 4,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 5000, query_timeout: 10000 };
}
