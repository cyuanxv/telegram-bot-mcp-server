import {assertVaultCallbackAnswer} from '../inbox/answer-policy';
import {assertVaultAvatarRequest} from "../avatar-policy";
import { assertVaultInboxControl } from "../inbox/control-policy";
import {loadVaultKeyring} from './keyring';
import {Pool} from "pg";
import {getBots,resolveBot,type BotConfig} from "../config";
import {postgresConnectionConfig} from "../delivery/postgres-config";
import {PgPoolDatabase} from "../delivery/pg-pool-adapter";
import {openCredential,validateContext,VaultError} from "./crypto";
import {BotDirectory} from "./bot-directory";
import {BotScopeStore} from "./bot-scope-store";
import {assertBotScopePolicy} from "./bot-scope";
type Env=Record<string,string|undefined>;
type Resource={directory:Pick<BotDirectory,"listActive"|"loadActive">;scope?:Pick<BotScopeStore,"get">;close():Promise<void>};
type Dependencies={env?:()=>Env;open?:(env:Env,guard:()=>void)=>Promise<Resource>;signal?:AbortSignal;request?:{method:string;params:Record<string,unknown>;purpose?:"inbox_control"|"avatar_control"|"callback_answer";expectedBotId?:string}};
async function openStore(env:Env,guard:()=>void):Promise<Resource>{guard();const pool=new Pool(postgresConnectionConfig(env));return {directory:new BotDirectory(new PgPoolDatabase(pool,{guard})),scope:new BotScopeStore(new PgPoolDatabase(pool,{guard})),close:()=>pool.end()}}
async function usingDirectory<T>(dependencies:Dependencies,operation:(r:Resource,env:Env)=>Promise<T>):Promise<T>{
 const env=dependencies.env??(()=>process.env),snapshot={...env()};
 if(snapshot.TELEGRAM_VAULT_BOTS_ENABLED!=="true")throw new VaultError("runtime_disabled");
 validateContext({ownerId:snapshot.TELEGRAM_VAULT_OWNER_ID!,alias:"runtime",purpose:"bot_token"});
 const guard=()=>{const current=env();if(dependencies.signal?.aborted||Object.keys({...snapshot,...current}).filter(k=>k.startsWith('TELEGRAM_')).some(k=>snapshot[k]!==current[k]))throw new VaultError("configuration_changed")};
 let resource:Resource|undefined;
 try{guard();resource=await(dependencies.open??openStore)(snapshot,guard);const result=await operation(resource,snapshot);await resource.close();resource=undefined;guard();return result}
 catch(e){if(e instanceof VaultError)throw e;throw new VaultError("runtime_unavailable")}
 finally{try{await resource?.close()}catch{}}
}
/** No token decryption or output in inventory. Existing environment aliases win. */
export async function listRuntimeBots(dependencies:Dependencies={}){
 const env=(dependencies.env??(()=>process.env))(),bots=getBots(env);
 const configured=Object.entries(bots).map(([alias,config])=>({alias,label:config.label}));
 if(env.TELEGRAM_VAULT_BOTS_ENABLED!=="true")return configured;
 return usingDirectory(dependencies,async(r,snapshot)=>{
  const rows=await r.directory.listActive(snapshot.TELEGRAM_VAULT_OWNER_ID!,snapshot.TELEGRAM_VAULT_SCOPE_STORE_ENABLED==='true');
  // Only release aliases whose activation still binds an existing saved revision.
  for(const row of rows){if(row.active&&!Object.hasOwn(bots,row.alias))configured.push({alias:row.alias,label:undefined})}
  return configured;
 });
}
/** Backend-only credentials: explicit alias required for vault Bots; no cache. */
export async function resolveRuntimeBot(alias:string|undefined,dependencies:Dependencies={}):Promise<{alias:string;config:BotConfig}>{
 const env=(dependencies.env??(()=>process.env))();
 if(!alias||Object.hasOwn(getBots(env),alias)||env.TELEGRAM_VAULT_BOTS_ENABLED!=="true"){
  if(!dependencies.env)return resolveBot(alias);
  const bots=getBots(env),keys=Object.keys(bots),selected=alias??(Object.hasOwn(bots,'default')?'default':keys.length===1?keys[0]:undefined);
  if(!selected||!Object.hasOwn(bots,selected))throw new VaultError("bot_unavailable");return {alias:selected,config:bots[selected]};
 }
 return usingDirectory(dependencies,async(r,snapshot)=>{
  const persistent=snapshot.TELEGRAM_VAULT_SCOPE_STORE_ENABLED==='true';
  if(dependencies.request?.purpose&&!persistent)throw new VaultError('scope_unavailable');
  const stored=structuredClone(await r.directory.loadActive(snapshot.TELEGRAM_VAULT_OWNER_ID!,alias,persistent));if(!stored)throw new VaultError("bot_unavailable");
  if(persistent){
   const scope=await r.scope?.get(snapshot.TELEGRAM_VAULT_OWNER_ID!,alias);
   if(!scope||!dependencies.request||scope.botId!==stored.entry.botId||scope.vaultRevision!==stored.entry.vaultRevision||scope.revision!==stored.entry.scopeRevision)throw new VaultError("scope_unavailable");
   try{if(dependencies.request.purpose==='avatar_control')assertVaultAvatarRequest(alias,stored.entry.botId,dependencies.request.method,dependencies.request.params,dependencies.request.expectedBotId,snapshot,scope.policy);else if(dependencies.request.purpose==='callback_answer')assertVaultCallbackAnswer(alias,dependencies.request.method,dependencies.request.params,snapshot,scope.policy);else if(dependencies.request.purpose==='inbox_control')assertVaultInboxControl(alias,dependencies.request.method,dependencies.request.params,snapshot,scope.policy);else assertBotScopePolicy(scope.policy,dependencies.request.method,dependencies.request.params)}catch{throw new VaultError("scope_denied")}
  }
  // Scope reads can yield while another request deactivates or rotates this Bot.
  // Bind release to a fresh activation snapshot, not merely the earlier lookup.
  const latest=await r.directory.loadActive(snapshot.TELEGRAM_VAULT_OWNER_ID!,alias,persistent);
  if(!latest||!latest.entry.active||latest.entry.alias!==stored.entry.alias
    ||latest.entry.botId!==stored.entry.botId||latest.entry.revision!==stored.entry.revision
    ||latest.entry.vaultRevision!==stored.entry.vaultRevision||latest.entry.scopeRevision!==stored.entry.scopeRevision)
    throw new VaultError('bot_state_changed');
  const keyring=loadVaultKeyring(snapshot);
  try{
   const secret=openCredential({ownerId:snapshot.TELEGRAM_VAULT_OWNER_ID!,alias,purpose:'bot_token'},stored.envelope,keyring.keys,Date.now());
   if(!('token' in secret)||secret.token.split(':')[0]!==String(stored.entry.botId))throw new VaultError("bot_identity_mismatch");
   return {alias,config:{token:secret.token}};
  }finally{keyring.dispose()}
 });
}
