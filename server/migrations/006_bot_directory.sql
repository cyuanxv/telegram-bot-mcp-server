-- Explicit opt-in only, after separately approved migration 003. Never run at startup.
CREATE TABLE IF NOT EXISTS public.telegram_bot_directory (
  owner_id TEXT NOT NULL,
  alias TEXT NOT NULL CHECK (alias ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  purpose TEXT NOT NULL DEFAULT 'bot_token' CHECK (purpose = 'bot_token'),
  bot_id BIGINT NOT NULL CHECK (bot_id > 0 AND bot_id <= 9007199254740991),
  vault_revision BIGINT NOT NULL CHECK (vault_revision > 0 AND vault_revision <= 9007199254740991),
  revision BIGINT NOT NULL CHECK (revision > 0 AND revision <= 9007199254740991),
  active BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (owner_id, alias),
  FOREIGN KEY (owner_id,alias,purpose) REFERENCES public.telegram_credential_vault(owner_id,alias,purpose)
);
ALTER TABLE public.telegram_bot_directory ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_bot_directory FROM PUBLIC;
-- Runtime role grants/RLS require a separate reviewed deployment step.
