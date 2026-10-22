import {createHash} from 'node:crypto';
import {getBots} from './config';
export const MAX_AVATAR_BYTES=2*1024*1024;
export type AvatarUpload={kind:'static'|'animated';base64:string;sha256:string;main_frame_timestamp?:number};
export function assertAvatarWriteScope(alias:string,env:Record<string,string|undefined>=process.env){
  if(env.TELEGRAM_AVATAR_WRITE_ENABLED!=='true'||(!Object.hasOwn(getBots(env),alias)&&(env.TELEGRAM_VAULT_BOTS_ENABLED!=='true'||env.TELEGRAM_VAULT_SCOPE_STORE_ENABLED!=='true')))throw Error('Avatar writes disabled');
  let aliases:unknown;try{aliases=JSON.parse(env.TELEGRAM_AVATAR_BOTS_JSON??'null')}catch{throw Error('Invalid avatar scope')}
  if(!Array.isArray(aliases)||!aliases.length||aliases.length>25||new Set(aliases).size!==aliases.length
    ||aliases.some(a=>typeof a!=='string'||!/^[A-Za-z0-9._-]{1,64}$/.test(a))||!aliases.includes(alias))throw Error('Avatar Bot outside approved scope');
}
/** Local envelope/signature validation only; Telegram validates actual media decoding. */
export function buildAvatarMultipart(input:AvatarUpload){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['kind','base64','sha256','main_frame_timestamp'].includes(k))
    ||!['static','animated'].includes(input.kind)||typeof input.sha256!=='string'||!/^[0-9a-f]{64}$/.test(input.sha256)
    ||typeof input.base64!=='string'||input.base64.length<4||input.base64.length>Math.ceil(MAX_AVATAR_BYTES/3)*4
    ||input.base64.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64))throw Error('Invalid avatar upload');
  const bytes=Buffer.from(input.base64,'base64');
  if(bytes.length>MAX_AVATAR_BYTES||bytes.toString('base64')!==input.base64||createHash('sha256').update(bytes).digest('hex')!==input.sha256)throw Error('Avatar content or digest invalid');
  const timestamp=input.main_frame_timestamp;
  if(timestamp!==undefined&&(input.kind!=='animated'||!Number.isFinite(timestamp)||timestamp<0))throw Error('Invalid avatar frame timestamp');
  if(input.kind==='static'&&(bytes.length<4||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255||bytes.at(-2)!==255||bytes.at(-1)!==217))throw Error('Static avatar requires JPEG bytes');
  if(input.kind==='animated'&&(bytes.length<16||bytes.toString('ascii',4,8)!=='ftyp'))throw Error('Animated avatar requires MPEG4 bytes');
  const photo=input.kind==='static'?{type:'static',photo:'attach://avatar_file'}:{type:'animated',animation:'attach://avatar_file',...(timestamp===undefined?{}:{main_frame_timestamp:timestamp})};
  const body=new FormData();body.append('photo',JSON.stringify(photo));
  body.append('avatar_file',new Blob([new Uint8Array(bytes)],{type:input.kind==='static'?'image/jpeg':'video/mp4'}),input.kind==='static'?'avatar.jpg':'avatar.mp4');
  return {body,photo,totalBytes:bytes.length};
}
