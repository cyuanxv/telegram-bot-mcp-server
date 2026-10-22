const literal = (text: string) => "'" + text.replaceAll("'", "''") + "'";
/** Offline operator plan only. Applying it requires approval for this Bot's
 * retention/deletion scope and access to the independent Telegram database. */
export function planInboxRetention(botAlias: string) {
  if (typeof botAlias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(botAlias) || botAlias === 'default') throw new Error('Choose an exact new Bot alias; default already has its own retention job');
  const jobName = 'telegram-inbox-retention-' + botAlias, schedule = '*/5 * * * *';
  const target = literal(botAlias), job = literal(jobName);
  const cleanupSql = `DELETE FROM public.telegram_inbox_events
WHERE bot_alias = ${target}
  AND expires_at <= floor(extract(epoch FROM now()) * 1000)::bigint;
DELETE FROM cron.job_run_details
WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname = ${job} AND username = current_user)
  AND end_time < now() - interval '7 days';`;
  const installSql = `-- Review and approve this exact Bot before applying. Does not grant runtime DELETE.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5s';
LOCK TABLE cron.job IN SHARE ROW EXCLUSIVE MODE;
DO $install$
DECLARE existing record;
BEGIN
  SELECT * INTO existing FROM cron.job WHERE jobname = ${job} AND username = current_user;
  IF FOUND THEN
    IF existing.schedule IS DISTINCT FROM ${literal(schedule)}
      OR existing.command IS DISTINCT FROM ${literal(cleanupSql)}
      OR existing.database IS DISTINCT FROM current_database()
      OR existing.active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Existing inbox retention job differs; inspect before changing it';
    END IF;
  ELSE
    PERFORM cron.schedule(${job}, ${literal(schedule)}, ${literal(cleanupSql)});
  END IF;
END
$install$;
COMMIT;`;
  const verifySql = `SELECT jobid,jobname,schedule,active,database FROM cron.job WHERE jobname = ${job} AND username = current_user;
SELECT count(*) AS expired_rows FROM public.telegram_inbox_events WHERE bot_alias = ${target} AND expires_at <= floor(extract(epoch FROM now()) * 1000)::bigint;
SELECT status,start_time,end_time FROM cron.job_run_details WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname = ${job} AND username = current_user) ORDER BY start_time DESC LIMIT 3;`;
  return {plan_only:true,bot_alias:botAlias,job_name:jobName,schedule,cleanup_sql:cleanupSql,install_sql:installSql,verify_sql:verifySql,
    note:'No database access or scheduling performed. Expiry assigned at ingestion is authoritative. Disabling a Bot does not cancel retention; paused databases catch up only after resuming.'};
}
