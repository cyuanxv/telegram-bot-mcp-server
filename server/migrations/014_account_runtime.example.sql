-- REVIEW ONLY. Requires separate approval of 012/013/014 and runtime access.
-- Preserves existing Bot policies; adds only fixed-owner personal-account access.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='telegram_runtime'
   AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb)
   OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='telegram_runtime')) THEN
  RAISE EXCEPTION 'telegram_runtime must be an unprivileged role without role memberships';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public'
   AND tablename IN ('telegram_credential_vault','telegram_account_directory','telegram_account_peers','telegram_account_login')
   AND tableowner='telegram_runtime') THEN
  RAISE EXCEPTION 'runtime must not own account tables';
 END IF;
END $$;
ALTER TABLE public.telegram_credential_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_account_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_account_peers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_account_login ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.telegram_credential_vault,
 public.telegram_account_directory, public.telegram_account_peers TO telegram_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.telegram_account_login TO telegram_runtime;
CREATE POLICY telegram_vault_account_owner ON public.telegram_credential_vault
 FOR ALL TO telegram_runtime
 USING (owner_id='telegram-cloud-owner' AND purpose='mtproto_account')
 WITH CHECK (owner_id='telegram-cloud-owner' AND purpose='mtproto_account');
CREATE POLICY telegram_account_directory_owner ON public.telegram_account_directory
 FOR ALL TO telegram_runtime
 USING (owner_id='telegram-cloud-owner') WITH CHECK (owner_id='telegram-cloud-owner');
CREATE POLICY telegram_account_peers_owner ON public.telegram_account_peers
 FOR ALL TO telegram_runtime
 USING (owner_id='telegram-cloud-owner') WITH CHECK (owner_id='telegram-cloud-owner');
CREATE POLICY telegram_account_login_owner ON public.telegram_account_login
 FOR ALL TO telegram_runtime
 USING (owner_id='telegram-cloud-owner') WITH CHECK (owner_id='telegram-cloud-owner');
COMMIT;
-- Inspect existing grants/policies before application: permissive policies combine
-- with OR. This proposal does not remove unknown policies or enable any feature.
-- DELETE is limited to temporary login challenges; no vault/directory/peer DELETE.
