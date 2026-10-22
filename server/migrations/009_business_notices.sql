-- Proposal only. Apply and grant a fixed-owner runtime role only after approval.
-- Lifecycle notifications are observations, NEVER proof of current permission.
CREATE TABLE public.telegram_business_notices (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_alias TEXT NOT NULL,
  update_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  document JSONB NOT NULL,
  UNIQUE(bot_alias, update_id),
  CHECK ((jsonb_typeof(document) = 'object') IS TRUE),
  CHECK ((document->>'botAlias' = bot_alias) IS TRUE),
  CHECK ((document->>'updateId' = update_id) IS TRUE),
  CHECK ((document->>'connectionId' = connection_id) IS TRUE),
  CHECK ((document->>'fingerprint' = fingerprint) IS TRUE),
  CHECK (((document->>'expiresAt')::bigint = expires_at) IS TRUE),
  CHECK ((document->'observation'->>'kind' IN ('connection','deleted')) IS TRUE),
  CHECK (octet_length(document::text) <= 262144)
);
ALTER TABLE public.telegram_business_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_business_notices FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.telegram_business_notices_sequence_seq FROM PUBLIC;
CREATE INDEX telegram_business_notices_scope ON public.telegram_business_notices(bot_alias,connection_id,sequence);
CREATE INDEX telegram_business_notices_expiry ON public.telegram_business_notices(expires_at);
