-- Apply only to the approved private database; never auto-run. Explicit retention approval is required.
CREATE TABLE IF NOT EXISTS public.telegram_inbox_events (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_alias TEXT NOT NULL,
  update_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  document JSONB NOT NULL,
  UNIQUE(bot_alias, update_id),
  CHECK ((jsonb_typeof(document) = 'object') IS TRUE),
  CHECK ((document->>'botAlias' = bot_alias) IS TRUE),
  CHECK ((document->>'updateId' = update_id) IS TRUE),
  CHECK ((document->>'chatId' = chat_id) IS TRUE),
  CHECK ((document->>'fingerprint' = fingerprint) IS TRUE),
  CHECK (((document->>'expiresAt')::bigint = expires_at) IS TRUE),
  CHECK (octet_length(document::text) <= 131072)
);
CREATE INDEX IF NOT EXISTS telegram_inbox_scope_sequence ON public.telegram_inbox_events(bot_alias, chat_id, sequence);
