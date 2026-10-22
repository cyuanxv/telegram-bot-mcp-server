-- Candidate only; no startup execution or runtime grants.
CREATE TABLE IF NOT EXISTS public.telegram_polling_cursors (
 owner_id TEXT NOT NULL,
 bot_alias TEXT NOT NULL CHECK(bot_alias ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 bot_id TEXT NOT NULL CHECK(bot_id ~ '^[1-9][0-9]{0,15}$'),
 next_offset BIGINT NOT NULL DEFAULT 0 CHECK(next_offset BETWEEN 0 AND 2147483648),
 UNIQUE(bot_id),
 PRIMARY KEY(owner_id,bot_alias)
);
ALTER TABLE public.telegram_polling_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_polling_cursors FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON public.telegram_polling_cursors FROM %I',r);
  END IF;
 END LOOP;
END $$;
