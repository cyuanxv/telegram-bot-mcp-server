-- Rich v2 metadata only, fixed-owner runtime access, no content or credentials.
BEGIN;
CREATE TABLE public.telegram_rich_sessions (
 owner_id TEXT NOT NULL, id UUID NOT NULL, document JSONB NOT NULL,
 PRIMARY KEY(owner_id,id), CHECK(jsonb_typeof(document)='object'),
 CHECK(document->>'owner'=owner_id), CHECK(document->>'id'=id::text)
);
ALTER TABLE public.telegram_rich_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_rich_sessions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON public.telegram_rich_sessions TO telegram_runtime;
CREATE POLICY telegram_rich_single_owner ON public.telegram_rich_sessions FOR ALL TO telegram_runtime
 USING(owner_id='telegram-cloud-owner') WITH CHECK(owner_id='telegram-cloud-owner');
COMMIT;
