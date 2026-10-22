import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {manageBotAvatar} from '../lib/telegram/bot-avatar.ts';import {buildAvatarMultipart,MAX_AVATAR_BYTES} from '../lib/telegram/avatar-bytes.ts';
import {callBotAvatarBytes} from '../lib/telegram/bot-api.ts';
const from=(bytes,kind='static')=>({kind,base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')});
const jpg=from(Buffer.from([255,216,255,0,255,217]));
function setup(){
 const env={TELEGRAM_BOT_TOKEN:'123:synthetic',TELEGRAM_AVATAR_WRITE_ENABLED:'true',TELEGRAM_AVATAR_BOTS_JSON:'["default"]'},calls=[];let photo='old',failure=false;
 const call=async(alias,method,params)=>{calls.push({method,params});if(method==='getMe')return {bot:alias,result:{id:123,is_bot:true}};if(method==='getUserProfilePhotos'){if(failure)throw Error('private upstream error');return {bot:alias,result:{total_count:photo?1:0,photos:photo?[[{file_unique_id:photo,file_id:'private_file',width:100,height:100}]]:[]}}}if(method==='removeMyProfilePhoto'){photo='';return {bot:alias,result:true}}throw Error('unexpected')};
 const upload=async(alias)=>{calls.push({method:'setMyProfilePhoto'});photo='new';return {bot:alias,result:true}};
 const options={env:()=>env,call,upload};
 return {env,calls,options,change:v=>{photo=v},failRead:()=>{failure=true},review:()=>manageBotAvatar({action:'inspect',bot_alias:'default'},options)};
}
const request=(review,extra={})=>({action:'set',bot_alias:'default',expected_bot_id:review.bot_id,expected_avatar_fingerprint:review.fingerprint,confirm:true,upload:jpg,...extra});
test('avatar supports fresh JPEG and MPEG4 multipart, enforces digest, size and format',()=>{
 const a=buildAvatarMultipart(jpg);assert.deepEqual(JSON.parse(a.body.get('photo')),{type:'static',photo:'attach://avatar_file'});assert.equal(a.body.get('avatar_file').type,'image/jpeg');
 const mp4=Buffer.alloc(16);mp4.write('ftyp',4);const b=buildAvatarMultipart({...from(mp4,'animated'),main_frame_timestamp:0.5});assert.equal(JSON.parse(b.body.get('photo')).main_frame_timestamp,0.5);
 for(const v of [{...jpg,sha256:'0'.repeat(64)},{...jpg,main_frame_timestamp:0},{...jpg,base64:'https://example.com'},{...jpg,unknown:true},from(Buffer.from('not jpeg')),from(Buffer.alloc(MAX_AVATAR_BYTES+1))])assert.throws(()=>buildAvatarMultipart(v));
});
test('review projects only Bot identity and fingerprint; set acknowledges without pretending byte readback',async()=>{
 const s=setup(),review=await s.review();assert.equal(review.bot_id,'123');assert.equal(JSON.stringify(review).includes('private_file'),false);
 const r=await manageBotAvatar(request(review),s.options);assert.equal(r.acknowledged,true);assert.equal(r.observed_change,true);assert.equal(r.uploaded_content_verified,false);assert.equal(s.calls.filter(x=>x.method==='setMyProfilePhoto').length,1);
});
test('wrong Bot, stale avatar, absent confirmation and disabled flags never write',async()=>{
 const s=setup(),review=await s.review();await assert.rejects(manageBotAvatar(request(review,{expected_bot_id:'999'}),s.options),/identity changed/);
 s.change('different');assert.equal((await manageBotAvatar(request(review),s.options)).status,'avatar_changed_since_review');
 await assert.rejects(manageBotAvatar(request(review,{confirm:false}),s.options));s.env.TELEGRAM_AVATAR_WRITE_ENABLED='false';await assert.rejects(manageBotAvatar(request(review),s.options),/disabled/);
 assert.equal(s.calls.filter(x=>x.method==='setMyProfilePhoto').length,0);
});
test('remove checks observed emptiness and avoids a second write',async()=>{
 const s=setup(),review=await s.review(),args=request(review,{action:'remove'});delete args.upload;
 const r=await manageBotAvatar(args,s.options);assert.equal(r.removal_verified,true);
 const empty=await s.review();assert.equal((await manageBotAvatar({...args,expected_avatar_fingerprint:empty.fingerprint},s.options)).status,'already_empty');assert.equal(s.calls.filter(x=>x.method==='removeMyProfilePhoto').length,1);
});
test('unknown write result is not retried; acknowledged write plus failed readback stays distinct',async()=>{
 const s=setup(),review=await s.review();let uploads=0;
 const unknown=await manageBotAvatar(request(review),{...s.options,upload:async()=>{uploads++;throw Error('secret upstream')}});assert.equal(unknown.changed,null);assert.equal(unknown.retry_automatically,false);assert.equal(uploads,1);assert.equal(JSON.stringify(unknown).includes('secret'),false);
 const r=await manageBotAvatar(request(review),{...s.options,upload:async()=>{s.failRead();return {bot:'default',result:true}}});assert.equal(r.acknowledged,true);assert.equal(r.status,'readback_unavailable');
});
test('scope or Bot token changes during preflight prevent mutation',async()=>{
 const s=setup(),review=await s.review();const original=s.options.call;
 await assert.rejects(manageBotAvatar(request(review),{...s.options,call:async(...args)=>{const r=await original(...args);if(args[1]==='getUserProfilePhotos')s.env.TELEGRAM_BOT_TOKEN='rotated';return r}}),/scope changed/);
 assert.equal(s.calls.filter(x=>x.method==='setMyProfilePhoto').length,0);
});
test('avatar transport uses multipart only at Telegram and respects write scope/cancellation',async t=>{
 const keys=['TELEGRAM_BOT_TOKEN','TELEGRAM_BOTS_JSON','TELEGRAM_AVATAR_WRITE_ENABLED','TELEGRAM_AVATAR_BOTS_JSON'];const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]])),oldFetch=globalThis.fetch;
 t.after(()=>{globalThis.fetch=oldFetch;for(const k of keys){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k]}});
 delete process.env.TELEGRAM_BOTS_JSON;Object.assign(process.env,{TELEGRAM_BOT_TOKEN:'123:synthetic',TELEGRAM_AVATAR_WRITE_ENABLED:'true',TELEGRAM_AVATAR_BOTS_JSON:'["default"]'});
 let count=0;globalThis.fetch=async(url,init)=>{count++;assert.equal(new URL(url).hostname,'api.telegram.org');assert.ok(url.endsWith('/setMyProfilePhoto'));assert.ok(init.body instanceof FormData);assert.equal(init.body.has('chat_id'),false);return Response.json({ok:true,result:true})};
 assert.equal((await callBotAvatarBytes('default',jpg,{expectedBotId:'123'})).result,true);assert.equal(count,1);
 const ac=new AbortController();ac.abort();await assert.rejects(callBotAvatarBytes('default',jpg,{signal:ac.signal,expectedBotId:'123'}));assert.equal(count,1);
 process.env.TELEGRAM_AVATAR_WRITE_ENABLED='false';await assert.rejects(callBotAvatarBytes('default',jpg,{expectedBotId:'123'}));assert.equal(count,1);
});
