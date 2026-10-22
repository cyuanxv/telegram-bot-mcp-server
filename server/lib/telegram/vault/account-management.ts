import {z} from 'zod';
import {accountScopeSchema,type AccountDirectory} from './account-directory';
import {openCredential,validateContext,type VaultKeyring} from './crypto';
import type {PostgresCredentialVault} from './postgres-vault';
import {verifyAccountSession} from './account-verification';
const alias=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1);
export const accountActivateSchema=z.object({alias,user_id:z.string().regex(/^[1-9][0-9]{0,15}$/).refine(v=>Number.isSafeInteger(Number(v))),vault_revision:revision.refine(v=>v>0),expected_revision:revision,scope:accountScopeSchema,confirm:z.literal(true)}).strict();
export const accountDeactivateSchema=z.object({alias,expected_revision:revision.refine(v=>v>0),confirm:z.literal(true)}).strict();
type Dependencies={ownerId:string;keys:VaultKeyring;vault:Pick<PostgresCredentialVault,'loadSealed'>;directory:AccountDirectory;guard:()=>void;verify?:typeof verifyAccountSession};
/** Internal service only; activation is distinct from encrypted credential staging. */
export class AccountManagement{
 private d:Dependencies;
 constructor(deps:Dependencies){validateContext({ownerId:deps.ownerId,alias:'accounts',purpose:'mtproto_account'});this.d=deps}
 async activate(input:unknown,signal?:AbortSignal){
  const v=accountActivateSchema.parse(input),d=this.d;let attempted=false;
  const guard=()=>{if(signal?.aborted)throw Error();d.guard()};
  try{
   guard();const context={ownerId:d.ownerId,alias:v.alias,purpose:'mtproto_account' as const};const envelope=await d.vault.loadSealed(context);guard();
   if(!envelope||envelope.revision!==v.vault_revision)throw Error();
   const secret=openCredential(context,envelope,d.keys,Date.now());
   if(!('session' in secret)||secret.userId!==v.user_id)throw Error();
   const verified=await(d.verify??verifyAccountSession)({apiId:secret.apiId,apiHash:secret.apiHash,session:secret.session},{signal,guard});guard();
   if(verified.user_id!==v.user_id||verified.provider_authorization_verified!==true||verified.saved!==false||verified.activated!==false)throw Error();
   attempted=true;const result=await d.directory.activate(d.ownerId,{alias:v.alias,userId:v.user_id,vaultRevision:v.vault_revision,scope:v.scope},v.expected_revision);guard();
   const latest=await d.directory.loadActive(d.ownerId,v.alias);guard();
   if(!latest||JSON.stringify(latest.entry)!==JSON.stringify(result)||latest.envelope.ciphertext!==envelope.ciphertext||latest.envelope.tag!==envelope.tag||latest.envelope.nonce!==envelope.nonce)throw Error();
   return {status:'account_binding_active',...result,runtime_verified:false};
  }catch{throw Error(attempted?'Account activation unconfirmed; query before retrying':'Account activation rejected')}
 }
 async deactivate(input:unknown){
  const v=accountDeactivateSchema.parse(input),d=this.d;let attempted=false;
  try{d.guard();attempted=true;const result=await d.directory.deactivate(d.ownerId,v.alias,v.expected_revision);d.guard();const latest=await d.directory.get(d.ownerId,v.alias);d.guard();if(!latest||JSON.stringify(result)!==JSON.stringify(latest))throw Error();return {status:'account_binding_inactive',...result,runtime_verified:false}}
  catch{throw Error(attempted?'Account deactivation unconfirmed; query before retrying':'Account deactivation rejected')}
 }
}
