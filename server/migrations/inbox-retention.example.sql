-- OPTIONAL EXAMPLE: review retention policy before applying to your own database.
-- Expiry is assigned at ingestion; reads hide expired rows immediately.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

SELECT cron.schedule(
  'telegram-default-inbox-retention',
  '*/5 * * * *',
  $job$
  DELETE FROM public.telegram_inbox_events
  WHERE bot_alias = 'default'
    AND expires_at <= floor(extract(epoch FROM now()) * 1000)::bigint;
  DELETE FROM cron.job_run_details
  WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname = 'telegram-default-inbox-retention')
    AND end_time < now() - interval '7 days';
  $job$
);
