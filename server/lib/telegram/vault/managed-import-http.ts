import {createHash,timingSafeEqual} from 'node:crypto';
import {readBotApiJson} from '../bot-api';
import {importManagedBot,managedImportInput} from './managed-import';
type Options={env?:()=>Record<string,string|undefined>;importer?:typeof importManagedBot};
const json=(status:number,value:unknown)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
export async function handleManagedImport(request:Request,options:Options={}){
 const env=options.env??(()=>process.env),snapshot={...env()};
 if(snapshot.TELEGRAM_MANAGED_IMPORT_ENABLED!=='true')return json(503,{status:'managed_import_disabled'});
 if(request.method!=='POST')return json(405,{status:'method_not_allowed'});
 const auth=snapshot.TELEGRAM_BOT_ENROLLMENT_AUTH,supplied=request.headers.get('authorization');
 if(!auth||auth.length<32||auth.length>256)return json(503,{status:'import_auth_unavailable'});
 if(!supplied||supplied.length>4096||!timingSafeEqual(createHash('sha256').update(supplied).digest(),createHash('sha256').update(`Bearer ${auth}`).digest()))return json(401,{status:'unauthorized'});
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return json(415,{status:'json_required'});
 const signal=AbortSignal.any([request.signal,AbortSignal.timeout(20000)]);let input;
 try{input=managedImportInput(await readBotApiJson(new Response(request.body),signal,8192))}catch{return json(400,{status:'invalid_request'})}
 let attempted=false;
 try{
  if(signal.aborted||Object.keys({...snapshot,...env()}).filter(k=>k.startsWith('TELEGRAM_')).some(k=>snapshot[k]!==env()[k]))throw Error();
  attempted=true;const result=await(options.importer??importManagedBot)(input,{env,signal});
  if(result.status==='managed_import_failed')return json(502,{status:'managed_import_failed',retry_automatically:false});
  if(result.status!=='managed_bot_staged'||!('alias' in result)||result.alias!==input.target_alias||result.bot_id!==input.managed_bot_id||!Number.isSafeInteger(result.revision)||(result.revision as number)<1||typeof result.reused!=='boolean'||result.activation_performed!==false)throw Error();
  return json(200,{status:'managed_bot_staged',alias:result.alias,bot_id:result.bot_id,revision:result.revision,reused:result.reused,activation_performed:false,retry_automatically:false});
 }catch{return json(503,{status:attempted?'storage_unconfirmed':'managed_import_unavailable',retry_automatically:false})}
}
