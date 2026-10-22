import {Api} from 'teleproto';import bigInt from 'big-integer';import {getInputPeer} from 'teleproto/Utils';
import {accountPeerSchema,type AccountPeer} from './vault/account-peers';
/** SDK entities only; discard names, phones and all other fields. */
export function captureAccountPeer(entity:unknown):AccountPeer|undefined{
 try{
  const p=getInputPeer(entity,false,true);
  if(p instanceof Api.InputPeerUser)return accountPeerSchema.parse({kind:'user',id:p.userId.toString(),accessHash:p.accessHash.toString()});
  if(p instanceof Api.InputPeerChannel)return accountPeerSchema.parse({kind:'channel',id:p.channelId.toString(),accessHash:p.accessHash.toString()});
  if(p instanceof Api.InputPeerChat)return accountPeerSchema.parse({kind:'chat',id:p.chatId.toString()});
 }catch{}return undefined;
}
export function restoreAccountPeer(value:AccountPeer):Api.TypeInputPeer{
 const peer=accountPeerSchema.parse(value);
 if(peer.kind==='user')return new Api.InputPeerUser({userId:bigInt(peer.id),accessHash:bigInt(peer.accessHash)});
 if(peer.kind==='channel')return new Api.InputPeerChannel({channelId:bigInt(peer.id),accessHash:bigInt(peer.accessHash)});
 return new Api.InputPeerChat({chatId:bigInt(peer.id)});
}
