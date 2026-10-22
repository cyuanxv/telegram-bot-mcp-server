import {getBots} from '../config';
export const memberPermissionFields=['can_send_messages', 'can_send_audios', 'can_send_documents', 'can_send_photos', 'can_send_videos', 'can_send_video_notes', 'can_send_voice_notes', 'can_send_polls', 'can_send_other_messages', 'can_add_web_page_previews', 'can_react_to_messages', 'can_edit_tag', 'can_change_info', 'can_invite_users', 'can_pin_messages', 'can_manage_topics'];
type Env=Record<string,string|undefined>;
// Methods reviewed for their destination fields. Expanding this table requires
// auditing new target selectors; an arbitrary method name cannot bypass scope.
const targetFields:Record<string,string[]>={
 answerCallbackQuery:[],
 getUserProfilePhotos:[],setMyProfilePhoto:[],removeMyProfilePhoto:[],
 setMyName:[],setMyDescription:[],setMyShortDescription:[],
 setChatMenuButton:[],setMyCommands:[],deleteMyCommands:[],
 getMe:[],getMyName:[],getMyDescription:[],getMyShortDescription:[],getMyCommands:[],getChatMenuButton:[],
 createForumTopic:['chat_id'],editForumTopic:['chat_id'],closeForumTopic:['chat_id'],reopenForumTopic:['chat_id'],deleteForumTopic:['chat_id'],unpinAllForumTopicMessages:['chat_id'],editGeneralForumTopic:['chat_id'],closeGeneralForumTopic:['chat_id'],reopenGeneralForumTopic:['chat_id'],hideGeneralForumTopic:['chat_id'],unhideGeneralForumTopic:['chat_id'],unpinAllGeneralForumTopicMessages:['chat_id'],
 restrictChatMember:['chat_id'],
 banChatMember:['chat_id'],unbanChatMember:['chat_id'],
 createChatInviteLink:['chat_id'],editChatInviteLink:['chat_id'],revokeChatInviteLink:['chat_id'],
 getChat:['chat_id'],getChatMember:['chat_id'],getChatAdministrators:['chat_id'],getChatMemberCount:['chat_id'],
 sendMessageDraft:['chat_id'],sendMessage:['chat_id'],sendPhoto:['chat_id'],sendDocument:['chat_id'],sendVideo:['chat_id'],sendAudio:['chat_id'],sendVoice:['chat_id'],sendAnimation:['chat_id'],sendMediaGroup:['chat_id'],
 editMessageText:['chat_id'],editMessageCaption:['chat_id'],editMessageReplyMarkup:['chat_id'],deleteMessage:['chat_id'],deleteMessages:['chat_id'],setMessageReaction:['chat_id'],pinChatMessage:['chat_id'],unpinChatMessage:['chat_id'],
 forwardMessage:['chat_id','from_chat_id'],forwardMessages:['chat_id','from_chat_id'],copyMessage:['chat_id','from_chat_id'],copyMessages:['chat_id','from_chat_id'],
};
const deny=()=>{throw new Error('Vault Bot scope denied; no Telegram request was made')};
const id=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v!==0?String(v):typeof v==='string'&&/^-?[1-9][0-9]{0,15}$/.test(v)&&Number.isSafeInteger(Number(v))?v:undefined;
/** Static Bots keep their existing controls. Vault Bots require an explicit policy. */
export function assertVaultBotScope(alias:string|undefined,method:string,params:Record<string,unknown>,env:Env=process.env){
 if(!alias||Object.hasOwn(getBots(env),alias))return;
 if(env.TELEGRAM_VAULT_SCOPE_STORE_ENABLED==='true')return; // Enforced by runtime resolver before decrypting.
 let registry:unknown;
 try{const raw=env.TELEGRAM_VAULT_BOT_SCOPES_JSON;if(!raw||raw.length>65536)deny();registry=JSON.parse(raw!)}catch{deny()}
 if(!registry||typeof registry!=='object'||Array.isArray(registry)||!Object.hasOwn(registry,alias))deny();
 const policy=validateBotScope((registry as Record<string,unknown>)[alias]);
 assertBotScopePolicy(policy,method,params);
}
export function assertBotScopePolicy(input:unknown,method:string,params:Record<string,unknown>){
 if(method==='answerCallbackQuery')deny(); // Requires stored event context through the dedicated internal channel.
 const policy=validateBotScope(input);
 if(!policy.methods.includes(method))deny();
 const allowed=new Set((policy.chat_ids as unknown[]).map(id));
 if(method==='sendMessageDraft'){
  const chat=id(params.chat_id);
  if(!chat||BigInt(chat)<=0n||!allowed.has(chat)||Object.keys(params).some(k=>!['chat_id','draft_id','text','message_thread_id','can_stop','keep_on_stop'].includes(k))||!Number.isSafeInteger(params.draft_id)||(params.draft_id as number)<=0||typeof params.text!=='string'||Array.from(params.text).length>4096||(params.message_thread_id!==undefined&&(!Number.isSafeInteger(params.message_thread_id)||(params.message_thread_id as number)<=0)))deny();
  if((params.can_stop!==undefined&&typeof params.can_stop!=='boolean')||(params.keep_on_stop!==undefined&&params.keep_on_stop!==false))deny();
  return;
 }

 if(['getUserProfilePhotos','setMyProfilePhoto','removeMyProfilePhoto'].includes(method))deny(); // Dedicated avatar channel only; never generic Bot API.

 // Profile permissions are individual and never imply another field or method.
 const profile:Record<string,{field:string;limit:number}>={setMyName:{field:'name',limit:64},setMyDescription:{field:'description',limit:512},setMyShortDescription:{field:'short_description',limit:120}};
 if(Object.hasOwn(profile,method)){
  const {field,limit}=profile[method];
  if(Object.keys(params).some(k=>![field,'language_code'].includes(k)))deny();
  // Require an explicit value: an omitted field must not silently reset content.
  const value=params[field];
  if(typeof value!=='string'||Array.from(value).length>limit)deny();
  if(params.language_code!==undefined&&(typeof params.language_code!=='string'||!/^([a-z]{2})?$/.test(params.language_code)))deny();
  return;
 }

 // Command scopes are checked equally for reads, replacements and deletions.
 if(['getMyCommands','setMyCommands','deleteMyCommands'].includes(method)){
  const fields=method==='setMyCommands'?['scope','language_code','commands']:['scope','language_code'];
  if(Object.keys(params).some(k=>!fields.includes(k)))deny();
  if(method==='setMyCommands'){
   if(!Array.isArray(params.commands)||params.commands.length>100)deny();
   const seen=new Set<string>();
   for(const item of params.commands as unknown[]){
    if(!item||typeof item!=='object'||Array.isArray(item))deny();
    const c=item as Record<string,unknown>;
    if(Object.keys(c).some(k=>!['command','description','is_ephemeral'].includes(k))
      ||typeof c.command!=='string'||!/^[a-z0-9_]{1,32}$/.test(c.command)
      ||typeof c.description!=='string'||Array.from(c.description).length<1||Array.from(c.description).length>256
      ||(c.is_ephemeral!==undefined&&typeof c.is_ephemeral!=='boolean'))deny();
    if(seen.has(c.command as string))deny();seen.add(c.command as string);
   }
  }
  if(params.language_code!==undefined&&(typeof params.language_code!=='string'||!/^([a-z]{2})?$/.test(params.language_code)))deny();
  const scope=params.scope===undefined?{type:'default'}:params.scope;
  if(!scope||typeof scope!=='object'||Array.isArray(scope))deny();
  const value=scope as Record<string,unknown>;
  const globalTypes=['default','all_private_chats','all_group_chats','all_chat_administrators'];
  const chatTypes=['chat','chat_administrators','chat_member'];
  if(typeof value.type!=='string')deny();
  if(globalTypes.includes(value.type as string)){
   if(Object.keys(value).some(k=>k!=='type'))deny();
  }else if(chatTypes.includes(value.type as string)){
   const fields=value.type==='chat_member'?['type','chat_id','user_id']:['type','chat_id'];
   if(Object.keys(value).some(k=>!fields.includes(k)))deny();
   const chat=id(value.chat_id);if(!chat||!allowed.has(chat))deny();
   if(value.type==='chat_member'){const user=id(value.user_id);if(!user||BigInt(user)<=0n)deny()}
  }else deny();
  return;
 }
 if(method==='getChatMenuButton'||method==='setChatMenuButton'){
  if(Object.keys(params).some(k=>!['chat_id',...(method==='setChatMenuButton'?['menu_button']:[])].includes(k)))deny();
  if(method==='setChatMenuButton'){
   const menu=params.menu_button as Record<string,unknown>;
   if(!menu||typeof menu!=='object'||Array.isArray(menu))deny();
   if(menu.type==='default'||menu.type==='commands'){
    if(Object.keys(menu).some(k=>k!=='type'))deny();
   }else if(menu.type==='web_app'){
    if(Object.keys(menu).some(k=>!['type','text','web_app'].includes(k))||typeof menu.text!=='string'||!menu.text.length||Array.from(menu.text).length>128)deny();
    const app=menu.web_app as Record<string,unknown>;
    if(!app||typeof app!=='object'||Array.isArray(app)||Object.keys(app).some(k=>k!=='url')||typeof app.url!=='string'||!app.url.length||app.url.length>4096)deny();
    try{const url=new URL(app.url as string);if(url.protocol!=='https:'||!url.hostname||url.username||url.password)deny()}catch{deny()}
   }else deny();
  }
  if(Object.hasOwn(params,'chat_id')){const chat=id(params.chat_id);if(!chat||BigInt(chat)<=0n||!allowed.has(chat))deny()}
  return;
 }
 if(['banChatMember','unbanChatMember','restrictChatMember'].includes(method)){
  const user=id(params.user_id);if(!user||BigInt(user)<=0n)deny();
  if(method==='unbanChatMember'&&params.only_if_banned!==true)deny();
 }
 if(method==='restrictChatMember'){
  const p=params.permissions as Record<string,unknown>;
  if(params.use_independent_chat_permissions!==true||!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!memberPermissionFields.includes(k))||memberPermissionFields.some(k=>typeof p[k]!=='boolean'))deny();
  if(!Number.isSafeInteger(params.until_date)||(params.until_date as number)<0)deny();
 }
 const fields=targetFields[method];if(!fields)deny();
 if(Object.hasOwn(params,'inline_message_id')||Object.hasOwn(params,'business_connection_id'))deny();
 for(const field of fields){const value=id(params[field]);if(!value||!allowed.has(value))deny()}
 // Reject undeclared direct selectors and cross-chat replies outside the policy.
 for(const field of Object.keys(params)){if(field.endsWith('chat_id')&&!fields.includes(field))deny()}
 if(params.reply_parameters!==undefined){
  const reply=params.reply_parameters;
  if(!reply||typeof reply!=='object'||Array.isArray(reply))deny();
  if(Object.hasOwn(reply as object,'chat_id')){const value=id((reply as Record<string,unknown>).chat_id);if(!value||!allowed.has(value))deny()}
 }
}

export type BotScope={methods:string[];chat_ids:string[]};
/** Shared by environment policies and the persistent private control plane. */
export function validateBotScope(input:unknown):BotScope{
 const policy=input as Record<string,unknown>;
 if(!policy||typeof policy!=='object'||Array.isArray(policy)||Object.keys(policy).some(k=>!['methods','chat_ids'].includes(k)))deny();
 if(!Array.isArray(policy.methods)||policy.methods.length>64||!policy.methods.every(m=>typeof m==='string'&&Object.hasOwn(targetFields,m)))deny();
 if(!Array.isArray(policy.chat_ids)||policy.chat_ids.length>100||!policy.chat_ids.every(v=>id(v)!==undefined))deny();
 return {methods:[...new Set(policy.methods as string[])].sort(),chat_ids:[...new Set((policy.chat_ids as unknown[]).map(v=>id(v)!))].sort()};
}
