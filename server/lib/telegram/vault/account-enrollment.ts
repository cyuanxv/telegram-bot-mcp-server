import {createHash,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {sealCredential,openCredential,validateContext,type AccountSecret,type VaultKeyring} from './crypto';
import type {PostgresCredentialVault} from './postgres-vault';
import {verifyAccountSession} from './account-verification';
export const accountEnrollmentSchema=z.object({alias:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),expected_user_id:z.string().regex(/^[1-9][0-9]{0,15}$/).refine(v=>Number.isSafeInteger(Number(v))),apiId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),apiHash:z.string().regex(/^[a-fA-F0-9]{32}$/),session:z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/),confirm:z.literal(true)}).strict();
type Dependencies={ownerId:string;keyId:string;keys:VaultKeyring;vault:Pick<PostgresCredentialVault,'loadSealed'|'save'>;guard:()=>void;verify?:typeof verifyAccountSession;now?:()=>number};
const digest=(s:AccountSecret)=>createHash('sha256').update(JSON.stringify([s.apiId,s.apiHash,s.session,s.userId])).digest();
/** Internal only. New accounts remain staged; no runtime activation or rotation. */
export class AccountEnrollment{
 private deps:Dependencies;
 constructor(deps:Dependencies){validateContext({ownerId:deps.ownerId,alias:'account',purpose:'mtproto_account'});this.deps=deps}
 async stage(value:unknown,signal?:AbortSignal){
  let v:z.infer<typeof accountEnrollmentSchema>;try{v=accountEnrollmentSchema.parse(value)}catch{throw Error('Account enrollment input invalid')}
  const d=this.deps,guard=()=>{if(signal?.aborted)throw Error();d.guard()};
  const context={ownerId:d.ownerId,alias:v.alias,purpose:'mtproto_account' as const};
  const secret:AccountSecret={apiId:v.apiId,apiHash:v.apiHash,session:v.session,userId:v.expected_user_id};
  let attempted=false;
  try{
   guard();const existing=await d.vault.loadSealed(context);guard();
   if(existing){
    const prior=openCredential(context,existing,d.keys,(d.now??Date.now)());
    // Unbound legacy account envelopes cannot be silently adopted or replaced.
    if(!('session' in prior)||!prior.userId||!timingSafeEqual(digest(prior),digest(secret)))throw Error();
   }
   const verified=await(d.verify??verifyAccountSession)({apiId:v.apiId,apiHash:v.apiHash,session:v.session},{signal,guard});guard();
   if(verified.user_id!==v.expected_user_id||verified.provider_authorization_verified!==true||verified.saved!==false||verified.activated!==false)throw Error();
   if(!existing){
    const sealed=sealCredential(context,secret,d.keys,d.keyId,{revision:1,createdAt:(d.now??Date.now)()});
    guard();attempted=true;await d.vault.save(sealed,0);guard();
    const stored=await d.vault.loadSealed(context);guard();
    if(!stored||stored.revision!==sealed.revision||stored.ciphertext!==sealed.ciphertext||stored.nonce!==sealed.nonce||stored.tag!==sealed.tag)throw Error();
    const confirmed=openCredential(context,stored,d.keys,(d.now??Date.now)());
    if(!('session' in confirmed)||!timingSafeEqual(digest(confirmed),digest(secret)))throw Error();
   }
   if(existing){
    const latest=await d.vault.loadSealed(context);guard();
    if(!latest||latest.revision!==existing.revision||latest.ciphertext!==existing.ciphertext||latest.tag!==existing.tag||latest.nonce!==existing.nonce)throw Error();
   }
   return {status:'account_staged',alias:v.alias,user_id:v.expected_user_id,revision:existing?.revision??1,reused:!!existing,saved:true,activated:false,provider_authorization_verified:true};
  }catch{throw Error(attempted?'Account storage unconfirmed; query before retrying':'Account enrollment rejected')}
 }
 async status(alias:string){
  try{
   const context={ownerId:this.deps.ownerId,alias,purpose:'mtproto_account' as const};validateContext(context);this.deps.guard();
   const record=await this.deps.vault.loadSealed(context);this.deps.guard();
   return {alias,staged:!!record,revision:record?.revision??null,activated:false,provider_authorization_verified:false};
  }catch{throw Error('Account status unavailable')}
 }
}
