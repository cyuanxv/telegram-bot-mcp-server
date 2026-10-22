import {createHash,timingSafeEqual} from 'node:crypto';import {Pool} from 'pg';import {z} from 'zod';
import {readBotApiJson} from '../bot-api';import {getAccounts} from '../config';import {PgPoolDatabase} from '../delivery/pg-pool-adapter';import {postgresConnectionConfig} from '../delivery/postgres-config';
import {AccountLoginWorkflow,loginPrepareSchema,loginAdvanceSchema,loginFinishSchema} from './account-login-workflow';import {AccountLoginStore} from './account-login-store';
import {AccountEnrollment} from './account-enrollment';import {PostgresCredentialVault} from './postgres-vault';import {loadVaultKeyring} from './keyring';import {AccountLoginError,accountLoginStep} from './account-login-provider';import {verifyAccountSession} from './account-verification';import {validateContext} from './crypto';
type Env=Record<string,string|undefined>;
type Resource={store:AccountLoginStore;vault:PostgresCredentialVault;close:()=>Promise<void>};
type Options={env?:()=>Env;provider?:typeof accountLoginStep;verify?:typeof verifyAccountSession;open?:(env:Env,guard:()=>void)=>Promise<Resource>};
const schema=z.discriminatedUnion('action',[
 loginPrepareSchema.extend({action:z.literal('prepare')}),...loginAdvanceSchema.options,loginFinishSchema.extend({action:z.literal('finish')}),
 z.object({action:z.literal('status'),id:z.string().uuid()}).strict(),z.object({action:z.literal('cancel'),id:z.string().uuid(),confirm:z.literal(true)}).strict(),
]);
const json=(status:number,data:unknown)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
const hash=(v:string)=>createHash('sha256').update(v).digest();
async function openProduction(env:Env,guard:()=>void):Promise<Resource>{guard();const pool=new Pool(postgresConnectionConfig(env));pool.on('error',()=>{});const db=new PgPoolDatabase(pool,{guard});return {store:new AccountLoginStore(db),vault:new PostgresCredentialVault(db),close:()=>pool.end()}}
export async function handleAccountLogin(request:Request,options:Options={}){
 const env=options.env??(()=>process.env),snapshot={...env()};
 if(snapshot.TELEGRAM_ACCOUNT_LOGIN_ENABLED!=='true')return json(503,{status:'account_login_disabled'});
 if(request.method!=='POST')return json(405,{status:'method_not_allowed'});
 const auth=snapshot.TELEGRAM_ACCOUNT_ENROLLMENT_AUTH;if(!auth||auth.length<32||auth.length>256)return json(503,{status:'account_auth_unavailable'});
 const supplied=request.headers.get('authorization');if(!supplied||supplied.length>4096||!timingSafeEqual(hash(supplied),hash(`Bearer ${auth}`)))return json(401,{status:'unauthorized'});
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return json(415,{status:'json_required'});
 const signal=AbortSignal.any([request.signal,AbortSignal.timeout(40000)]);let value:z.infer<typeof schema>;
 try{value=schema.parse(await readBotApiJson(new Response(request.body),signal,16384))}catch{return json(400,{status:'invalid_request'})}
 const guard=()=>{const now=env();if(signal.aborted||Object.keys({...snapshot,...now}).filter(k=>k.startsWith('TELEGRAM_')).some(k=>snapshot[k]!==now[k]))throw Error()};
 let resource:Resource|undefined,ring:ReturnType<typeof loadVaultKeyring>|undefined;
 try{
  guard();const ownerId=snapshot.TELEGRAM_VAULT_OWNER_ID!;validateContext({ownerId,alias:'login',purpose:'mtproto_account'});
  if(value.action!=='cancel')ring=loadVaultKeyring(snapshot);
  resource=await(options.open??openProduction)(snapshot,guard);guard();
  if(value.action==='prepare'&&(Object.hasOwn(getAccounts(snapshot),value.alias)||await resource.vault.loadSealed({ownerId,alias:value.alias,purpose:'mtproto_account'})))return json(409,{status:'account_alias_in_use'});
  guard();const enrollment=new AccountEnrollment({ownerId,keyId:ring?.activeKeyId??'unused',keys:ring?.keys??new Map(),vault:resource.vault,guard,verify:options.verify});
  const workflow=new AccountLoginWorkflow({ownerId,keyId:ring?.activeKeyId??'unused',keys:ring?.keys??new Map(),store:resource.store,enrollment,guard,provider:options.provider});
  const {action,...args}=value;let result;
  if(action==='prepare')result=await workflow.prepare(args);
  else if(action==='status')result=await workflow.status(value.id);
  else if(action==='cancel')result=await workflow.cancel(value.id);
  else if(action==='finish')result=await workflow.finish(args,signal);
  else result=await workflow.advance(value,signal);
  guard();return json(200,result);
 }catch(error){
  const code=error instanceof AccountLoginError?error.code:'login_result_unconfirmed';
  const safe=['invalid_code','code_expired','invalid_password','invalid_phone','phone_unavailable','invalid_api_configuration','session_expired','rate_limited','signup_not_supported','delivery_not_supported'].includes(code)?code:'login_result_unconfirmed';
  return json(503,{status:safe,retry_automatically:false,...(error instanceof AccountLoginError&&safe==='rate_limited'?{retry_after:error.retryAfter}:{})});
 }finally{ring?.dispose();try{await resource?.close()}catch{}}
}
