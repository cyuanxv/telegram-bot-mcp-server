import {getBots} from '../config';
import {readBotApiJson} from '../bot-api';
import {enrollBot} from './bot-enrollment';
type Env=Record<string,string|undefined>;
type Input={manager_alias:string;managed_bot_id:number;target_alias:string;confirm:true};
type Options={env?:()=>Env;fetcher?:typeof fetch;enroll?:typeof enrollBot;signal?:AbortSignal};
const alias=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v);
const denied=()=>{throw Error('Managed Bot import unavailable')};
export function managedImportInput(input:unknown):Input{
 const args=structuredClone(input) as Input;
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['manager_alias','managed_bot_id','target_alias','confirm'].includes(k))||!alias(args.manager_alias)||!alias(args.target_alias)||args.confirm!==true||!Number.isSafeInteger(args.managed_bot_id)||args.managed_bot_id<1)denied();
 return args;
}
/** Trusted server-only handoff. Never expose the retrieved token to callers. */
export async function importManagedBot(input:unknown,options:Options={}){
 const env=options.env??(()=>process.env),snapshot={...env()},args=managedImportInput(input);
 const signal=AbortSignal.any([AbortSignal.timeout(15000),...(options.signal?[options.signal]:[])]);
 const guard=()=>{
  if(signal.aborted||snapshot.TELEGRAM_MANAGED_IMPORT_ENABLED!=='true'||snapshot.TELEGRAM_BOT_ENROLLMENT_ENABLED!=='true'
   ||Object.keys({...snapshot,...env()}).filter(k=>k.startsWith('TELEGRAM_')).some(k=>snapshot[k]!==env()[k]))denied();
 };
 guard();let rules:unknown;
 try{const raw=snapshot.TELEGRAM_MANAGED_IMPORT_TARGETS_JSON;if(!raw||raw.length>16384)denied();rules=JSON.parse(raw!)}catch{denied()}
 if(!Array.isArray(rules)||!rules.length||rules.length>25||rules.some(r=>!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['manager_alias','managed_bot_id','target_alias'].includes(k))||!alias(r.manager_alias)||!alias(r.target_alias)||!Number.isSafeInteger(r.managed_bot_id)||r.managed_bot_id<1)
  ||!rules.some(r=>r.manager_alias===args.manager_alias&&r.managed_bot_id===args.managed_bot_id&&r.target_alias===args.target_alias))denied();
 const bots=getBots(snapshot),manager=bots[args.manager_alias],auth=snapshot.TELEGRAM_BOT_ENROLLMENT_AUTH;
 if(!manager||Object.hasOwn(bots,args.target_alias)||!auth||auth.length<32||auth.length>256)denied();
 let storing=false;
 try{
  guard();const response=await(options.fetcher??fetch)(`https://api.telegram.org/bot${manager.token}/getManagedBotToken`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user_id:args.managed_bot_id}),signal,redirect:'error',cache:'no-store'});
  const raw=await readBotApiJson(response,signal,8192) as {ok?:unknown;result?:unknown};guard();
  if(!response.ok||raw?.ok!==true||typeof raw.result!=='string'||!new RegExp('^'+args.managed_bot_id+':[A-Za-z0-9_-]{20,128}$').test(raw.result))throw Error();
  // Reuse the existing child getMe validation, encrypted storage and no-activation path.
  const request=new Request('https://internal.invalid/enroll',{method:'POST',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},body:JSON.stringify({action:'stage',token:raw.result,alias:args.target_alias,expected_bot_id:args.managed_bot_id}),signal});
  guard();storing=true;
  const saved=await(options.enroll??enrollBot)(request,{env,fetcher:options.fetcher});
  const result=await readBotApiJson(saved,signal,8192) as Record<string,unknown>;guard();
  if(!saved.ok||result.status!=='staged'||result.bot_id!==args.managed_bot_id||result.alias!==args.target_alias||!Number.isSafeInteger(result.revision)||(result.revision as number)<1||typeof result.reused!=='boolean')throw Error();
  return {status:'managed_bot_staged',alias:args.target_alias,bot_id:args.managed_bot_id,revision:result.revision,reused:result.reused,activation_performed:false,retry_automatically:false};
 }catch{return {status:storing?'storage_unconfirmed':'managed_import_failed',retry_automatically:false}}
}
