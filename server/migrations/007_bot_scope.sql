-- Review only: persistent private Bot permissions. Not applied at startup.
-- Requires 003 and 006. Existing Bots and activation state are not modified.
CREATE TABLE IF NOT EXISTS public.telegram_bot_scope (
 owner_id TEXT NOT NULL,
 alias TEXT NOT NULL CHECK(alias ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 purpose TEXT NOT NULL DEFAULT 'bot_token' CHECK(purpose='bot_token'),
 bot_id BIGINT NOT NULL CHECK(bot_id > 0 AND bot_id <= 9007199254740991),
 vault_revision BIGINT NOT NULL CHECK(vault_revision > 0 AND vault_revision <= 9007199254740991),
 revision BIGINT NOT NULL CHECK(revision > 0 AND revision <= 9007199254740991),
 policy JSONB NOT NULL CHECK(jsonb_typeof(policy)='object'),
 PRIMARY KEY(owner_id,alias),
 FOREIGN KEY(owner_id,alias,purpose) REFERENCES public.telegram_credential_vault(owner_id,alias,purpose)
);
ALTER TABLE public.telegram_bot_scope ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_bot_scope FROM PUBLIC;
DO $roles$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON public.telegram_bot_scope FROM %I',role_name);
  END IF;
 END LOOP;
END $roles$;
-- Runtime role grants and fixed-owner RLS require reviewed application.

-- Bind activation to the permission version. Null preserves legacy mode only.
ALTER TABLE public.telegram_bot_directory ADD COLUMN IF NOT EXISTS scope_revision BIGINT
 CHECK(scope_revision > 0 AND scope_revision <= 9007199254740991);
