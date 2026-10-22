import test from 'node:test';import assert from 'node:assert/strict';import {callRichBotApi} from '../lib/telegram/bot-api.ts';
test('draft numeric private IDs match exact media scope before real transport',async t=>{
 const old={...process.env},fetch=globalThis.fetch;t.after(()=>{globalThis.fetch=fetch;for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old)});
 Object.assign(process.env,{TELEGRAM_BOT_TOKEN:'synthetic-token',TELEGRAM_RICH_MESSAGES_ENABLED:'true',TELEGRAM_MEDIA_BYTES_ENABLED:'true',TELEGRAM_MEDIA_ALLOWED_DESTINATIONS_JSON:'[{"botAlias":"default","chatId":"123"}]'});delete process.env.TELEGRAM_BOTS_JSON;let calls=0;
 globalThis.fetch=async(url,options)=>{calls++;assert.ok(url.endsWith('/sendRichMessageDraft'));assert.equal(JSON.parse(options.body).chat_id,123);return Response.json({ok:true,result:true})};
 assert.equal((await callRichBotApi('default','sendRichMessageDraft',{chat_id:123,draft_id:1,rich_message:{html:'<p>test</p>'}},[])).result,true);
 for(const chat_id of [124,-123,1.5,Number.MAX_SAFE_INTEGER+1])await assert.rejects(callRichBotApi('default','sendRichMessageDraft',{chat_id},[]));assert.equal(calls,1);
});
