/** Validate the direct Message receipt, never nested reply/forward metadata. */
export function matchingMessageId(value:unknown,botAlias:string,chatId:string,threadId?:number):number|undefined{
 if(!value||typeof value!=='object')return;
 const envelope=value as {bot?:unknown;result?:{message_id?:unknown;message_thread_id?:unknown;chat?:{id?:unknown}}};
 const message=envelope.result,id=message?.chat?.id;
 if(envelope.bot!==botAlias||!Number.isSafeInteger(message?.message_id)||(message!.message_id as number)<1
  ||(typeof id!=='string'&&typeof id!=='number')||(typeof id==='number'&&!Number.isSafeInteger(id))||String(id)!==chatId
  ||(threadId!==undefined&&message?.message_thread_id!==threadId))return;
 return message!.message_id as number;
}
