-- Review separately; apply only after 004_callback_answers.sql to the approved database.
-- Requires the already-approved telegram_runtime role. Never creates credentials.
GRANT SELECT, INSERT, UPDATE ON public.telegram_callback_answers TO telegram_runtime;
CREATE POLICY telegram_callback_runtime ON public.telegram_callback_answers
  FOR ALL TO telegram_runtime USING (true) WITH CHECK (true);
-- No anonymous/authenticated grants; no runtime DELETE. Expiry follows inbox CASCADE.
