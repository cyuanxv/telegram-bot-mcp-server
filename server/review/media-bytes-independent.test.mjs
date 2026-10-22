import assert from 'node:assert/strict';
import { test, beforeEach, after, mock } from 'node:test';
import { buildMediaMultipart, assertMediaUploadScope, MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_TOTAL_BYTES, MAX_BASE64_LENGTH } from '../lib/telegram/media-bytes.ts';
import { callBotApiBytes, BotApiError, BOT_API_MAX_RESPONSE_BYTES } from '../lib/telegram/bot-api.ts';

// Independent synthetic-only review. All network entry points used here are mocked.
const registered = new Map();
mock.module('mcp-handler', { namedExports: { createMcpHandler(register) {
  register({ registerTool(name, config, callback) { registered.set(name, { config, callback }); } });
  return async () => new Response('synthetic MCP transport');
} } });
const disabledMtproto = async () => { throw new Error('MTProto forbidden during independent review'); };
mock.module('../lib/telegram/mtproto.ts', { namedExports: {
  callMtproto: disabledMtproto, getMtprotoMe: disabledMtproto, listAccounts: () => [], listConfiguredAccounts: async () => [],
  listDialogs: disabledMtproto, searchMtprotoMessages: disabledMtproto, sendMtprotoMessage: disabledMtproto,
} });
await import('../app/api/mcp/route.ts');
const envKeys = ['TELEGRAM_BOTS_JSON', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_CHATS_JSON', 'TELEGRAM_MEDIA_BYTES_ENABLED', 'TELEGRAM_MEDIA_ALLOWED_DESTINATIONS_JSON'];
const savedEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
const savedFetch = globalThis.fetch;
const file = { field_name: 'uploadA', filename: 'a.txt', base64: 'YQ==' };
const params = { chat_id: '-100100', document: 'attach://uploadA' };
let calls = [];
beforeEach(() => {
  for (const k of envKeys) delete process.env[k];
  process.env.TELEGRAM_BOTS_JSON = JSON.stringify({ reports: { token: 'SYNTHETIC_INDEPENDENT_TOKEN' } });
  process.env.TELEGRAM_MEDIA_BYTES_ENABLED = 'true';
  process.env.TELEGRAM_MEDIA_ALLOWED_DESTINATIONS_JSON = JSON.stringify([{ botAlias: 'reports', chatId: params.chat_id }]);
  calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ ok: true, result: { message_id: 42 } }); };
});
after(() => {
  globalThis.fetch = savedFetch;
  for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});
const build = (p = params, f = [file]) => buildMediaMultipart('sendDocument', p, f);
const album = media => ({ chat_id: params.chat_id, media });
async function invoke(args) { const tool = registered.get('send_media_bytes'); return tool.callback(tool.config.inputSchema.parse(args)); }
const args = { bot_alias: 'reports', method: 'sendDocument', chat: params.chat_id, params: { document: params.document }, files: [file] };

// Safety/configuration boundary.
test('independent: only exact enablement and exact bot/chat pairs authorize a fetch', async () => {
  for (const value of [undefined, '', 'TRUE', '1', ' true']) {
    if (value === undefined) delete process.env.TELEGRAM_MEDIA_BYTES_ENABLED; else process.env.TELEGRAM_MEDIA_BYTES_ENABLED = value;
    await assert.rejects(callBotApiBytes('reports', 'sendDocument', params, [file]), /disabled/);
  }
  process.env.TELEGRAM_MEDIA_BYTES_ENABLED = 'true';
  for (const pair of [[undefined, params.chat_id], ['', params.chat_id], ['reports', -100100], ['REPORTS', params.chat_id], ['reports', '-100101']]) {
    assert.throws(() => assertMediaUploadScope(...pair));
  }
  assert.equal(calls.length, 0);
});
test('independent: malformed or extra-key policies fail closed', () => {
  for (const policy of ['not-json', 'null', '{}', '[]', '[null]', '[[]]', JSON.stringify([{botAlias:'reports', chatId:-100100}]), JSON.stringify([{botAlias:'reports',chatId:params.chat_id, extra:true}]), JSON.stringify(Array(101).fill({botAlias:'reports',chatId:params.chat_id}))]) {
    process.env.TELEGRAM_MEDIA_ALLOWED_DESTINATIONS_JSON = policy;
    assert.throws(() => assertMediaUploadScope('reports', params.chat_id));
  }
});
test('independent: invalid methods and business identity never reach fetch', async () => {
  for (const method of ['sendMessage','sendPaidMedia','getManagedBotToken','replaceManagedBotToken','sendDocument/..','senddocument']) {
    await assert.rejects(callBotApiBytes('reports', method, params, [file]));
  }
  for (const business_connection_id of ['', null, false, 'synthetic-other-identity']) {
    await assert.rejects(callBotApiBytes('reports','sendDocument',{...params,business_connection_id},[file]));
  }
  assert.equal(calls.length, 0);
});
test('independent: chat IDs are exact canonical signed nonzero 64-bit strings', () => {
  for (const chat_id of ['-9223372036854775808','9223372036854775807']) assert.equal(build({...params,chat_id}).body.get('chat_id'),chat_id);
  for (const chat_id of ['-9223372036854775809','9223372036854775808','00','0','-0','001','+1','1e3',' 123','123\n','@channel',100100,null]) assert.throws(() => build({...params,chat_id}));
});

// Canonical encoding/resource budgets.
test('independent: exhaustive one-byte encodings accept canonical pad bits only', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < 256; i++) {
    const base64 = Buffer.from([i]).toString('base64');
    assert.equal(build(params,[{...file,base64}]).totalBytes,1);
    const bad = base64[0] + alphabet[alphabet.indexOf(base64[1]) | 1] + '==';
    assert.throws(() => build(params,[{...file,base64:bad}]));
  }
});
test('independent: noncanonical alphabet, padding and whitespace are rejected', () => {
  for (const base64 of ['YQ','YQ=','YQ===','Y Q==','YQ==\t','YQ==\r\n','YQ==\0','YQ＝＝','_w==','-w==','AB==','AAB=','AAAA====','AAAA=AAA']) assert.throws(() => build(params,[{...file,base64}]));
});
test('independent: exact 16 MiB aggregate accepted and one additional byte rejected', () => {
  const base64 = Buffer.alloc(MAX_UPLOAD_FILE_BYTES, 0x41).toString('base64');
  assert.equal(base64.length, MAX_BASE64_LENGTH);
  const files = [{...file,base64},{...file,field_name:'uploadB',base64}];
  const media = files.map(f => ({type:'document',media:`attach://${f.field_name}`}));
  assert.equal(buildMediaMultipart('sendMediaGroup',album(media),files).totalBytes,MAX_UPLOAD_TOTAL_BYTES);
  assert.throws(() => buildMediaMultipart('sendMediaGroup',album([...media,{type:'document',media:'attach://uploadC'}]),[...files,{...file,field_name:'uploadC'}]),/budget|16 MiB/);
});
test('independent: count, node, depth, encoded-size and JSON-value budgets', () => {
  assert.throws(() => build(params,[]));
  assert.throws(() => build(params,Array(5).fill(file)));
  let nested = null; for (let i=0;i<13;i++) nested={n:nested};
  const cyclic = {}; cyclic.n=cyclic;
  for (const extra of [{x:Array(2049).fill(null)},{x:nested},{x:cyclic},{caption:'\0'.repeat(12000)},{caption:'🙂'.repeat(17000)},{x:Infinity},{x:NaN},{x:undefined},{x:new Date()},{x:1n}]) assert.throws(() => build({...params,...extra}));
});

// Multipart and semantic reference boundaries.
test('independent: field names cannot override top-level parameters or multiply parts', () => {
  for (const field_name of ['chat_id','document','method','business_connection_id','__proto__','a\r\nx','a/b','a"','1a']) {
    assert.throws(() => build({...params,document:`attach://${field_name}`},[{...file,field_name}]));
  }
  assert.throws(() => build(params,[file,{...file}]));
});
test('independent: header/path/control filenames and malformed MIME are rejected', () => {
  for (const filename of ['.', '..', 'a/b', 'a\\b', 'a\0b', 'a\r\nb', 'a\u007fb', 'a\u202eb', 'a\u2067b', '\udfff', ' '.repeat(5), 'x'.repeat(129)]) assert.throws(() => build(params,[{...file,filename}]));
  for (const content_type of ['text/plain; charset=utf-8','text/plain\r\nInjected: yes',' text/plain','text/','/plain','text\\plain']) assert.throws(() => build(params,[{...file,content_type}]));
});
test('independent: filename quotes are escaped by multipart encoding without new fields', async () => {
  const {body} = build(params,[{...file,filename:'a"; name="chat_id.txt'}]);
  const encoded = await new Request('https://synthetic.invalid/',{method:'POST',body}).text();
  assert.match(encoded,/filename="a%22; name=%22chat_id\.txt"/);
  assert.equal([...body.keys()].filter(k=>k==='chat_id').length,1);
});
test('independent: references from ignored nested media-like fields cannot authorize unused uploads', () => {
  assert.throws(() => build({...params,dummy:{thumbnail:'attach://uploadB'}},[file,{...file,field_name:'uploadB'}]));
});
test('independent: album references from ignored top-level fields cannot authorize unused uploads', () => {
  const p={...album([{type:'document',media:'existing-id-1'},{type:'document',media:'existing-id-2'}]),document:'attach://uploadA'};
  assert.throws(() => buildMediaMultipart('sendMediaGroup',p,[file]));
});
test('independent: references outside media fields are ordinary text, not file usage', () => {
  assert.throws(() => build({...params,caption:'attach://uploadB'},[file,{...file,field_name:'uploadB'}]));
  assert.equal(build({...params,caption:'attach://not_a_file'}).body.get('caption'),'attach://not_a_file');
});

// Registered MCP entry point and shared outbound boundary.
test('independent: MCP resolves alias and explicit chat overrides params.chat_id', async () => {
  process.env.TELEGRAM_CHATS_JSON=JSON.stringify({approved:params.chat_id});
  const response=await invoke({...args,chat:'approved',params:{...args.params,chat_id:'-100999'}});
  assert.equal(response.isError,undefined); assert.equal(calls.length,1);
  assert.equal(calls[0].init.body.get('chat_id'),params.chat_id);
});
test('independent: MCP cannot use defaults, coercion, extra files fields or scope escapes', async () => {
  for (const change of [{chat:100100},{chat:''},{bot_alias:''},{bot_alias:undefined},{chat:undefined},{files:[{...file,url:'https://synthetic.invalid/file'}]},{extra:true}]) await assert.rejects(invoke({...args,...change}));
  const wrong=await invoke({...args,chat:'-100999'}); assert.equal(wrong.isError,true);
  assert.equal(calls.length,0);
});
test('independent: multipart dispatch keeps endpoint, signal, no redirects and one attempt', async () => {
  await callBotApiBytes('reports','sendDocument',params,[file]);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://api.telegram.org/botSYNTHETIC_INDEPENDENT_TOKEN/sendDocument');
  assert.equal(calls[0].init.redirect,'error'); assert.equal(calls[0].init.method,'POST'); assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.ok(calls[0].init.body instanceof FormData); assert.equal(calls[0].init.headers['content-type'],undefined);
});
test('independent: multipart 2 MiB response budget is enforced and stream cancelled', async () => {
  let cancelled=false;
  globalThis.fetch=async()=>{calls.push({});return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(BOT_API_MAX_RESPONSE_BYTES+1));},cancel(){cancelled=true;}}));};
  await assert.rejects(callBotApiBytes('reports','sendDocument',params,[file]),e=>e instanceof BotApiError&&e.details.code==='response_too_large'&&e.details.delivery_unknown===true);
  assert.equal(calls.length,1); assert.equal(cancelled,true);
});
test('independent: multipart hanging fetch reaches same absolute 30-second deadline', async t => {
  t.mock.timers.enable({apis:['setTimeout']}); let signal, started;
  const ready = new Promise(resolve => started = resolve);
  globalThis.fetch=async(_url,init)=>{calls.push({});signal=init.signal;started();return new Promise(()=>{});};
  const pending=assert.rejects(callBotApiBytes('reports','sendDocument',params,[file]),e=>e instanceof BotApiError&&e.details.code==='timeout'&&e.details.delivery_unknown&&e.details.automatic_retry_performed===false);
  await ready; t.mock.timers.tick(30000); await pending; assert.equal(signal.aborted,true); assert.equal(calls.length,1);
});
test('independent: upstream and fetch errors are sanitized without automatic retry', async () => {
  for (const response of [{status:400,data:{ok:false,error_code:400,description:'SYNTHETIC_SECRET'}},{status:429,data:{ok:false,error_code:429,description:'SYNTHETIC_SECRET',parameters:{retry_after:3}}},{status:502,data:{ok:false,error_code:502,description:'SYNTHETIC_SECRET'}},{status:200,data:{ok:true}},{status:200,data:{ok:false,error_code:400}}]) {
    globalThis.fetch=async()=>{calls.push({});return Response.json(response.data,{status:response.status});};
    const result=await invoke(args); assert.equal(result.isError,true); assert.equal(result.structuredContent.error.automatic_retry_performed,false); assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET'));
    assert.equal(result.structuredContent.error.delivery_unknown,response.status>=500||response.status===200);
  }
  globalThis.fetch=async()=>{calls.push({});throw new Error('SYNTHETIC_SECRET');};
  const result=await invoke(args); assert.equal(result.structuredContent.error.code,'network_error'); assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET')); assert.equal(calls.length,6);
});

test('independent: every allowlisted single-media method requires its real primary field', () => {
  for (const [method,key] of Object.entries({sendPhoto:'photo',sendAudio:'audio',sendDocument:'document',sendVideo:'video',sendAnimation:'animation',sendVoice:'voice',sendVideoNote:'video_note',sendSticker:'sticker'})) {
    assert.equal(buildMediaMultipart(method,{chat_id:params.chat_id,[key]:'attach://uploadA'},[file]).fileCount,1);
    for (const value of ['file_id_only','https://synthetic.invalid/a','file:///synthetic/a','data:text/plain;base64,YQ==',' attach://uploadA','attach://uploadA\n']) {
      assert.throws(() => buildMediaMultipart(method,{chat_id:params.chat_id,[key]:value},[file]));
    }
  }
});
test('independent: secondary file references are accepted only at supported method positions', () => {
  const b={...file,field_name:'uploadB'}, c={...file,field_name:'uploadC'};
  const p={chat_id:params.chat_id,video:'attach://uploadA',thumbnail:'attach://uploadB',cover:'attach://uploadC'};
  assert.equal(buildMediaMultipart('sendVideo',p,[file,b,c]).fileCount,3);
  assert.throws(() => buildMediaMultipart('sendPhoto',{chat_id:params.chat_id,photo:'attach://uploadA',thumbnail:'attach://uploadB'},[file,b]));
  assert.throws(() => buildMediaMultipart('sendAudio',{chat_id:params.chat_id,audio:'attach://uploadA',cover:'attach://uploadB'},[file,b]));
  assert.throws(() => buildMediaMultipart('sendVideo',{...p,thumbnail:'existing_thumbnail_id'},[file,c]));
});
test('independent: album primary fields always need bytes and secondary positions respect item type', () => {
  const b={...file,field_name:'uploadB'}, c={...file,field_name:'uploadC'};
  const media=[{type:'photo',media:'attach://uploadA'},{type:'video',media:'attach://uploadB',cover:'attach://uploadC'}];
  assert.equal(buildMediaMultipart('sendMediaGroup',album(media),[file,b,c]).fileCount,3);
  assert.throws(() => buildMediaMultipart('sendMediaGroup',album([{...media[0]},{type:'video',media:'existing_file_id'}]),[file]));
  assert.throws(() => buildMediaMultipart('sendMediaGroup',album([{...media[0],thumbnail:'attach://uploadC'},{type:'video',media:'attach://uploadB'}]),[file,b,c]));
  assert.throws(() => buildMediaMultipart('sendMediaGroup',album(Array(11).fill(media[0])),[file]));
  assert.throws(() => buildMediaMultipart('sendMediaGroup',album([{type:'audio',media:'attach://uploadA'},{type:'document',media:'attach://uploadB'}]),[file,b]));
});
test('independent: unsafe integer identifiers are rejected before serialization', () => {
  for (const extra of [{message_thread_id:Number.MAX_SAFE_INTEGER+1},{reply_parameters:{message_id:Number.MAX_SAFE_INTEGER+1}},{message_effect_id:1e30}]) assert.throws(() => build({...params,...extra}),/Unsafe numeric/);
});
