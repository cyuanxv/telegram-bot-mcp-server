-- Proposal only: requires separate migration, owner grants and retention approval.
-- Metadata and content digests only; no preview text or credentials.
CREATE TABLE public.telegram_draft_sessions (
 owner_id TEXT NOT NULL,
 id UUID NOT NULL,
 document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
 PRIMARY KEY(owner_id,id),
 CHECK(length(owner_id) BETWEEN 1 AND 128),
 CHECK(document->>'ownerId'=owner_id),
 CHECK(document->>'id'=id::text)
);
ALTER TABLE public.telegram_draft_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_draft_sessions FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON public.telegram_draft_sessions FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
