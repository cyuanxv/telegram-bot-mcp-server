import {z} from 'zod';import type {TransactionalSql,SqlExecutor} from '../delivery/postgres-store';import {validateContext,VaultError} from './crypto';
import {loginEnvelopeSchema,type LoginEnvelope,type LoginContext} from './account-login-state';
export const LOGIN_TTL_MS=10*60*1000;
export type LoginRecord=LoginContext&{attempts:number;claim:string|null;envelope:LoginEnvelope|null};
const uuid=z.string().uuid();
function context(ownerId:string,id:string){validateContext({ownerId,alias:'login',purpose:'mtproto_account'});uuid.parse(id)}
function record(row:Record<string,unknown>):LoginRecord{
 const value={ownerId:row.owner_id as string,id:row.id as string,alias:row.alias as string,revision:Number(row.revision),expiresAt:Number(row.expires_at),attempts:Number(row.attempts),claim:row.claim as string|null,envelope:row.envelope===null?null:loginEnvelopeSchema.parse(row.envelope)};
 context(value.ownerId,value.id);validateContext({ownerId:value.ownerId,alias:value.alias,purpose:'mtproto_account'});if(!Number.isSafeInteger(value.revision)||value.revision<1||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<1||!Number.isInteger(value.attempts)||value.attempts<0||value.attempts>5||(value.claim!==null&&!uuid.safeParse(value.claim).success))throw new VaultError('invalid_login_record');return value;
}
/** Internal persistence only. Claim never auto-expires/retries: unknown external outcomes require restart. */
export class AccountLoginStore{
 private db:TransactionalSql;constructor(db:TransactionalSql){this.db=db}
 private async tx<T>(fn:(sql:SqlExecutor)=>Promise<T>):Promise<T>{try{return await this.db.transaction(fn)}catch(e){if(e instanceof VaultError)throw e;throw new VaultError('login_store_unavailable')}}
 async get(ownerId:string,id:string){context(ownerId,id);return this.tx(async sql=>{const row=(await sql.query('SELECT * FROM telegram_account_login WHERE owner_id=$1 AND id=$2',[ownerId,id])).rows[0];return row?record(row):undefined})}
 async create(c:LoginContext,envelope:LoginEnvelope,now=Date.now()){
  c={...c};context(c.ownerId,c.id);validateContext({ownerId:c.ownerId,alias:c.alias,purpose:'mtproto_account'});envelope=loginEnvelopeSchema.parse(envelope);
  if(c.revision!==1||!Number.isSafeInteger(now)||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+LOGIN_TTL_MS)throw new VaultError('invalid_login_expiry');
  return this.tx(async sql=>{
   await sql.query('LOCK TABLE telegram_account_login IN SHARE ROW EXCLUSIVE MODE');
   const existing=(await sql.query('SELECT * FROM telegram_account_login WHERE owner_id=$1 AND id=$2',[c.ownerId,c.id])).rows[0];
   if(existing){const prior=record(existing);if(prior.alias!==c.alias||prior.expiresAt!==c.expiresAt||JSON.stringify(prior.envelope)!==JSON.stringify(envelope)||prior.revision!==1)throw new VaultError('login_conflict');return prior}
   await sql.query('DELETE FROM telegram_account_login WHERE owner_id=$1 AND expires_at<=$2',[c.ownerId,now]);
   const rows=(await sql.query('SELECT alias,(envelope IS NOT NULL) AS pending FROM telegram_account_login WHERE owner_id=$1',[c.ownerId])).rows;if(rows.length>=20||rows.some(row=>row.alias===c.alias&&row.pending===true))throw new VaultError('login_already_pending');
   return record((await sql.query('INSERT INTO telegram_account_login(owner_id,id,alias,revision,expires_at,envelope) VALUES($1,$2,$3,1,$4,$5::jsonb) RETURNING *',[c.ownerId,c.id,c.alias,c.expiresAt,JSON.stringify(envelope)])).rows[0]);
  });
 }
 async claim(ownerId:string,id:string,revision:number,claim:string,now=Date.now()){
  context(ownerId,id);uuid.parse(claim);if(!Number.isSafeInteger(now)||now<1)throw new VaultError('invalid_login_expiry');if(!Number.isSafeInteger(revision)||revision<1)throw new VaultError('login_conflict');
  return this.tx(async sql=>{const rows=(await sql.query('UPDATE telegram_account_login SET claim=$1,attempts=attempts+1 WHERE owner_id=$2 AND id=$3 AND revision=$4 AND claim IS NULL AND envelope IS NOT NULL AND attempts<5 AND expires_at>$5 RETURNING *',[claim,ownerId,id,revision,now])).rows;if(rows.length!==1)throw new VaultError('login_conflict');return record(rows[0])});
 }
 async settle(ownerId:string,id:string,revision:number,claim:string,envelope:LoginEnvelope|null,now=Date.now()){
  context(ownerId,id);uuid.parse(claim);if(!Number.isSafeInteger(now)||now<1)throw new VaultError('invalid_login_expiry');if(!Number.isSafeInteger(revision)||revision<1||revision>=Number.MAX_SAFE_INTEGER)throw new VaultError('login_conflict');if(envelope!==null)envelope=loginEnvelopeSchema.parse(envelope);
  return this.tx(async sql=>{const rows=(await sql.query('UPDATE telegram_account_login SET envelope=$1::jsonb,claim=NULL,revision=revision+1 WHERE owner_id=$2 AND id=$3 AND revision=$4 AND claim=$5 AND expires_at>$6 RETURNING *',[envelope===null?null:JSON.stringify(envelope),ownerId,id,revision,claim,now])).rows;if(rows.length!==1)throw new VaultError('login_conflict');return record(rows[0])});
 }
 async cancel(ownerId:string,id:string){context(ownerId,id);return this.tx(async sql=>{await sql.query('UPDATE telegram_account_login SET envelope=NULL,claim=NULL,revision=revision+1 WHERE owner_id=$1 AND id=$2 AND revision<9007199254740991 AND envelope IS NOT NULL',[ownerId,id])})}
 async purgeExpired(now=Date.now()){if(!Number.isSafeInteger(now)||now<1)throw new VaultError('invalid_login_expiry');return this.tx(async sql=>{await sql.query('DELETE FROM telegram_account_login WHERE expires_at<=$1',[now])})}
}
