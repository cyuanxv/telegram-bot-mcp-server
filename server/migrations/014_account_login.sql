-- Candidate only. Separate storage and retention approval required; never auto-run.
CREATE TABLE IF NOT EXISTS public.telegram_account_login (
 owner_id TEXT NOT NULL,
 id UUID NOT NULL,
 alias TEXT NOT NULL CHECK(alias ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 revision BIGINT NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 expires_at BIGINT NOT NULL CHECK(expires_at > 0),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 claim UUID,
 envelope JSONB CHECK(envelope IS NULL OR (jsonb_typeof(envelope)='object' AND octet_length(envelope::text)<=24000)),
 PRIMARY KEY(owner_id,id)
);
CREATE INDEX IF NOT EXISTS telegram_account_login_expiry ON public.telegram_account_login(expires_at);
ALTER TABLE public.telegram_account_login ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_account_login FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON public.telegram_account_login FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
