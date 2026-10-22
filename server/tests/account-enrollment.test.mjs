import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';
import {AccountEnrollment} from '../lib/telegram/vault/account-enrollment.ts';import {PostgresCredentialVault} from '../lib/telegram/vault/postgres-vault.ts';import {openCredential} from '../lib/telegram/vault/crypto.ts';
async function setup(t){const pg=new PGlite();t.after(()=>pg.close());await pg.exec(readFileSync(new URL('../migrations/003_credential_vault.sql',import.meta.url),'utf8'));const vault=new PostgresCredentialVault({transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))});const keys=new Map([['test',randomBytes(32)]]);let verifications=0;const deps={ownerId:'owner',keyId:'test',keys,vault,guard:()=>{},verify:async()=>{verifications++;return {user_id:'123',provider_authorization_verified:true,saved:false,activated:false}}};const input={alias:'personal',expected_user_id:'123',apiId:1,apiHash:randomBytes(16).toString('hex'),session:'synthetic-session',confirm:true};return {pg,vault,keys,deps,input,enroll:new AccountEnrollment(deps),verifications:()=>verifications}}
test('verified identity is sealed with session; staged status never activates or returns secrets',async t=>{
 const s=await setup(t),r=await s.enroll.stage(s.input);assert.equal(r.saved,true);assert.equal(r.activated,false);assert.equal(r.user_id,'123');
 const row=(await s.pg.query('SELECT envelope FROM telegram_credential_vault')).rows[0].envelope;
 for(const value of [s.input.apiHash,s.input.session]){assert.ok(!JSON.stringify(row).includes(value));assert.ok(!JSON.stringify(r).includes(value))}
 assert.equal(openCredential({ownerId:'owner',alias:'personal',purpose:'mtproto_account'},row,s.keys,Date.now()).userId,'123');
 assert.equal((await s.enroll.stage(s.input)).reused,true);assert.equal((await s.enroll.status('personal')).provider_authorization_verified,false);
 assert.equal((await new AccountEnrollment({...s.deps,ownerId:'other'}).status('personal')).staged,false);
});
test('wrong identity, missing confirmation and alias replacement do not write or leak provider details',async t=>{
 const s=await setup(t);await assert.rejects(s.enroll.stage({...s.input,confirm:false}));assert.equal(s.verifications(),0);
 await assert.rejects(s.enroll.stage({...s.input,expected_user_id:'999'}),/rejected/);assert.equal((await s.pg.query('SELECT count(*)::int AS n FROM telegram_credential_vault')).rows[0].n,0);
 await s.enroll.stage(s.input);const n=s.verifications();await assert.rejects(s.enroll.stage({...s.input,session:'different-session'}),/rejected/);assert.equal(s.verifications(),n);
 const broken=new AccountEnrollment({...s.deps,verify:async()=>{throw Error(s.input.apiHash)}});await assert.rejects(broken.stage(s.input),e=>!e.message.includes(s.input.apiHash));
});
test('lost commit is reported unknown then exact same input reconciles without overwriting',async t=>{
 const s=await setup(t),failing=new AccountEnrollment({...s.deps,vault:{loadSealed:c=>s.vault.loadSealed(c),save:async(...args)=>{await s.vault.save(...args);throw Error('lost')}}});
 await assert.rejects(failing.stage(s.input),/storage unconfirmed/);assert.equal((await s.enroll.status('personal')).staged,true);
 const result=await s.enroll.stage(s.input);assert.equal(result.reused,true);assert.equal(result.revision,1);assert.equal((await s.pg.query('SELECT count(*)::int AS n FROM telegram_credential_vault')).rows[0].n,1);
});
test('revocation during provider verification prevents saving',async t=>{
 const s=await setup(t);let revoked=false;const enrolled=new AccountEnrollment({...s.deps,guard:()=>{if(revoked)throw Error()},verify:async(...args)=>{const r=await s.deps.verify(...args);revoked=true;return r}});
 await assert.rejects(enrolled.stage(s.input),/rejected/);assert.equal((await s.pg.query('SELECT count(*)::int AS n FROM telegram_credential_vault')).rows[0].n,0);
});
