-- Requires explicit approval; no DELETE grant and no expiry job.
GRANT SELECT, INSERT, UPDATE ON public.telegram_media_deliveries TO telegram_runtime;
CREATE POLICY telegram_media_runtime ON public.telegram_media_deliveries
 FOR ALL TO telegram_runtime USING (true) WITH CHECK (true);
