import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {sealCredential} from '../lib/telegram/vault/crypto.ts';
test('runtime grants restrict both tables to the fixed private owner without delete',async t=>{
 const pg=new PGlite();t.after(()=>pg.close());for(const f of ['003_credential_vault.sql','006_bot_directory.sql'])await pg.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 await pg.exec('CREATE ROLE telegram_runtime');await pg.exec(readFileSync(new URL('../migrations/006_bot_runtime.example.sql',import.meta.url),'utf8'));
 const keys=new Map([['k',randomBytes(32)]]);
 const seal=ownerId=>sealCredential({ownerId,alias:'reports',purpose:'bot_token'},{token:'SYNTHETIC_ONLY'},keys,'k',{revision:1,createdAt:Date.now()});
 for(const owner of ['telegram-cloud-owner','other-owner']){await pg.query("INSERT INTO telegram_credential_vault VALUES ($1,'reports','bot_token',1,$2::jsonb)",[owner,JSON.stringify(seal(owner))]);await pg.query("INSERT INTO telegram_bot_directory VALUES ($1,'reports','bot_token',12345,1,1,false)",[owner])}
 const personal=sealCredential({ownerId:'telegram-cloud-owner',alias:'personal',purpose:'mtproto_account'},{apiId:1,apiHash:'a'.repeat(32),session:'SYNTHETIC_ONLY'},keys,'k',{revision:1,createdAt:Date.now()});
 await pg.query("INSERT INTO telegram_credential_vault VALUES ('telegram-cloud-owner','personal','mtproto_account',1,$1::jsonb)",[JSON.stringify(personal)]);
 await pg.exec('SET ROLE telegram_runtime');
 for(const table of ['telegram_credential_vault','telegram_bot_directory']){assert.deepEqual((await pg.query('SELECT owner_id FROM '+table)).rows,[{owner_id:'telegram-cloud-owner'}]);await assert.rejects(pg.exec('DELETE FROM '+table));assert.equal((await pg.query('UPDATE '+table+' SET revision=revision WHERE owner_id=$1 RETURNING owner_id',['other-owner'])).rows.length,0)}
 await assert.rejects(pg.query("INSERT INTO telegram_credential_vault VALUES ('different-owner','reports','bot_token',1,$1::jsonb)",[JSON.stringify(seal('different-owner'))]));
 await pg.exec("UPDATE telegram_bot_directory SET active=true WHERE owner_id='telegram-cloud-owner'");assert.equal((await pg.query('SELECT active FROM telegram_bot_directory')).rows[0].active,true);
 await pg.exec('RESET ROLE');
});
