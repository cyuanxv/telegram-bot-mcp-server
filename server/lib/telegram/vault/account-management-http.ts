import {createHash,timingSafeEqual} from 'node:crypto';
import {Pool} from 'pg';import {z} from 'zod';
import {readBotApiJson} from '../bot-api';import {getAccounts} from '../config';
import {PgPoolDatabase} from '../delivery/pg-pool-adapter';import {postgresConnectionConfig} from '../delivery/postgres-config';
import {PostgresCredentialVault} from './postgres-vault';import {AccountDirectory} from './account-directory';
import {AccountManagement,accountActivateSchema,accountDeactivateSchema} from './account-management';
import {verifyAccountSession} from './account-verification';import {loadVaultKeyring} from './keyring';import {validateContext} from './crypto';
type Env=Record<string,string|undefined>;
type Resource={vault:Pick<PostgresCredentialVault,'loadSealed'>;directory:AccountDirectory;close:()=>Promise<void>};
type Options={env?:()=>Env;verify?:typeof verifyAccountSession;open?:(env:Env,guard:()=>void)=>Promise<Resource>};
const schema=z.discriminatedUnion('action',[
 accountActivateSchema.extend({action:z.literal('activate')}),accountDeactivateSchema.extend({action:z.literal('deactivate')}),
 accountDeactivateSchema.pick({alias:true}).extend({action:z.literal('status')}),
]);
const json=(status:number,data:unknown)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
const hash=(s:string)=>createHash('sha256').update(s).digest();
async function openProduction(env:Env,guard:()=>void):Promise<Resource>{guard();const pool=new Pool(postgresConnectionConfig(env));pool.on('error',()=>{});const db=new PgPoolDatabase(pool,{guard});return {vault:new PostgresCredentialVault(db),directory:new AccountDirectory(db),close:()=>pool.end()}}
export async function handleAccountManagement(request:Request,options:Options={}){
 const env=options.env??(()=>process.env),snapshot={...env()};
 if(snapshot.TELEGRAM_ACCOUNT_MANAGEMENT_ENABLED!=='true')return json(503,{status:'account_management_disabled'});
 if(request.method!=='POST')return json(405,{status:'method_not_allowed'});
 const auth=snapshot.TELEGRAM_ACCOUNT_ENROLLMENT_AUTH;
 if(!auth||auth.length<32||auth.length>256)return json(503,{status:'account_auth_unavailable'});
 const supplied=request.headers.get('authorization');if(!supplied||supplied.length>4096||!timingSafeEqual(hash(supplied),hash(`Bearer ${auth}`)))return json(401,{status:'unauthorized'});
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return json(415,{status:'json_required'});
 const signal=AbortSignal.any([request.signal,AbortSignal.timeout(30000)]);let value:z.infer<typeof schema>;
 try{value=schema.parse(await readBotApiJson(new Response(request.body),signal,16384))}catch{return json(400,{status:'invalid_request'})}
 const guard=()=>{const current=env();if(signal.aborted||Object.keys({...snapshot,...current}).filter(k=>k.startsWith('TELEGRAM_')).some(k=>snapshot[k]!==current[k]))throw Error()};
 let resource:Resource|undefined,ring:ReturnType<typeof loadVaultKeyring>|undefined;
 try{
  guard();const ownerId=snapshot.TELEGRAM_VAULT_OWNER_ID!;validateContext({ownerId,alias:value.alias,purpose:'mtproto_account'});
  if(Object.hasOwn(getAccounts(snapshot),value.alias))return json(409,{status:'account_alias_in_use'});
  if(value.action==='activate'){
   if(snapshot.TELEGRAM_VAULT_ACCOUNTS_ENABLED!=='true'||snapshot.TELEGRAM_MTPROTO_ENABLED!=='true')return json(503,{status:'account_runtime_disabled'});
   ring=loadVaultKeyring(snapshot);
  }
  resource=await(options.open??openProduction)(snapshot,guard);guard();
  if(value.action==='status'){
   const binding=await resource.directory.get(ownerId,value.alias);guard();
   const active=await resource.directory.loadActive(ownerId,value.alias);guard();
   // Exact binding match protects against concurrent changes between the reads.
   const effective=!!binding&&!!active&&JSON.stringify(binding)===JSON.stringify(active.entry);
   return json(200,{status:'account_binding_status',alias:value.alias,binding:binding??null,credential_binding_current:effective,runtime_enabled:snapshot.TELEGRAM_VAULT_ACCOUNTS_ENABLED==='true'&&snapshot.TELEGRAM_MTPROTO_ENABLED==='true',runtime_verified:false});
  }
  const manager=new AccountManagement({ownerId,keys:ring?.keys??new Map(),vault:resource.vault,directory:resource.directory,guard,verify:options.verify});
  const {action,...args}=value;const result=action==='activate'?await manager.activate(args,signal):await manager.deactivate(args);
  guard();return json(200,result);
 }catch{return json(503,{status:value.action==='status'?'account_operation_unavailable':'account_management_unconfirmed',retry_automatically:false})}
 finally{ring?.dispose();try{await resource?.close()}catch{}}
}
