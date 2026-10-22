import {createHash,timingSafeEqual} from 'node:crypto';
import {Pool} from 'pg';
import {getBots} from '../config';
import {readBotApiJson} from '../bot-api';
import {approvedInboxPolicies} from './config';
import {pollInboxBatch} from './polling';
import {PgPoolDatabase} from '../delivery/pg-pool-adapter';
import {postgresConnectionConfig} from '../delivery/postgres-config';
import type {TransactionalSql} from '../delivery/postgres-store';
type Env=Record<string,string|undefined>;
type Resource={database:TransactionalSql;close:()=>Promise<void>};
type Options={env?:()=>Env;fetcher?:typeof fetch;open?:(env:Env,guard:()=>void)=>Promise<Resource>};
const json=(status:number,value:unknown)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
async function openProduction(env:Env,guard:()=>void):Promise<Resource>{
 const pool=new Pool({...postgresConnectionConfig(env),max:1,idle_in_transaction_session_timeout:45000});pool.on('error',()=>{});
 return {database:new PgPoolDatabase(pool,{guard}),close:()=>pool.end()};
}
/** Server-controlled single static Bot, no payload-supplied token/offset/scope. */
export async function handlePolling(request:Request,options:Options={}){
 const env=options.env??(()=>process.env),snapshot={...env()};
 if(snapshot.TELEGRAM_POLLING_ENABLED!=='true')return json(503,{status:'polling_disabled'});
 const auth=snapshot.TELEGRAM_POLLING_AUTH;
 if(!auth||auth.length<32||auth.length>256)return json(503,{status:'polling_auth_missing'});
 const supplied=request.headers.get('authorization')??'';
 if(supplied.length>512||!timingSafeEqual(createHash('sha256').update(supplied).digest(),createHash('sha256').update('Bearer '+auth).digest()))return json(401,{status:'unauthorized'});
 if(request.method!=='POST')return json(405,{status:'method_not_allowed'});
 if(new URL(request.url).search||request.body!==null)return json(400,{status:'payload_not_allowed'});
 let alias:string,botId:string,token:string,policy:ReturnType<typeof approvedInboxPolicies>['bots'][string];
 try{
  if(snapshot.TELEGRAM_WEBHOOK_ENABLED==='true'||snapshot.TELEGRAM_VAULT_OWNER_ID!=='telegram-cloud-owner')throw Error();
  alias=snapshot.TELEGRAM_POLLING_BOT_ALIAS!;botId=snapshot.TELEGRAM_POLLING_BOT_ID!;
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias)||!/^[1-9][0-9]{0,15}$/.test(botId))throw Error();
  token=getBots(snapshot)[alias]?.token;
  if(typeof token!=='string'||!/^\d+:[A-Za-z0-9_-]+$/.test(token)||token.split(':')[0]!==botId)throw Error();
  policy=approvedInboxPolicies(snapshot).bots[alias];if(!policy||policy.allowedBusinessConnectionIds?.length||policy.acceptDraftStops)throw Error();
 }catch{return json(503,{status:'polling_configuration_invalid'})}
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),40000);
 const signal=AbortSignal.any([request.signal,controller.signal]);
 const guard=()=>{signal.throwIfAborted();const current=env();if(Object.keys({...snapshot,...current}).some(k=>k.startsWith('TELEGRAM_')&&snapshot[k]!==current[k]))throw Error('configuration_changed')};
 const call=async(method:string,params:Record<string,unknown>={})=>{
  guard();const response=await(options.fetcher??fetch)(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(params),signal,redirect:'error',cache:'no-store'});
  const raw=await readBotApiJson(response,signal) as {ok?:unknown;result?:unknown};guard();
  if(!response.ok||raw?.ok!==true||!Object.hasOwn(raw,'result'))throw Error('polling_provider_failure');return raw.result;
 };
 let resource:Resource|undefined;
 try{
  const me=await call('getMe') as {id?:unknown;is_bot?:unknown};
  if(me?.is_bot!==true||typeof me.id!=='number'||!Number.isSafeInteger(me.id)||String(me.id)!==botId)throw Error('polling_identity_mismatch');
  guard();resource=await(options.open??openProduction)(snapshot,guard);guard();
  const result=await pollInboxBatch({database:resource.database,ownerId:'telegram-cloud-owner',botAlias:alias,botId,policy,guard,now:Date.now,provider:{webhook:async()=>await call('getWebhookInfo') as {url:string},getUpdates:args=>call('getUpdates',args)}});
  return json(result.status==='webhook_active'?409:200,{...result,automatic_reply:false});
 }catch{return json(503,{status:'polling_failed',resume_from_stored_cursor:true,automatic_retry_performed:false})}
 finally{
  let closeTimer:ReturnType<typeof setTimeout>|undefined;
  try{if(resource)await Promise.race([resource.close(),new Promise<void>(resolve=>{closeTimer=setTimeout(resolve,2000)})])}catch{/* no provider or database details */}
  finally{clearTimeout(closeTimer);clearTimeout(timer)}
 }
}
