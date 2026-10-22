-- REVIEW ONLY: apply after explicit approval of 011 and runtime access.
-- Same fixed private owner as 006/007; no role, password, token or other-table changes.
BEGIN;
GRANT SELECT, INSERT, UPDATE ON public.telegram_draft_sessions TO telegram_runtime;
CREATE POLICY telegram_draft_single_owner ON public.telegram_draft_sessions
 FOR ALL TO telegram_runtime
 USING (owner_id='telegram-cloud-owner')
 WITH CHECK (owner_id='telegram-cloud-owner');
COMMIT;
-- Metadata only, maximum 10,000 records; no automatic deletion. Reservations
-- survive stop/finalization to prevent replay and draft-identity reuse.
-- No DELETE/TRUNCATE grant. Inspect existing policies before application.
