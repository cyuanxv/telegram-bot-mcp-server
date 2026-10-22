-- Candidate only. Separate approval required; never executed at startup.
CREATE TABLE IF NOT EXISTS public.telegram_account_directory (
 owner_id TEXT NOT NULL,
 alias TEXT NOT NULL CHECK (alias ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 purpose TEXT NOT NULL DEFAULT 'mtproto_account' CHECK (purpose='mtproto_account'),
 user_id TEXT NOT NULL CHECK (user_id ~ '^[1-9][0-9]{0,15}$' AND user_id::numeric <= 9007199254740991),
 vault_revision BIGINT NOT NULL CHECK (vault_revision BETWEEN 1 AND 9007199254740991),
 revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
 active BOOLEAN NOT NULL DEFAULT false,
 scope JSONB NOT NULL CHECK (jsonb_typeof(scope)='object' AND octet_length(scope::text)<=16384),
 PRIMARY KEY(owner_id,alias),
 FOREIGN KEY(owner_id,alias,purpose) REFERENCES public.telegram_credential_vault(owner_id,alias,purpose)
);
ALTER TABLE public.telegram_account_directory ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_account_directory FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON public.telegram_account_directory FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
-- No runtime grants or policies: reviewed fixed-owner access is a separate step.
