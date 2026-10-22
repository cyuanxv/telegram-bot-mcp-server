import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
const sql = name => readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8');
async function setup(t){
 const pg=new PGlite();t.after(()=>pg.close());
 await pg.exec('CREATE ROLE telegram_runtime; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
 for(const name of ['003_credential_vault.sql','006_bot_directory.sql','006_bot_runtime.example.sql','012_account_directory.sql','013_account_peers.sql','014_account_login.sql'])await pg.exec(sql(name));
 return pg;
}
async function seed(pg,owner,purpose='mtproto_account'){
 await pg.query('INSERT INTO telegram_credential_vault VALUES ($1,$2,$3,1,$4)',[owner,'personal',purpose,JSON.stringify({ownerId:owner,alias:'personal',purpose,revision:1})]);
}
test('account policies preserve Bot access while isolating owners and temporary deletion',async t=>{
 const pg=await setup(t);await pg.exec(sql('014_account_runtime.example.sql'));
 for(const owner of ['telegram-cloud-owner','other']){
  await seed(pg,owner);await seed(pg,owner,'bot_token');
  await pg.query("INSERT INTO telegram_account_directory(owner_id,alias,user_id,vault_revision,revision,scope) VALUES($1,'personal','123',1,1,'{}')",[owner]);
  await pg.query("INSERT INTO telegram_account_peers(owner_id,alias,user_id,vault_revision,peer_id,envelope) VALUES($1,'personal','123',1,'123','{}')",[owner]);
  await pg.query("INSERT INTO telegram_account_login(owner_id,id,alias,revision,expires_at) VALUES($1,$2,'personal',1,1)",[owner,randomUUID()]);
 }
 await pg.exec('SET ROLE telegram_runtime');
 assert.equal((await pg.query('SELECT * FROM telegram_credential_vault')).rows.length,2);
 for(const table of ['telegram_account_directory','telegram_account_peers','telegram_account_login']){
  assert.equal((await pg.query('SELECT * FROM '+table)).rows.length,1);
  await assert.rejects(pg.query('UPDATE '+table+" SET owner_id='other'"),/row-level security/);
 }
 await assert.rejects(seed(pg,'forbidden'),/row-level security/);
 await pg.exec("UPDATE telegram_account_directory SET active=true; UPDATE telegram_account_peers SET envelope='{\"test\":true}'; UPDATE telegram_account_login SET attempts=1;");
 for(const table of ['telegram_credential_vault','telegram_account_directory','telegram_account_peers'])await assert.rejects(pg.exec('DELETE FROM '+table),/permission denied/);
 await pg.exec('DELETE FROM telegram_account_login');
 await assert.rejects(pg.exec('TRUNCATE telegram_account_login'),/permission denied/);
 await pg.exec('RESET ROLE');
 assert.equal((await pg.query('SELECT owner_id FROM telegram_account_login')).rows[0].owner_id,'other');
 for(const role of ['anon','authenticated','service_role']){
  await pg.exec('SET ROLE '+role);
  for(const table of ['telegram_credential_vault','telegram_account_directory','telegram_account_peers','telegram_account_login'])await assert.rejects(pg.exec('SELECT * FROM '+table),/permission denied/);
  await pg.exec('RESET ROLE');
 }
});
test('account grant proposal refuses bypass privileges and inherited roles',async t=>{
 const pg=await setup(t);
 await pg.exec('ALTER ROLE telegram_runtime BYPASSRLS');
 await assert.rejects(pg.exec(sql('014_account_runtime.example.sql')),/unprivileged role/);await pg.exec('ROLLBACK');
 await pg.exec('ALTER ROLE telegram_runtime NOBYPASSRLS; CREATE ROLE extra; GRANT extra TO telegram_runtime');
 await assert.rejects(pg.exec(sql('014_account_runtime.example.sql')),/unprivileged role/);await pg.exec('ROLLBACK');
 assert.equal((await pg.query("SELECT count(*)::int AS n FROM pg_policies WHERE policyname='telegram_vault_account_owner'")).rows[0].n,0);
});
test('cleanup removes only expired private-owner challenges and restores caller role',async t=>{
 const pg=await setup(t);await pg.exec(sql('014_account_runtime.example.sql'));
 const expired=randomUUID(),live=randomUUID(),foreign=randomUUID();
 for(const [owner,id,expiry] of [['telegram-cloud-owner',expired,1],['telegram-cloud-owner',live,Date.now()+600000],['other',foreign,1]]){
  await pg.query("INSERT INTO telegram_account_login(owner_id,id,alias,revision,expires_at) VALUES($1,$2,'personal',1,$3)",[owner,id,expiry]);
 }
 await pg.exec(sql('014_account_login_cleanup.example.sql'));
 assert.deepEqual((await pg.query('SELECT id FROM telegram_account_login ORDER BY id')).rows.map(r=>r.id),[live,foreign].sort());
 assert.notEqual((await pg.query('SELECT current_user')).rows[0].current_user,'telegram_runtime');
 await pg.exec(sql('014_account_login_cleanup.example.sql'));
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM telegram_account_login')).rows[0].n,2);
});
