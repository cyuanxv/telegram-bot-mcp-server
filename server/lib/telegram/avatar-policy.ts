import {assertAvatarWriteScope} from './avatar-bytes';
import {validateBotScope} from './vault/bot-scope';
/** Only the reviewed Bot's own first profile photo; never arbitrary user lookup. */
export function assertAvatarRequest(method:string,params:Record<string,unknown>,expectedBotId?:string){
 const deny=()=>{throw Error('Avatar request denied')};
 if(expectedBotId!==undefined&&!/^[1-9][0-9]{0,18}$/.test(expectedBotId))deny();
 if(method==='getMe'){if(Object.keys(params).length)deny();return}
 if(!expectedBotId)deny();
 if(method==='getUserProfilePhotos'){
  if(Object.keys(params).some(k=>!['user_id','offset','limit'].includes(k))||String(params.user_id)!==expectedBotId||params.offset!==0||params.limit!==1)deny();return;
 }
 if(method==='removeMyProfilePhoto'){if(Object.keys(params).length)deny();return}
 if(method==='setMyProfilePhoto'){
  const p=params.photo as Record<string,unknown>;
  if(Object.keys(params).length!==1||!p||typeof p!=='object'||Array.isArray(p))deny();
  if(p.type==='static'){
   if(Object.keys(p).some(k=>!['type','photo'].includes(k))||p.photo!=='attach://avatar_file')deny();
  }else if(p.type==='animated'){
   if(Object.keys(p).some(k=>!['type','animation','main_frame_timestamp'].includes(k))||p.animation!=='attach://avatar_file'||(p.main_frame_timestamp!==undefined&&(typeof p.main_frame_timestamp!=='number'||!Number.isFinite(p.main_frame_timestamp)||p.main_frame_timestamp<0)))deny();
  }else deny();return;
 }
 deny();
}
export function assertVaultAvatarRequest(alias:string,botId:number,method:string,params:Record<string,unknown>,expectedBotId:string|undefined,env:Record<string,string|undefined>,savedPolicy:unknown){
 assertAvatarRequest(method,params,expectedBotId);
 if(expectedBotId!==undefined&&expectedBotId!==String(botId))throw Error('Avatar identity denied');
 if(!validateBotScope(savedPolicy).methods.includes(method))throw Error('Avatar method denied');
 if(['setMyProfilePhoto','removeMyProfilePhoto'].includes(method))assertAvatarWriteScope(alias,env);
}
