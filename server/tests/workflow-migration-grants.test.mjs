import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';
const sql=name=>readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8');
test('pending callback and media migrations remove default API grants, including bypass-RLS roles',async t=>{
 const pg=new PGlite();t.after(()=>pg.close());
 await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon, authenticated, service_role; CREATE TABLE telegram_inbox_events(sequence BIGINT PRIMARY KEY)');
 for(const [file,table] of [['004_callback_answers.sql','telegram_callback_answers'],['005_media_deliveries.sql','telegram_media_deliveries']]){
  await pg.exec(sql(file));
  for(const role of ['anon','authenticated','service_role']){
   const r=await pg.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed",[role,table]);assert.equal(r.rows[0].allowed,false);
  }
  const r=await pg.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[table]);assert.equal(r.rows[0].relrowsecurity,true);
  const policies=await pg.query('SELECT count(*)::int AS n FROM pg_policies WHERE tablename=$1',[table]);assert.equal(policies.rows[0].n,0);
  await pg.exec(`GRANT SELECT ON ${table} TO service_role`);await pg.exec(sql(file));
  assert.equal((await pg.query("SELECT has_table_privilege('service_role',$1,'SELECT') AS allowed",[table])).rows[0].allowed,false);
 }
});
test('pending migrations also run without Supabase API roles',async t=>{
 const pg=new PGlite();t.after(()=>pg.close());await pg.exec('CREATE TABLE telegram_inbox_events(sequence BIGINT PRIMARY KEY)');
 await pg.exec(sql('004_callback_answers.sql'));await pg.exec(sql('005_media_deliveries.sql'));
});
