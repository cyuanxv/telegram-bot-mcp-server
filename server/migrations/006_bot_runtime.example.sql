-- REVIEW ONLY. Apply only after explicit approval of 003, 006 and runtime access.
-- Single owner for this private service. TELEGRAM_VAULT_OWNER_ID must match
-- 'telegram-cloud-owner'. No change to report/inbox tables or role passwords.
BEGIN;
ALTER TABLE public.telegram_credential_vault ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_credential_vault FROM PUBLIC;
REVOKE ALL ON public.telegram_bot_directory FROM PUBLIC;
-- Remove Supabase default API grants on these private tables only.
DO $roles$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON public.telegram_credential_vault, public.telegram_bot_directory FROM %I', role_name);
    END IF;
  END LOOP;
END $roles$;
GRANT SELECT, INSERT, UPDATE ON public.telegram_credential_vault, public.telegram_bot_directory TO telegram_runtime;
CREATE POLICY telegram_vault_single_owner ON public.telegram_credential_vault
  FOR ALL TO telegram_runtime
  USING (owner_id = 'telegram-cloud-owner' AND purpose = 'bot_token')
  WITH CHECK (owner_id = 'telegram-cloud-owner' AND purpose = 'bot_token');
CREATE POLICY telegram_directory_single_owner ON public.telegram_bot_directory
  FOR ALL TO telegram_runtime
  USING (owner_id = 'telegram-cloud-owner' AND purpose = 'bot_token')
  WITH CHECK (owner_id = 'telegram-cloud-owner' AND purpose = 'bot_token');
COMMIT;
-- No DELETE/TRUNCATE/admin grant. Do not apply over unknown existing grants or
-- policies; inspect them first. This example is not a multi-tenant policy.
