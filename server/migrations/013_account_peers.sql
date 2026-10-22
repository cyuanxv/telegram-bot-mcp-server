-- Candidate only: requires separately approved account runtime storage. Never auto-run.
CREATE TABLE IF NOT EXISTS public.telegram_account_peers (
 owner_id TEXT NOT NULL,
 alias TEXT NOT NULL CHECK (alias ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 purpose TEXT NOT NULL DEFAULT 'mtproto_account' CHECK (purpose='mtproto_account'),
 user_id TEXT NOT NULL CHECK (user_id ~ '^[1-9][0-9]{0,15}$'),
 vault_revision BIGINT NOT NULL CHECK (vault_revision BETWEEN 1 AND 9007199254740991),
 peer_id TEXT NOT NULL CHECK (peer_id ~ '^-?[1-9][0-9]{0,19}$'),
 envelope JSONB NOT NULL CHECK (jsonb_typeof(envelope)='object' AND octet_length(envelope::text)<=4096),
 PRIMARY KEY(owner_id,alias,peer_id),
 FOREIGN KEY(owner_id,alias,purpose) REFERENCES public.telegram_credential_vault(owner_id,alias,purpose)
);
ALTER TABLE public.telegram_account_peers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_account_peers FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON public.telegram_account_peers FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
-- No runtime grants. Metadata is not message content; access hashes remain encrypted.
