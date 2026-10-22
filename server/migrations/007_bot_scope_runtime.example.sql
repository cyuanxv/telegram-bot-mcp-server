-- REVIEW ONLY: separate approval required for 007 and runtime access.
-- Fixed private owner; no role/password changes or grants on other tables.
BEGIN;
GRANT SELECT, INSERT, UPDATE ON public.telegram_bot_scope TO telegram_runtime;
CREATE POLICY telegram_scope_single_owner ON public.telegram_bot_scope
 FOR ALL TO telegram_runtime
 USING (owner_id='telegram-cloud-owner' AND purpose='bot_token')
 WITH CHECK (owner_id='telegram-cloud-owner' AND purpose='bot_token');
COMMIT;
