import {createHash} from 'node:crypto';
import {z} from 'zod';
import {callBotAvatarApi,callBotAvatarBytes} from './bot-api';
import {decimalId} from './inbox/normalize';
import {assertAvatarWriteScope,buildAvatarMultipart,MAX_AVATAR_BYTES,type AvatarUpload} from './avatar-bytes';
const alias=z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),digest=z.string().regex(/^[0-9a-f]{64}$/);
const expected={bot_alias:alias,expected_bot_id:z.string().regex(/^[1-9][0-9]{0,18}$/),expected_avatar_fingerprint:digest,confirm:z.literal(true)};
export const botAvatarSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('inspect'),bot_alias:alias}).strict(),
 z.object({action:z.literal('remove'),...expected}).strict(),
 z.object({action:z.literal('set'),...expected,upload:z.object({kind:z.enum(['static','animated']),base64:z.string().max(Math.ceil(MAX_AVATAR_BYTES/3)*4),sha256:digest,main_frame_timestamp:z.number().nonnegative().optional()}).strict()}).strict(),
]);
type Options={env?:()=>Record<string,string|undefined>;call?:typeof callBotAvatarApi;upload?:typeof callBotAvatarBytes;signal?:AbortSignal};
export async function manageBotAvatar(input:unknown,options:Options={}){
 const args=botAvatarSchema.parse(input),env=options.env??(()=>process.env),call=options.call??callBotAvatarApi,upload=options.upload??callBotAvatarBytes;
 const snapshot={...env()},signal=AbortSignal.any([AbortSignal.timeout(30000),...(options.signal?[options.signal]:[])]);
 const guard=()=>{const current=env();if(signal.aborted||Object.keys({...snapshot,...current}).filter(k=>k.startsWith('TELEGRAM_')).some(k=>snapshot[k]!==current[k]))throw Error('Avatar operation scope changed');if(args.action!=='inspect')assertAvatarWriteScope(args.bot_alias,current)};
 let expectedBotId=args.action==='inspect'?undefined:args.expected_bot_id;
 guard();if(args.action==='set')buildAvatarMultipart(args.upload as AvatarUpload);
 const invoke=async(method:string,params:Record<string,unknown>)=>{guard();const value=await call(args.bot_alias,method,params,{}, {signal,guard,expectedBotId});guard();if(value.bot!==args.bot_alias)throw Error('Avatar response identity mismatch');return value.result};
 const me=await invoke('getMe',{}) as Record<string,unknown>;if(!me||me.is_bot!==true)throw Error('Invalid Bot identity');const botId=decimalId(me.id);expectedBotId=botId;
 if(args.action!=='inspect'&&botId!==decimalId(args.expected_bot_id))throw Error('Bot identity changed since review');
 const read=async()=>{
   const raw=await invoke('getUserProfilePhotos',{user_id:botId,offset:0,limit:1}) as {total_count:number;photos:unknown[][]};
   if(!raw||!Number.isSafeInteger(raw.total_count)||raw.total_count<0||!Array.isArray(raw.photos)||raw.photos.length>1
     ||(raw.total_count===0?raw.photos.length!==0:raw.photos.length!==1))throw Error('Invalid avatar observation');
   const sizes=(raw.photos[0]??[]).map(v=>{
     const p=v as Record<string,unknown>;
     if(!p||typeof p.file_unique_id!=='string'||!p.file_unique_id.length||p.file_unique_id.length>512
       ||!Number.isSafeInteger(p.width)||!Number.isSafeInteger(p.height)||(p.width as number)<1||(p.height as number)<1)throw Error('Invalid avatar size');
     return {id:p.file_unique_id,width:p.width as number,height:p.height as number};
   }).sort((a,b)=>a.width-b.width||a.height-b.height||a.id.localeCompare(b.id));
   if((raw.total_count>0&&!sizes.length)||sizes.length>20)throw Error('Invalid avatar sizes');
   return {total_count:raw.total_count,fingerprint:createHash('sha256').update(JSON.stringify({botId,total:raw.total_count,sizes})).digest('hex')};
 };
 const before=await read();
 if(args.action==='inspect')return {bot_alias:args.bot_alias,bot_id:botId,...before,changed:false};
 if(before.fingerprint!==args.expected_avatar_fingerprint)return {changed:false,status:'avatar_changed_since_review',retry_automatically:false};
 if(args.action==='remove'&&before.total_count===0)return {changed:false,status:'already_empty',retry_automatically:false};
 let acknowledged=false;
 try{
   guard();const ack=args.action==='set'?await upload(args.bot_alias,args.upload as AvatarUpload,{signal,guard,expectedBotId}):await call(args.bot_alias,'removeMyProfilePhoto',{}, {},{signal,guard,expectedBotId});
   if(ack.bot!==args.bot_alias||ack.result!==true)throw Error('Unconfirmed avatar write');acknowledged=true;
 }catch{return {changed:null,status:'write_unconfirmed',retry_automatically:false}};
 try{
   const after=await read();
   return {bot_alias:args.bot_alias,bot_id:botId,acknowledged,changed:true,status:'write_acknowledged',observation:after,
     observed_change:before.fingerprint!==after.fingerprint,removal_verified:args.action==='remove'&&after.total_count===0,
     uploaded_content_verified:false,retry_automatically:false};
 }catch{return {acknowledged,changed:true,status:'readback_unavailable',uploaded_content_verified:false,retry_automatically:false}};
}
