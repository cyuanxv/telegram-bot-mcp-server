-- Apply only to the explicitly approved private database/schema. Never auto-run at import/startup.
-- The runtime role needs SELECT/INSERT/UPDATE on this table; no broad admin credentials are required.
CREATE TABLE IF NOT EXISTS public.telegram_delivery_reports (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  document JSONB NOT NULL,
  CHECK (jsonb_typeof(document) = 'object'),
  CHECK ((jsonb_typeof(document->'id') = 'string' AND document->>'id' = id) IS TRUE),
  CHECK ((jsonb_typeof(document->'idempotencyKey') = 'string' AND document->>'idempotencyKey' = idempotency_key) IS TRUE),
  CHECK (octet_length(document::text) <= 2097152)
);
