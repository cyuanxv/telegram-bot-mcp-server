-- Opt-in deployment migration only. No application startup auto-migration.
-- This table stores sealed envelopes only. Keys belong in a separately approved secret manager.
CREATE TABLE IF NOT EXISTS public.telegram_credential_vault (
  owner_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('bot_token','mtproto_account')),
  revision BIGINT NOT NULL CHECK (revision > 0 AND revision <= 9007199254740991),
  envelope JSONB NOT NULL,
  PRIMARY KEY(owner_id,alias,purpose),
  CHECK ((jsonb_typeof(envelope) = 'object') IS TRUE),
  CHECK ((envelope->>'ownerId' = owner_id) IS TRUE),
  CHECK ((envelope->>'alias' = alias) IS TRUE),
  CHECK ((envelope->>'purpose' = purpose) IS TRUE),
  CHECK (((envelope->>'revision')::bigint = revision) IS TRUE),
  CHECK (octet_length(envelope::text) <= 32768)
);
