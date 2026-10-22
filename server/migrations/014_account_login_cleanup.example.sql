-- REVIEW ONLY: approved scheduler may execute this transaction every five minutes.
-- No extension installation or scheduler registration is performed by this file.
BEGIN;
SET LOCAL ROLE telegram_runtime;
DELETE FROM public.telegram_account_login
 WHERE owner_id='telegram-cloud-owner'
 AND expires_at <= floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint;
COMMIT;
-- Uses the ordinary runtime RLS policy. Preserves unexpired and other-owner rows.
-- A missed scheduler execution must be surfaced operationally; five minutes is
-- the requested cadence, not a guaranteed deletion SLA during an outage.
