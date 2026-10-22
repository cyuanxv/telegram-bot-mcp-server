-- Explicit opt-in migration. Never executed by startup or deployment.
-- No text, callback payload, query ID, token or credentials are stored here.
CREATE TABLE IF NOT EXISTS public.telegram_callback_answers (
  callback_key TEXT PRIMARY KEY CHECK (callback_key ~ '^[a-f0-9]{64}$'),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  inbox_sequence BIGINT NOT NULL REFERENCES public.telegram_inbox_events(sequence) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('inflight','answered','unknown')),
  created_at BIGINT NOT NULL CHECK (created_at >= 0)
);
ALTER TABLE public.telegram_callback_answers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_callback_answers FROM PUBLIC;
-- Operator must separately grant the approved runtime role SELECT/INSERT/UPDATE
-- and an appropriate RLS policy. No DELETE is needed: inbox expiry cascades.

-- Also remove explicit/default grants on API roles; PUBLIC revocation alone
-- does not revoke them, including roles that can bypass RLS.
DO $$ DECLARE role_name TEXT; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON public.telegram_callback_answers FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
