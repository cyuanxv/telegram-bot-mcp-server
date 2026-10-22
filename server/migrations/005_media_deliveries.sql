-- Source only. Apply separately after approval; deployments never run migrations.
-- No file bytes, caption, filename, credentials or raw recipient IDs are stored.
CREATE TABLE IF NOT EXISTS public.telegram_media_deliveries (
 request_key TEXT PRIMARY KEY CHECK (request_key ~ '^[a-f0-9]{64}$'),
 fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
 state TEXT NOT NULL CHECK (state IN ('inflight','sent','unknown')),
 message_id BIGINT,
 created_at BIGINT NOT NULL CHECK (created_at >= 0),
 CHECK ((state='sent' AND message_id IS NOT NULL AND message_id > 0 AND message_id <= 9007199254740991) OR (state IN ('inflight','unknown') AND message_id IS NULL))
);
ALTER TABLE public.telegram_media_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_media_deliveries FROM PUBLIC;

-- Also remove explicit/default grants on API roles; PUBLIC revocation alone
-- does not revoke them, including roles that can bypass RLS.
DO $$ DECLARE role_name TEXT; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON public.telegram_media_deliveries FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
