import test from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {spawnSync} from 'node:child_process';
import {planInboxRetention} from '../lib/telegram/inbox/retention-plan.ts';
async function setup(t){
 const pg=new PGlite();t.after(()=>pg.close());
 await pg.exec(`CREATE SCHEMA cron;
 CREATE TABLE cron.job(jobid bigserial PRIMARY KEY,jobname text, schedule text,command text,database text DEFAULT current_database(),username text DEFAULT current_user,active boolean DEFAULT true,UNIQUE(jobname,username));
 CREATE TABLE cron.job_run_details(jobid bigint,status text,start_time timestamptz,end_time timestamptz);
 CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE SQL AS $$ INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3) ON CONFLICT(jobname,username) DO UPDATE SET schedule=$2,command=$3 RETURNING jobid $$;
 CREATE TABLE public.telegram_inbox_events(bot_alias text,expires_at bigint);`);
 return pg;
}
test('offline plans reject ambiguous aliases and preserve the existing default job',()=>{
 for(const alias of ['default','',"x';DELETE FROM anything;--",'../x','@reports','x\ny','a'.repeat(65),null])assert.throws(()=>planInboxRetention(alias));
 const p=planInboxRetention('reports');assert.equal(p.plan_only,true);assert.equal(p.schedule,'*/5 * * * *');assert.ok(!p.install_sql.includes('CREATE EXTENSION'));assert.ok(!p.install_sql.includes('GRANT'));assert.ok(!p.cleanup_sql.includes('vault'));
});
test('installation is idempotent and refuses an existing disabled or modified job',async t=>{
 const pg=await setup(t),p=planInboxRetention('reports');
 await pg.exec(p.install_sql);await pg.exec(p.install_sql);
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM cron.job')).rows[0].n,1);
 for(const change of ["active=false","schedule='* * * * *'","command='SELECT 1'","database='different'"]){
  await pg.exec(`UPDATE cron.job SET ${change}`);await assert.rejects(pg.exec(p.install_sql),/differs/);await pg.exec('ROLLBACK');
  await pg.query('UPDATE cron.job SET active=true,schedule=$1,command=$2,database=current_database()',[p.schedule,p.cleanup_sql]);
 }
});
test('cleanup removes only expired rows for its Bot and only its old run logs, independent of Bot activation',async t=>{
 const pg=await setup(t),p=planInboxRetention('reports'),q=planInboxRetention('other');
 await pg.exec(p.install_sql);await pg.exec(q.install_sql);
 const now=Date.now();await pg.query('INSERT INTO public.telegram_inbox_events VALUES($1,$2),($3,$4),($5,$6),($7,$8)',['reports',now-1000,'reports',now+86400000,'other',now-1000,'default',now-1000]);
 await pg.exec("INSERT INTO cron.job_run_details SELECT jobid,'succeeded',now()-interval '8 days',now()-interval '8 days' FROM cron.job; INSERT INTO cron.job_run_details SELECT jobid,'succeeded',now(),now() FROM cron.job;");
 await pg.exec(p.cleanup_sql);await pg.exec(p.verify_sql);
 const rows=(await pg.query('SELECT bot_alias FROM public.telegram_inbox_events ORDER BY bot_alias')).rows.map(x=>x.bot_alias);assert.deepEqual(rows,['default','other','reports']);
 const logs=(await pg.query('SELECT j.jobname,count(*)::int AS n FROM cron.job j JOIN cron.job_run_details r USING(jobid) GROUP BY j.jobname ORDER BY j.jobname')).rows;assert.deepEqual(logs,[{jobname:q.job_name,n:2},{jobname:p.job_name,n:1}]);
});
test('plan-retention CLI runs without database credentials and never applies the plan',()=>{
 const run=input=>spawnSync(process.execPath,['--import','./tests/register-typescript.mjs','scripts/inbox-cli.ts','plan-retention'],{cwd:new URL('../',import.meta.url),input:JSON.stringify(input),encoding:'utf8',env:{PATH:process.env.PATH},timeout:10000});
 const result=run({botAlias:'reports'});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).plan_only,true);
 assert.equal(run({botAlias:'reports',apply:true}).status,1);assert.equal(run({botAlias:'reports',chatIds:['-123']}).status,1);
});
