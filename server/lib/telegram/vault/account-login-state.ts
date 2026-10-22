import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';import {z} from 'zod';
import {validateContext,VaultError,type VaultKeyring} from './crypto';
const base=z.object({apiId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),apiHash:z.string().regex(/^[a-fA-F0-9]{32}$/)}).strict();
const phone=z.string().regex(/^\+[1-9][0-9]{5,14}$/),session=z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/);
export const loginStateSchema=z.discriminatedUnion('phase',[
 base.extend({phase:z.literal('prepared'),phone}),
 base.extend({phase:z.literal('code_required'),phone,session,phoneCodeHash:z.string().min(1).max(1024),delivery:z.enum(['app','sms','call'])}),
 base.extend({phase:z.literal('password_required'),session}),
 base.extend({phase:z.literal('authorized'),session,userId:z.string().regex(/^[1-9][0-9]{0,15}$/).refine(v=>Number.isSafeInteger(Number(v)))}),
]);
export type LoginState=z.infer<typeof loginStateSchema>;
export type LoginContext={ownerId:string;id:string;alias:string;revision:number;expiresAt:number};
export const loginEnvelopeSchema=z.object({version:z.literal(1),keyId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/),nonce:z.string().max(32),tag:z.string().max(32),ciphertext:z.string().max(22000)}).strict();
export type LoginEnvelope=z.infer<typeof loginEnvelopeSchema>;
function check(c:LoginContext){validateContext({ownerId:c.ownerId,alias:c.alias,purpose:'mtproto_account'});if(!z.string().uuid().safeParse(c.id).success||!Number.isSafeInteger(c.revision)||c.revision<1||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<1)throw new VaultError('invalid_login_context')}
function aad(c:LoginContext,keyId:string){return Buffer.from(JSON.stringify(['telegram.login-state.v1',c.ownerId,c.id,c.alias,c.revision,c.expiresAt,keyId]))}
function key(keys:VaultKeyring,id:string){const v=keys.get(id);if(!v||v.byteLength!==32)throw new VaultError('key_unavailable');return Buffer.from(v)}
function bytes(v:string,n?:number){const b=Buffer.from(v,'base64url');if(!b.length||b.toString('base64url')!==v||(n!==undefined&&b.length!==n))throw Error();return b}
export function sealLoginState(c:LoginContext,state:LoginState,keys:VaultKeyring,keyId:string):LoginEnvelope{
 check(c);const plain=Buffer.from(JSON.stringify(loginStateSchema.parse(state))),k=key(keys,keyId);
 try{const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',k,nonce);cipher.setAAD(aad(c,keyId));const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);return loginEnvelopeSchema.parse({version:1,keyId,nonce:nonce.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),ciphertext:ciphertext.toString('base64url')})}finally{k.fill(0);plain.fill(0)}
}
export function openLoginState(c:LoginContext,value:unknown,keys:VaultKeyring,now=Date.now()):LoginState{
 check(c);let k:Buffer|undefined,plain:Buffer|undefined;
 try{if(c.expiresAt<=now)throw Error();const e=loginEnvelopeSchema.parse(value);k=key(keys,e.keyId);const cipher=createDecipheriv('aes-256-gcm',k,bytes(e.nonce,12));cipher.setAAD(aad(c,e.keyId));cipher.setAuthTag(bytes(e.tag,16));plain=Buffer.concat([cipher.update(bytes(e.ciphertext)),cipher.final()]);return loginStateSchema.parse(JSON.parse(plain.toString('utf8')))}catch{throw new VaultError('login_state_unavailable')}finally{k?.fill(0);plain?.fill(0)}
}
