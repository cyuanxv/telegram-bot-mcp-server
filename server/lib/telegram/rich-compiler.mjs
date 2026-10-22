// Portable phase-two structured compiler. No network, arbitrary HTML or raw Bot API parameters.
const bad=(why)=>{throw Error(`Rich message: ${why}`)};
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function obj(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))bad('unsupported fields');}
function str(v,max=12000){if(typeof v!=='string'||!v.isWellFormed()||[...v].length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v))bad('invalid text');return v;}
function https(v){str(v,2048);let u;try{u=new URL(v)}catch{bad('invalid HTTPS URL')};if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||!u.hostname.includes('.')||/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u.hostname)||u.hostname.includes(':')||/\.(local|localhost|internal)$/i.test(u.hostname))bad('public HTTPS URL required');return u.href;}
const enumOf=(v,values)=>{if(!values.includes(v))bad('unsupported value');return v};
const bool=(v)=>{if(v!==undefined&&typeof v!=='boolean')bad('boolean expected');return v};
export function compileRich(input){
 obj(input,['blocks','files']);if(!Array.isArray(input.blocks)||input.blocks.length<1||input.blocks.length>100)bad('provide 1 to 100 blocks');
 let blockCount=input.blocks.length;let chars=0,nodes=0,images=0,mediaCount=0,buttons=0;const refs=new Set(),refTypes=new Map(),media=[];
 const text=v=>{const s=str(v);chars += [...s].length;if(chars>12000)bad('content exceeds 12000 characters');return esc(s)};
 const button=b=>{
  obj(b,['text','url','copy_text','action','style']);
  if(++buttons>24)bad('maximum 24 buttons');str(b.text,64);if(!b.text.trim())bad('empty button label');
  const actions=['url','copy_text','action'].filter(k=>b[k]!==undefined);if(actions.length!==1)bad('exactly one button action required');
  let attrs;if(b.url!==undefined)attrs=`type="url" url="${esc(https(b.url))}"`;
  else if(b.copy_text!==undefined){str(b.copy_text,256);if(!b.copy_text.length)bad('empty copy text');attrs=`type="copy_text" text="${esc(b.copy_text)}"`}
  else {enumOf(b.action,['ack','stop']);attrs=`type="callback_data" data="rich-action:${b.action}"`}
  if(b.style!==undefined){enumOf(b.style,['primary','success','danger','link']);if(b.style==='link'&&!b.action)bad('link style requires callback');attrs+=` style="${b.style}"`}
  return `<tg-button ${attrs}>${text(b.text)}</tg-button>`;
 };
 const inline=v=>{
  if(++nodes>2000)bad('content node limit');if(typeof v==='string')return text(v).replaceAll('\n','<br>');
  if(!Array.isArray(v)||!v.length||v.length>100)bad('inline text or spans required');
  return v.map(s=>{if(++nodes>2000)bad('content node limit');obj(s,['text','math','bold','italic','underline','strike','code','href','button']);if(s.button!==undefined){if(Object.keys(s).length!==1)bad('button span must contain only button');return button(s.button)}if(s.math!==undefined){if(Object.keys(s).length!==1||!str(s.math).trim())bad('math span must contain only math');return `<tg-math>${text(s.math)}</tg-math>`}
   let out=text(s.text).replaceAll('\n','<br>');for(const [key,tag]of [['bold','b'],['italic','i'],['underline','u'],['strike','s'],['code','code']])if(bool(s[key]))out=`<${tag}>${out}</${tag}>`;if(s.href!==undefined)out=`<a href="${esc(https(s.href))}">${out}</a>`;return out}).join('');
 };
 const html=input.blocks.map(b=>{
  if(!b||typeof b.type!=='string')bad('block type required');
  switch(b.type){
   case 'heading':obj(b,['type','level','text']);enumOf(b.level,[1,2,3]);return `<h${b.level}>${inline(b.text)}</h${b.level}>`;
   case 'paragraph':obj(b,['type','text']);return `<p>${inline(b.text)}</p>`;
   case 'quote':obj(b,['type','text']);return `<blockquote>${inline(b.text)}</blockquote>`;
   case 'code':obj(b,['type','text','language']);if(b.language!==undefined&&!/^[A-Za-z0-9_+-]{1,32}$/.test(b.language))bad('invalid code language');return `<pre><code${b.language?` class="language-${b.language}"`:''}>${text(b.text)}</code></pre>`;
   case 'list':obj(b,['type','ordered','items']);bool(b.ordered);if(!Array.isArray(b.items)||!b.items.length||b.items.length>100)bad('invalid list');blockCount+=b.items.length;if(blockCount>100)bad('nested blocks exceed 100');return `<${b.ordered?'ol':'ul'}>${b.items.map(i=>`<li>${inline(i)}</li>`).join('')}</${b.ordered?'ol':'ul'}>`;
   case 'math':obj(b,['type','latex']);if(!str(b.latex).trim())bad('empty formula');return `<tg-math-block>${text(b.latex)}</tg-math-block>`;
   case 'table':{
    obj(b,['type','headers','rows','align','bordered','compact','striped','caption']);if(!Array.isArray(b.rows)||!b.rows.length||b.rows.length>20)bad('table requires 1 to 20 rows');const cols=b.rows[0]?.length;if(!Number.isInteger(cols)||cols<1||cols>6||b.rows.some(r=>!Array.isArray(r)||r.length!==cols))bad('table requires 1 to 6 uniform columns');
    if(b.headers!==undefined&&(!Array.isArray(b.headers)||b.headers.length!==cols))bad('header width mismatch');if(b.align!==undefined&&(!Array.isArray(b.align)||b.align.length!==cols))bad('alignment width mismatch');b.align?.forEach(a=>enumOf(a,['left','center','right']));
    const row=(r,tag)=>`<tr>${r.map((c,i)=>`<${tag}${b.align?` align="${b.align[i]}"`:''}>${inline(c)}</${tag}>`).join('')}</tr>`;
    return `<table${['bordered','compact','striped'].filter(k=>bool(b[k])).map(k=>' '+k).join('')}>${b.caption===undefined?'':`<caption>${inline(b.caption)}</caption>`}${b.headers?row(b.headers,'th'):''}${b.rows.map(r=>row(r,'td')).join('')}</table>`;
   }
   case 'buttons':obj(b,['type','buttons','align']);if(!Array.isArray(b.buttons)||!b.buttons.length||b.buttons.length>8)bad('button row requires 1 to 8 buttons');return `<tg-button-row align="${enumOf(b.align??'left',['left','center','right'])}">${b.buttons.map(button).join('')}</tg-button-row>`;
   case 'video':case 'audio':case 'voice':case 'photo':{
    obj(b,['type','url','file','media_ref','caption']);if(++mediaCount>4)bad('maximum 4 media blocks');if(b.type==='photo')images++;
    if(['url','file','media_ref'].filter(k=>b[k]!==undefined).length!==1)bad('media requires exactly one URL, file or registered reference');
    const kind=b.type==='voice'?'voice_note':b.type;let src;
    if(b.type==='photo'&&b.url!==undefined)src=https(b.url);
    else {
     const id=b.file??`media${mediaCount}`;
     if(b.file!==undefined){if(typeof b.file!=='string'||!/^(photo|video|audio|voice)[A-Za-z0-9_]{0,26}$/.test(b.file))bad('invalid file id');if(refTypes.has(id)&&refTypes.get(id)!==kind)bad('conflicting media types');refs.add(id);refTypes.set(id,kind)}
     if(b.media_ref!==undefined&&!(typeof b.media_ref==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(b.media_ref)))bad('invalid registered media reference');
     if(!media.some(m=>m.id===id))media.push({id,media:{type:kind,media:b.url!==undefined?https(b.url):b.media_ref!==undefined?`rich-ref:${b.media_ref}`:`attach://${id}`}});
     src=`tg://${b.type==='voice'?'audio':b.type}?id=${id}`;
    }
    const tag=b.type==='photo'?'img':b.type==='video'?'video':'audio';const element=tag==='img'?`<img src="${esc(src)}"/>`:`<${tag} src="${esc(src)}"></${tag}>`;
    return b.caption===undefined?element:`<figure>${element}<figcaption>${inline(b.caption)}</figcaption></figure>`;
   }
   default:bad('unsupported block type');
  }
 }).join('\n');
 if(!Array.isArray(input.files??[])||(input.files??[]).length>4)bad('maximum 4 files');
 let bytes=0;const seen=new Set();const files=(input.files??[]).map(f=>{
  obj(f,['id','filename','content_type','base64','sha256']);if(!refs.has(f.id)||seen.has(f.id))bad('unreferenced or duplicate file');seen.add(f.id);
  str(f.filename,128);if(!/^[A-Za-z0-9._-]{1,128}$/.test(f.filename)||f.filename==='.'||f.filename==='..')bad('invalid filename');enumOf(f.content_type,['image/jpeg','image/png','image/webp','video/mp4','audio/mpeg','audio/mp4','audio/ogg']);
  if(typeof f.base64!=='string'||f.base64.length>2796204||!f.base64.length||f.base64.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.base64))bad('invalid base64');
  const raw=atob(f.base64);if(btoa(raw)!==f.base64)bad('noncanonical base64');bytes+=raw.length;if(bytes>2*1024*1024)bad('attachments exceed 2 MiB');
  if(typeof f.sha256!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256))bad('SHA256 required');
  const sig=Array.from(raw.slice(0,12),c=>c.charCodeAt(0));if(!(f.content_type==='image/jpeg'&&sig[0]===255&&sig[1]===216&&sig[2]===255||f.content_type==='image/png'&&sig.slice(0,8).join(',')==='137,80,78,71,13,10,26,10'||f.content_type==='image/webp'&&raw.startsWith('RIFF')&&raw.slice(8,12)==='WEBP'||['video/mp4','audio/mp4'].includes(f.content_type)&&raw.slice(4,8)==='ftyp'||f.content_type==='audio/mpeg'&&(raw.startsWith('ID3')||sig[0]===255&&(sig[1]&224)===224)||f.content_type==='audio/ogg'&&raw.startsWith('OggS')&&raw.slice(0,128).includes('OpusHead')))bad('media signature mismatch');
  const kind=refTypes.get(f.id);if(!(kind==='photo'&&f.content_type.startsWith('image/')||kind==='video'&&f.content_type==='video/mp4'||kind==='audio'&&['audio/mpeg','audio/mp4'].includes(f.content_type)||kind==='voice_note'&&f.content_type==='audio/ogg'))bad('media MIME/type mismatch');return {...f};
 });
 if(seen.size!==refs.size)bad('missing media file');if(new TextEncoder().encode(html).length>180000)bad('compiled document too large');
 return {rich_message:{html,...(media.length?{media}:{})},files,metrics:{characters:chars,blocks:blockCount,photos:images,media:mediaCount,buttons,attachment_bytes:bytes},block_order:input.blocks.map(b=>b.type)};
}
export async function checkRich(input){const compiled=compileRich(input);for(const f of compiled.files){const bytes=Uint8Array.from(atob(f.base64),c=>c.charCodeAt(0));const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');if(digest!==f.sha256)bad('file SHA256 mismatch')};return compiled;}
export function richPreview(compiled){return {valid:true,...compiled.metrics,block_order:compiled.block_order,compiled_html:compiled.rich_message.html,note:'Structural check only; native client rendering remains unverified. No message sent.'};}
