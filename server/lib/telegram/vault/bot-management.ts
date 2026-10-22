import {createHash,timingSafeEqual} from "node:crypto";
import {loadVaultKeyring} from './keyring';
import {Pool} from "pg";
import {getBots} from "../config";
import {readBotApiJson} from "../bot-api";
import {postgresConnectionConfig} from "../delivery/postgres-config";
import {PgPoolDatabase} from "../delivery/pg-pool-adapter";
import {PostgresCredentialVault} from "./postgres-vault";
import {BotDirectory,type BotDirectoryEntry} from "./bot-directory";
import {openCredential,validateContext,VaultError,type SealedCredential} from "./crypto";
import {BotScopeStore} from "./bot-scope-store";
import {validateBotScope} from "./bot-scope";
type Env=Record<string,string|undefined>;
type Resource={vault:Pick<PostgresCredentialVault,"loadSealed"|"listBots">;directory:Pick<BotDirectory,"get"|"set">;scope?:Pick<BotScopeStore,"get"|"save">;close():Promise<void>};
type Dependencies={env?:()=>Env;fetcher?:typeof fetch;open?:(env:Env,guard:()=>void)=>Promise<Resource>};
const json=(status:number,data:unknown)=>Response.json(data,{status,headers:{"cache-control":"no-store"}});
async function openStore(env:Env,guard:()=>void):Promise<Resource>{guard();const pool=new Pool(postgresConnectionConfig(env)),db=new PgPoolDatabase(pool,{guard});return {vault:new PostgresCredentialVault(db),directory:new BotDirectory(db),scope:new BotScopeStore(db),close:()=>pool.end()}}
function botToken(envelope:SealedCredential,env:Env){
 const keyring=loadVaultKeyring(env);
 try{const value=openCredential({ownerId:env.TELEGRAM_VAULT_OWNER_ID!,alias:envelope.alias,purpose:'bot_token'},envelope,keyring.keys,Date.now());if(!('token' in value)||!/^[1-9][0-9]{0,15}:[A-Za-z0-9_-]{20,128}$/.test(value.token))throw new VaultError('credential_unavailable');return value.token}finally{keyring.dispose()}
}
function state(alias:string,id:number,envelope:SealedCredential,directory:BotDirectoryEntry|undefined,runtime:boolean){
 const bound=directory?.vaultRevision===envelope.revision;
 return {status:'bot_state',alias,bot_id:id,credential_revision:envelope.revision,revision:directory?.revision??0,active:directory?.active===true&&bound&&runtime,
  state:!directory?'staged':!directory.active?'inactive':!bound?'needs_reactivation':runtime?'active':'runtime_disabled',runtime_enabled:runtime};
}
/** Private control plane. No Token accepted in the body and no Telegram writes. */
export async function manageBot(request:Request,dependencies:Dependencies={}){
 const env=dependencies.env??(()=>process.env),snapshot={...env()};
 if(snapshot.TELEGRAM_BOT_MANAGEMENT_ENABLED!=='true')return json(503,{status:'management_disabled'});
 if(request.method!=='POST')return json(405,{status:'method_not_allowed'});
 const auth=snapshot.TELEGRAM_BOT_ENROLLMENT_AUTH,supplied=request.headers.get('authorization');
 if(!auth||auth.length<32||auth.length>256)return json(503,{status:'management_auth_not_configured'});
 if(!supplied||supplied.length>4096||!timingSafeEqual(createHash('sha256').update(supplied).digest(),createHash('sha256').update(`Bearer ${auth}`).digest()))return json(401,{status:'unauthorized'});
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return json(415,{status:'json_required'});
 const persistent=snapshot.TELEGRAM_VAULT_SCOPE_STORE_ENABLED==='true';
 const signal=AbortSignal.any([request.signal,AbortSignal.timeout(15000)]);
 let input:Record<string,unknown>;
 try{
  input=await readBotApiJson(new Response(request.body),signal,16384) as Record<string,unknown>;
  if(!input||typeof input!=='object'||Array.isArray(input)||!['list','status','activate','deactivate','scope_save'].includes(String(input.action))||(input.action!=='list'&&(typeof input.alias!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.alias))))throw Error();
  const allowed=input.action==='list'?['action']:input.action==='status'?['action','alias']:['action','alias','expected_bot_id','expected_credential_revision','expected_revision','confirm',...(persistent?['expected_scope_revision']:[]),...(input.action==='scope_save'?['policy']:[])];
  if(Object.keys(input).some(k=>!allowed.includes(k)))throw Error();
  if(!['list','status'].includes(String(input.action))&&(!Number.isSafeInteger(input.expected_bot_id)||(input.expected_bot_id as number)<1||!Number.isSafeInteger(input.expected_credential_revision)||(input.expected_credential_revision as number)<1||!Number.isSafeInteger(input.expected_revision)||(input.expected_revision as number)<0||input.confirm!==input.action))throw Error();
  if(input.action==='scope_save'&&!persistent)return json(409,{status:'scope_store_disabled'});
  if(persistent&&['activate','scope_save'].includes(String(input.action))&&(!Number.isSafeInteger(input.expected_scope_revision)||(input.expected_scope_revision as number)<0||(input.expected_scope_revision as number)>=Number.MAX_SAFE_INTEGER))throw Error();
  if(input.action==='scope_save')input.policy=validateBotScope(input.policy);
 }catch{return json(400,{status:'invalid_request'})}
 const alias=input.action==='list'?'directory':input.alias as string,ownerId=snapshot.TELEGRAM_VAULT_OWNER_ID!;
 try{validateContext({ownerId,alias,purpose:'bot_token'});if(input.action!=='list'&&Object.hasOwn(getBots(snapshot),alias))return json(409,{status:'environment_bot_readonly'})}catch{return json(503,{status:'vault_configuration_invalid'})}
 const guard=()=>{const current=env();if(signal.aborted||Object.keys({...snapshot,...current}).filter(k=>k.startsWith('TELEGRAM_')).some(k=>current[k]!==snapshot[k]))throw new VaultError('configuration_changed')};
 let resource:Resource|undefined,attemptedWrite=false;
 try{
  guard();resource=await(dependencies.open??openStore)(snapshot,guard);guard();
  if(input.action==='list'){const bots=await resource.vault.listBots(ownerId);guard();return json(200,{status:'bot_inventory',bots,live_status:'not_checked'})}
  const context={ownerId,alias,purpose:'bot_token' as const},envelope=await resource.vault.loadSealed(context);guard();
  if(!envelope)return json(404,{status:'bot_not_staged'});
  const current=await resource.directory.get(ownerId,alias,persistent);guard();
  // Existing directory metadata permits stopping a Bot even when its token or
  // encryption key no longer works. Never call Telegram for deactivation.
  const id=current?.botId??Number(botToken(envelope,snapshot).split(':')[0]);
  if(!Number.isSafeInteger(id)||id<1)throw new VaultError('credential_unavailable');
  const runtime=snapshot.TELEGRAM_VAULT_BOTS_ENABLED==='true';
  const scope=persistent?await resource.scope?.get(ownerId,alias):undefined;guard();
  const project=(directory:BotDirectoryEntry|undefined)=>{
   const result=state(alias,id,envelope,directory,runtime);
   if(!persistent)return result;
   const bound=scope?.botId===id&&scope.vaultRevision===envelope.revision&&scope.revision===directory?.scopeRevision;
   return {...result,active:result.active&&bound,state:result.active&&!bound?'needs_reactivation':result.state,scope_store_enabled:true,scope_revision:scope?.revision??0,scope_credential_revision:scope?.vaultRevision??null,scope_policy:scope?.policy??null};
  };
  if(input.action==='status')return json(200,project(current));
  if(input.expected_bot_id!==id||input.expected_credential_revision!==envelope.revision||input.expected_revision!==(current?.revision??0))return json(409,{status:'state_changed'});
  if(persistent&&['activate','scope_save'].includes(String(input.action))&&input.expected_scope_revision!==(scope?.revision??0))return json(409,{status:'state_changed'});
  if(input.action==='scope_save'){
   if(!resource.scope)throw new VaultError('scope_unavailable');
   attemptedWrite=true;
   const saved=await resource.scope.save(ownerId,{alias,botId:id,vaultRevision:envelope.revision,policy:validateBotScope(input.policy)},input.expected_scope_revision as number,current?.revision??0);guard();
   return json(200,{status:'scope_saved',alias,bot_id:id,credential_revision:envelope.revision,scope_revision:saved.revision,scope_policy:saved.policy,active:false,requires_reactivation:true});
  }
  if(persistent&&input.action==='activate'&&(!scope||scope.botId!==id||scope.vaultRevision!==envelope.revision))return json(409,{status:'scope_required'});
  if(input.action==='deactivate'&&!current)return json(409,{status:'not_activated'});
  if(input.action==='activate'&&!runtime)return json(409,{status:'runtime_disabled'});
  if(input.action==='activate'){
   const token=botToken(envelope,snapshot);
   if(token.split(':')[0]!==String(id))return json(409,{status:'bot_identity_mismatch'});
   let valid=false;
   try{const response=await(dependencies.fetcher??fetch)(`https://api.telegram.org/bot${token}/getMe`,{method:'POST',body:'{}',headers:{'content-type':'application/json'},redirect:'error',cache:'no-store',signal});const data=await readBotApiJson(response,signal,32768) as {ok?:unknown;result?:{id?:unknown;is_bot?:unknown}};valid=response.ok&&data?.ok===true&&data.result?.id===id&&data.result?.is_bot===true}catch{}
   if(!valid)return json(502,{status:'bot_verification_failed'});
  }
  guard();const active=input.action==='activate';
  if(current?.active===active&&current.vaultRevision===envelope.revision&&(!persistent||current.scopeRevision===scope?.revision))return json(200,{...project(current),unchanged:true});
  attemptedWrite=true;
  const changed=await resource.directory.set(ownerId,{alias,botId:id,vaultRevision:envelope.revision,active,...(persistent&&active?{scopeRevision:scope!.revision}:{})},current?.revision??0);guard();
  return json(200,{...project(changed),unchanged:false});
 }catch(e){return json(e instanceof VaultError&&e.code==='revision_conflict'?409:503,{status:e instanceof VaultError&&e.code==='revision_conflict'?'state_changed':attemptedWrite?'state_unconfirmed':'storage_unavailable',retry_automatically:false})}
 finally{try{await resource?.close()}catch{}}
}
