import test from 'node:test';
import assert from 'node:assert/strict';
import {assertVaultBotScope} from '../lib/telegram/vault/bot-scope.ts';
const policy={methods:['getMe','sendMessage','forwardMessage'],chat_ids:['-123','-456']};
const env=p=>({TELEGRAM_VAULT_BOT_SCOPES_JSON:JSON.stringify({reports:p})});
test('vault scopes default deny while existing static bot controls remain unchanged',()=>{
 assert.throws(()=>assertVaultBotScope('reports','getMe',{},{}));
 assert.doesNotThrow(()=>assertVaultBotScope('default','sendMessage',{chat_id:987},{TELEGRAM_BOT_TOKEN:'synthetic'}));
 assert.doesNotThrow(()=>assertVaultBotScope('reports','getMe',{},env(policy)));
 for(const p of [{...policy,methods:['callAnything']},{...policy,chat_ids:['@mutable']},{...policy,owner:'other'},null])assert.throws(()=>assertVaultBotScope('reports','getMe',{},env(p)));
});
test('both forward targets and cross-chat replies must be in the exact numeric scope',()=>{
 const e=env(policy);assert.doesNotThrow(()=>assertVaultBotScope('reports','sendMessage',{chat_id:-123},e));
 assert.doesNotThrow(()=>assertVaultBotScope('reports','forwardMessage',{chat_id:-123,from_chat_id:'-456'},e));
 for(const [m,p] of [['sendMessage',{chat_id:'-999'}],['sendMessage',{chat_id:'-0123'}],['sendMessage',{chat_id:'@name'}],['forwardMessage',{chat_id:-123,from_chat_id:-999}],['sendMessage',{chat_id:-123,reply_parameters:{chat_id:-999}}],['sendMessage',{chat_id:-123,business_connection_id:'x'}],['sendMessage',{chat_id:-123,inline_message_id:'x'}],['sendMessage',{chat_id:-123,sender_chat_id:-456}],['deleteMessage',{chat_id:-123,message_id:1}]])assert.throws(()=>assertVaultBotScope('reports',m,p,e));
});

test('command reads check all seven scope selectors and never cross approved chats',()=>{
 const e=env({methods:['getMyCommands'],chat_ids:['-123']});
 const call=p=>assertVaultBotScope('reports','getMyCommands',p,e);
 assert.doesNotThrow(()=>call({}));
 for(const type of ['default','all_private_chats','all_group_chats','all_chat_administrators'])assert.doesNotThrow(()=>call({scope:{type},language_code:'en'}));
 for(const type of ['chat','chat_administrators','chat_member'])assert.doesNotThrow(()=>call({scope:{type,chat_id:'-123',...(type==='chat_member'?{user_id:456}:{})}}));
 for(const scope of [null,[],JSON.stringify({type:'chat',chat_id:'-123'}),{type:'chat',chat_id:'-999'},{type:'chat',chat_id:'@mutable'},{type:'chat'},{type:'chat_member',chat_id:'-123'},{type:'chat_member',chat_id:'-123',user_id:-4},{type:'default',chat_id:'-123'},{type:'unknown'},{type:'chat',chat_id:'-123',user_id:4}])assert.throws(()=>call({scope}));
 assert.throws(()=>call({scope:{type:'default'},chat_id:'-123'}));
 assert.throws(()=>call({business_connection_id:'x'}));
 assert.throws(()=>call({language_code:'arbitrary'}));
 assert.throws(()=>assertVaultBotScope('reports','getMyCommands',{},env(policy)));
});
test('menu reads allow default or an exact approved private chat only',()=>{
 const e=env({methods:['getChatMenuButton'],chat_ids:['123','-456']});
 assert.doesNotThrow(()=>assertVaultBotScope('reports','getChatMenuButton',{},e));
 assert.doesNotThrow(()=>assertVaultBotScope('reports','getChatMenuButton',{chat_id:123},e));
 for(const p of [{chat_id:789},{chat_id:-456},{chat_id:0},{chat_id:null},{chat_id:'@mutable'},{chat_id:'0123'},{chat_id:123,scope:{}},{business_connection_id:'x'}])assert.throws(()=>assertVaultBotScope('reports','getChatMenuButton',p,e));
 assert.throws(()=>assertVaultBotScope('reports','setChatMenuButton',{chat_id:123},e));
 assert.throws(()=>assertVaultBotScope('reports','setMyCommands',{commands:[]},e));
});

test('invite methods require individually approved method and numeric destination',()=>{
 for(const method of ['createChatInviteLink','editChatInviteLink','revokeChatInviteLink']){
  const e=env({methods:[method],chat_ids:['-123']});
  assert.doesNotThrow(()=>assertVaultBotScope('reports',method,{chat_id:-123},e));
  for(const p of [{chat_id:-456},{chat_id:'@mutable'},{chat_id:-123,from_chat_id:-123},{chat_id:-123,business_connection_id:'x'}])assert.throws(()=>assertVaultBotScope('reports',method,p,e));
  assert.throws(()=>assertVaultBotScope('reports',method,{chat_id:-123},env(policy)));
 }
});

test('forum permissions are individual; destructive operations are never implied',()=>{
 const methods=['createForumTopic', 'editForumTopic', 'closeForumTopic', 'reopenForumTopic', 'deleteForumTopic', 'unpinAllForumTopicMessages', 'editGeneralForumTopic', 'closeGeneralForumTopic', 'reopenGeneralForumTopic', 'hideGeneralForumTopic', 'unhideGeneralForumTopic', 'unpinAllGeneralForumTopicMessages'];
 for(const method of methods){
  const e=env({methods:[method],chat_ids:['-123']});
  assert.doesNotThrow(()=>assertVaultBotScope('reports',method,{chat_id:-123,message_thread_id:8},e));
  for(const p of [{chat_id:-456},{chat_id:'@mutable'},{chat_id:-123,from_chat_id:-123},{chat_id:-123,business_connection_id:'x'},{chat_id:-123,inline_message_id:'x'}])assert.throws(()=>assertVaultBotScope('reports',method,p,e));
  for(const other of methods.filter(m=>m!==method))assert.throws(()=>assertVaultBotScope('reports',other,{chat_id:-123,message_thread_id:8},e));
 }
});

test('moderation scope requires exact destination and user; unban cannot kick ordinary members',()=>{
 for(const method of ['banChatMember','unbanChatMember']){
  const e=env({methods:[method],chat_ids:['-123']});const valid={chat_id:-123,user_id:123,...(method==='unbanChatMember'?{only_if_banned:true}:{})};
  assert.doesNotThrow(()=>assertVaultBotScope('reports',method,valid,e));
  for(const patch of [{chat_id:-456},{user_id:0},{user_id:'@name'},{business_connection_id:'x'},{user_id:undefined}])assert.throws(()=>assertVaultBotScope('reports',method,{...valid,...patch},e));
  assert.throws(()=>assertVaultBotScope('reports',method,valid,env(policy)));
 }
 const e=env({methods:['unbanChatMember'],chat_ids:['-123']});
 for(const only_if_banned of [false,undefined,'true'])assert.throws(()=>assertVaultBotScope('reports','unbanChatMember',{chat_id:-123,user_id:123,only_if_banned},e));
});

test('restriction scope requires complete independent permissions and explicit expiry',async()=>{
 const {memberPermissionFields}=await import('../lib/telegram/vault/bot-scope.ts');
 const e=env({methods:['restrictChatMember'],chat_ids:['-123']});
 const valid={chat_id:-123,user_id:123,permissions:Object.fromEntries(memberPermissionFields.map(k=>[k,false])),use_independent_chat_permissions:true,until_date:0};
 assert.doesNotThrow(()=>assertVaultBotScope('reports','restrictChatMember',valid,e));
 for(const patch of [{chat_id:-456},{user_id:0},{use_independent_chat_permissions:false},{permissions:{}},{permissions:{...valid.permissions,can_promote_members:true}},{until_date:undefined}])assert.throws(()=>assertVaultBotScope('reports','restrictChatMember',{...valid,...patch},e));
});


test('profile writes require exact individual permission, explicit content and bounded fields',()=>{
 const entries=[['setMyName','name',64],['setMyDescription','description',512],['setMyShortDescription','short_description',120]];
 for(const [method,field,limit] of entries){
  const e=env({methods:[method],chat_ids:[]});
  const call=params=>assertVaultBotScope('reports',method,params,e);
  for(const value of ['', '中文', '😀'.repeat(limit)])assert.doesNotThrow(()=>call({[field]:value,language_code:'zh'}));
  assert.doesNotThrow(()=>call({[field]:'new'}));
  for(const params of [{},{[field]:null},{[field]:5},{[field]:'x'.repeat(limit+1)},{[field]:'😀'.repeat(limit+1)},{[field]:'x',language_code:'zh-CN'},{[field]:'x',chat_id:-123},{[field]:'x',business_connection_id:'other'},{[field]:'x',inline_message_id:'other'},{[field]:'x',other:'content'}])assert.throws(()=>call(params));
  for(const [other,otherField] of entries.filter(([m])=>m!==method))assert.throws(()=>assertVaultBotScope('reports',other,{[otherField]:'x'},e));
  assert.throws(()=>assertVaultBotScope('reports',method,{[field]:'x'},env(policy)));
 }
});


test('command writes retain all scope boundaries and reject nested target injection',()=>{
 for(const method of ['setMyCommands','deleteMyCommands']){
  const e=env({methods:[method],chat_ids:['-123']});
  const base=method==='setMyCommands'?{commands:[{command:'hello',description:'Hello',is_ephemeral:true}]}:{};
  const call=p=>assertVaultBotScope('reports',method,{...base,...p},e);
  for(const type of ['default','all_private_chats','all_group_chats','all_chat_administrators'])assert.doesNotThrow(()=>call({scope:{type},language_code:'en'}));
  for(const type of ['chat','chat_administrators','chat_member'])assert.doesNotThrow(()=>call({scope:{type,chat_id:'-123',...(type==='chat_member'?{user_id:123}:{})}}));
  for(const scope of [{type:'chat',chat_id:-999},{type:'default',chat_id:-123},{type:'chat_member',chat_id:-123},{type:'chat_member',chat_id:-123,user_id:-1},{type:'chat',chat_id:-123,business_connection_id:'x'}])assert.throws(()=>call({scope}));
  for(const extra of [{chat_id:-123},{inline_message_id:'x'},{business_connection_id:'x'},{language_code:'zh-CN'}])assert.throws(()=>call(extra));
  assert.throws(()=>assertVaultBotScope('reports',method,base,env({methods:['getMyCommands'],chat_ids:['-123']})));
  const other=method==='setMyCommands'?'deleteMyCommands':'setMyCommands';assert.throws(()=>assertVaultBotScope('reports',other,{commands:[]},e));
 }
});
test('command replacement validates full bounded unique payload before accepting policy',()=>{
 const e=env({methods:['setMyCommands'],chat_ids:[]});
 const call=commands=>assertVaultBotScope('reports','setMyCommands',{commands},e);
 assert.doesNotThrow(()=>call([]));assert.doesNotThrow(()=>call([{command:'a',description:'😀'.repeat(256)}]));
 for(const commands of [undefined,null,'[]',Array.from({length:101},(_,i)=>({command:'c'+i,description:'d'})),[{command:'a',description:'d'},{command:'a',description:'e'}],[{command:'/a',description:'d'}],[{command:'a',description:''}],[{command:'a',description:'😀'.repeat(257)}],[{command:'a',description:'d',is_ephemeral:'true'}],[{command:'a',description:'d',chat_id:123}],[null]])assert.throws(()=>call(commands));
});


test('menu writes require individual grant, explicit button and approved private destination',()=>{
 const e=env({methods:['setChatMenuButton'],chat_ids:['123','-456']});
 const call=p=>assertVaultBotScope('reports','setChatMenuButton',p,e);
 for(const menu_button of [{type:'default'},{type:'commands'},{type:'web_app',text:'Open',web_app:{url:'https://example.test/app'}}]){
  assert.doesNotThrow(()=>call({menu_button}));assert.doesNotThrow(()=>call({menu_button,chat_id:123}));
  for(const chat_id of [-456,789,'@name',0,null])assert.throws(()=>call({menu_button,chat_id}));
 }
 for(const menu_button of [undefined,{},[],{type:'commands',text:'hidden'},{type:'web_app',text:'Open',web_app:{url:'http://example.test'}},{type:'web_app',text:'Open',web_app:{url:'https://user:pass@example.test'}},{type:'web_app',text:'Open',web_app:{url:'https://example.test',chat_id:123}},{type:'web_app',text:'',web_app:{url:'https://example.test'}},{type:'web_app',text:'x'.repeat(129),web_app:{url:'https://example.test'}}])assert.throws(()=>call({menu_button}));
 assert.throws(()=>call({menu_button:{type:'default'},business_connection_id:'x'}));
 assert.throws(()=>assertVaultBotScope('reports','setChatMenuButton',{menu_button:{type:'default'}},env({methods:['getChatMenuButton'],chat_ids:[]})));
});
