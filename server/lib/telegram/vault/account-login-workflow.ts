import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';import {z} from 'zod';
import {AccountLoginStore,LOGIN_TTL_MS,type LoginRecord} from './account-login-store';
import {loginStateSchema,sealLoginState,openLoginState,type LoginState} from './account-login-state';
import {accountLoginStep,AccountLoginError} from './account-login-provider';
import {validateContext,type VaultKeyring} from './crypto';import type {AccountEnrollment} from './account-enrollment';
const id=z.string().uuid(),revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1);
export const loginPrepareSchema=z.object({id,alias:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),apiId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),apiHash:z.string().regex(/^[a-fA-F0-9]{32}$/),phone:z.string().regex(/^\+[1-9][0-9]{5,14}$/)}).strict();
export const loginAdvanceSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('request_code'),id,revision,confirm:z.literal(true)}).strict(),
 z.object({action:z.literal('submit_code'),id,revision,code:z.string().regex(/^[0-9]{3,12}$/)}).strict(),
 z.object({action:z.literal('submit_password'),id,revision,password:z.string().min(1).max(1024)}).strict(),
]);
export const loginFinishSchema=z.object({id,revision,expected_user_id:z.string().regex(/^[1-9][0-9]{0,15}$/),confirm:z.literal(true)}).strict();
type Dependencies={ownerId:string;keyId:string;keys:VaultKeyring;store:AccountLoginStore;enrollment:Pick<AccountEnrollment,'stage'>;guard:()=>void;provider?:typeof accountLoginStep;now?:()=>number};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest();
/** Owner fixed by trusted configuration. Returned objects contain metadata only. */
export class AccountLoginWorkflow{
 private d:Dependencies;constructor(deps:Dependencies){validateContext({ownerId:deps.ownerId,alias:'login',purpose:'mtproto_account'});this.d=deps}
 private now(){return(this.d.now??Date.now)()}
 private guard(signal?:AbortSignal){if(signal?.aborted)throw Error();this.d.guard()}
 private state(row:LoginRecord){if(!row.envelope)throw Error();return openLoginState(row,row.envelope,this.d.keys,this.now())}
 private summary(row:LoginRecord){
  const base={id:row.id,alias:row.alias,revision:row.revision,expires_at:row.expiresAt,attempts:row.attempts,activated:false,retry_automatically:false};
  if(row.expiresAt<=this.now())return {...base,phase:'expired'};
  if(!row.envelope)return {...base,phase:'closed'};
  if(row.claim)return {...base,phase:'result_unconfirmed'};
  const state=this.state(row);return {...base,phase:state.phase,...(state.phase==='authorized'?{user_id:state.userId}:{}),...(state.phase==='code_required'?{delivery:state.delivery}:{})};
 }
 async prepare(input:unknown){
  const v=loginPrepareSchema.parse(input),d=this.d;
  try{this.guard();const state=loginStateSchema.parse({phase:'prepared',apiId:v.apiId,apiHash:v.apiHash,phone:v.phone});
   const prior=await d.store.get(d.ownerId,v.id);this.guard();
   if(prior){if(prior.alias!==v.alias||prior.claim||!timingSafeEqual(digest(this.state(prior)),digest(state)))throw Error();return this.summary(prior)}
   const c={ownerId:d.ownerId,id:v.id,alias:v.alias,revision:1,expiresAt:this.now()+LOGIN_TTL_MS};const sealed=sealLoginState(c,state,d.keys,d.keyId);
   const result=await d.store.create(c,sealed,this.now());this.guard();return this.summary(result);
  }catch{throw Error('Login preparation unconfirmed; query the same challenge before retrying')}
 }
 async status(value:string){id.parse(value);try{this.guard();const row=await this.d.store.get(this.d.ownerId,value);this.guard();return row?this.summary(row):{id:value,phase:'not_found',activated:false,retry_automatically:false}}catch{throw Error('Login status unavailable')}}
 async cancel(value:string){id.parse(value);try{this.guard();await this.d.store.cancel(this.d.ownerId,value);this.guard();return await this.status(value)}catch{throw Error('Login cancellation unconfirmed; query before retrying')}}
 async advance(input:unknown,signal?:AbortSignal){
  const v=loginAdvanceSchema.parse(input),d=this.d;
  try{
   this.guard(signal);const row=await d.store.get(d.ownerId,v.id);this.guard(signal);if(!row||row.revision!==v.revision||row.claim)throw Error();
   const state=this.state(row);let request:unknown;
   if(v.action==='request_code'&&state.phase==='prepared')request={action:v.action,apiId:state.apiId,apiHash:state.apiHash,phone:state.phone};
   else if(v.action==='submit_code'&&state.phase==='code_required')request={action:v.action,apiId:state.apiId,apiHash:state.apiHash,phone:state.phone,session:state.session,phoneCodeHash:state.phoneCodeHash,code:v.code};
   else if(v.action==='submit_password'&&state.phase==='password_required')request={action:v.action,apiId:state.apiId,apiHash:state.apiHash,session:state.session,password:v.password};
   else throw Error();
   const claim=randomUUID();await d.store.claim(d.ownerId,v.id,v.revision,claim,this.now());this.guard(signal);
   let next:LoginState;let recoverableError:string|undefined;
   try{
    const result=await(d.provider??accountLoginStep)(request,{signal,guard:()=>this.guard(signal)});this.guard(signal);
    const base={apiId:state.apiId,apiHash:state.apiHash,session:result.session};
    if(result.phase==='code_required'){if(state.phase!=='prepared')throw Error();next=loginStateSchema.parse({...base,phase:result.phase,phone:state.phone,phoneCodeHash:result.phoneCodeHash,delivery:result.delivery})}
    else if(result.phase==='password_required'){if(state.phase!=='code_required')throw Error();next=loginStateSchema.parse({...base,phase:result.phase})}
    else next=loginStateSchema.parse({...base,phase:result.phase,userId:result.userId});
   }catch(error){
    this.guard(signal);
    if(error instanceof AccountLoginError&&((error.code==='invalid_code'&&state.phase==='code_required')||(error.code==='invalid_password'&&state.phase==='password_required'))){next=state;recoverableError=error.code}else throw error;
   }
   const sealed=sealLoginState({...row,revision:row.revision+1},next,d.keys,d.keyId);
   const result=await d.store.settle(d.ownerId,row.id,row.revision,claim,sealed,this.now());this.guard(signal);
   return {...this.summary(result),...(recoverableError?{error:recoverableError}:{})};
  }catch(error){if(error instanceof AccountLoginError)throw error;throw Error('Login step unconfirmed; query before retrying')}
 }
 async finish(input:unknown,signal?:AbortSignal){
  const v=loginFinishSchema.parse(input),d=this.d;
  try{
   this.guard(signal);const row=await d.store.get(d.ownerId,v.id);this.guard(signal);if(!row||row.revision!==v.revision||row.claim)throw Error();const state=this.state(row);
   if(state.phase!=='authorized'||state.userId!==v.expected_user_id)throw Error();
   const claim=randomUUID();await d.store.claim(d.ownerId,v.id,v.revision,claim,this.now());this.guard(signal);
   const current=await d.store.get(d.ownerId,v.id);this.guard(signal);if(current?.claim!==claim||!current.envelope||current.expiresAt<=this.now())throw Error();
   const result=await d.enrollment.stage({alias:row.alias,expected_user_id:state.userId,apiId:state.apiId,apiHash:state.apiHash,session:state.session,confirm:true},signal);this.guard(signal);
   if(result.status!=='account_staged'||result.alias!==row.alias||result.user_id!==state.userId||result.activated!==false||result.saved!==true)throw Error();
   await d.store.settle(d.ownerId,v.id,v.revision,claim,null,this.now());this.guard(signal);
   return {id:v.id,alias:row.alias,phase:'staged',user_id:state.userId,vault_revision:result.revision,activated:false,retry_automatically:false};
  }catch{throw Error('Login storage unconfirmed; query account staging before retrying')}
 }
}
