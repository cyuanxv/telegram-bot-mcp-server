import {createHash,timingSafeEqual} from 'node:crypto';
import {Pool} from 'pg';
import {z} from 'zod';
import {readBotApiJson} from '../bot-api';
import {getAccounts} from '../config';
import {PgPoolDatabase} from '../delivery/pg-pool-adapter';
import {postgresConnectionConfig} from '../delivery/postgres-config';
import {PostgresCredentialVault} from './postgres-vault';
import {AccountEnrollment,accountEnrollmentSchema} from './account-enrollment';
import {verifyAccountSession} from './account-verification';
import {loadVaultKeyring} from './keyring';
import {validateContext} from './crypto';
type Env=Record<string,string|undefined>;
type Resource={vault:Pick<PostgresCredentialVault,'loadSealed'|'save'>;close:()=>Promise<void>};
type Options={env?:()=>Env;verify?:typeof verifyAccountSession;open?:(env:Env,guard:()=>void)=>Promise<Resource>};
const requestSchema=z.discriminatedUnion('action',[
 accountEnrollmentSchema.extend({action:z.literal('stage')}),
 accountEnrollmentSchema.pick({apiId:true,apiHash:true,session:true}).extend({action:z.literal('inspect')}),
 accountEnrollmentSchema.pick({alias:true}).extend({action:z.literal('status')}),
]);
const json=(status:number,data:unknown)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
const same=(a:string,b:string)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
async function openProduction(env:Env,guard:()=>void):Promise<Resource>{
 guard();const pool=new Pool(postgresConnectionConfig(env));pool.on('error',()=>{});
 return {vault:new PostgresCredentialVault(new PgPoolDatabase(pool,{guard})),close:()=>pool.end()};
}
/** Dedicated private server channel. Never place account secrets in MCP arguments. */
export async function handleAccountEnrollment(request:Request,options:Options={}){
 const env=options.env??(()=>process.env),snapshot={...env()};
 if(snapshot.TELEGRAM_ACCOUNT_ENROLLMENT_ENABLED!=='true')return json(503,{status:'account_enrollment_disabled'});
 if(request.method!=='POST')return json(405,{status:'method_not_allowed'});
 const auth=snapshot.TELEGRAM_ACCOUNT_ENROLLMENT_AUTH;
 if(!auth||auth.length<32||auth.length>256)return json(503,{status:'account_auth_unavailable'});
 const supplied=request.headers.get('authorization');
 if(!supplied||supplied.length>4096||!same(supplied,`Bearer ${auth}`))return json(401,{status:'unauthorized'});
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return json(415,{status:'json_required'});
 const signal=AbortSignal.any([request.signal,AbortSignal.timeout(30000)]);
 let value:z.infer<typeof requestSchema>;
 try{value=requestSchema.parse(await readBotApiJson(new Response(request.body),signal,16384))}catch{return json(400,{status:'invalid_request'})}
 const guard=()=>{const current=env();if(signal.aborted||Object.keys({...snapshot,...current}).filter(k=>k.startsWith('TELEGRAM_')).some(k=>snapshot[k]!==current[k]))throw Error()};
 let resource:Resource|undefined,ring:ReturnType<typeof loadVaultKeyring>|undefined;
 try{
  guard();const ownerId=snapshot.TELEGRAM_VAULT_OWNER_ID!;validateContext({ownerId,alias:'account',purpose:'mtproto_account'});
  if(value.action==='inspect'){
   const {action,...secret}=value;
   const verified=await(options.verify??verifyAccountSession)(secret,{signal,guard});guard();
   if(!/^[1-9][0-9]{0,15}$/.test(verified.user_id)||!Number.isSafeInteger(Number(verified.user_id))||verified.provider_authorization_verified!==true||verified.saved!==false||verified.activated!==false)throw Error();
   return json(200,{status:'account_identity_verified',user_id:verified.user_id,saved:false,activated:false});
  }
  if(value.action==='stage'&&Object.hasOwn(getAccounts(snapshot),value.alias))return json(409,{status:'account_alias_in_use'});
  if(value.action==='stage')ring=loadVaultKeyring(snapshot);
  resource=await(options.open??openProduction)(snapshot,guard);guard();
  const enrolled=new AccountEnrollment({ownerId,keyId:ring?.activeKeyId??'unused',keys:ring?.keys??new Map(),vault:resource.vault,guard,verify:options.verify});
  const {action,...args}=value;
  const result=action==='status'?await enrolled.status(value.alias):await enrolled.stage(args,signal);
  guard();return json(200,result);
 }catch{return json(503,{status:value.action==='stage'?'account_stage_unconfirmed':'account_operation_unavailable',retry_automatically:false})}
 finally{ring?.dispose();try{await resource?.close()}catch{}}
}
