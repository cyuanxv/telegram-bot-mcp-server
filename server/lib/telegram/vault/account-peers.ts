import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {z} from 'zod';
import type {TransactionalSql,SqlExecutor} from '../delivery/postgres-store';
import {validateContext,VaultError,type VaultKeyring} from './crypto';
const positive=z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n);
const hash=z.string().regex(/^-?(?:0|[1-9][0-9]{0,18})$/).refine(v=>BigInt(v)>=-9223372036854775808n&&BigInt(v)<=9223372036854775807n);
export const accountPeerSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('user'),id:positive,accessHash:hash}).strict(),
 z.object({kind:z.literal('channel'),id:positive,accessHash:hash}).strict(),
 z.object({kind:z.literal('chat'),id:positive}).strict(),
]);
export type AccountPeer=z.infer<typeof accountPeerSchema>;
export type PeerContext={ownerId:string;alias:string;userId:string;vaultRevision:number;peerId:string};
const envelopeSchema=z.object({version:z.literal(1),keyId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/),createdAt:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),nonce:z.string().max(32),tag:z.string().max(32),ciphertext:z.string().max(2048)}).strict();
export type PeerEnvelope=z.infer<typeof envelopeSchema>;
export function accountPeerId(peer:AccountPeer){return peer.kind==='user'?peer.id:peer.kind==='chat'?`-${peer.id}`:(-(1000000000000n+BigInt(peer.id))).toString()}
function context(c:PeerContext){validateContext({ownerId:c.ownerId,alias:c.alias,purpose:'mtproto_account'});if(!/^[1-9][0-9]{0,15}$/.test(c.userId)||!Number.isSafeInteger(Number(c.userId))||!Number.isSafeInteger(c.vaultRevision)||c.vaultRevision<1||! /^-?[1-9][0-9]{0,19}$/.test(c.peerId))throw new VaultError('invalid_peer_context')}
function aad(c:PeerContext,e:Pick<PeerEnvelope,'version'|'keyId'|'createdAt'>){return Buffer.from(JSON.stringify(['telegram.account-peer.v1',c.ownerId,c.alias,c.userId,c.vaultRevision,c.peerId,e.version,e.keyId,e.createdAt]))}
function key(keys:VaultKeyring,id:string){const v=keys.get(id);if(!v||v.byteLength!==32)throw new VaultError('key_unavailable');return Buffer.from(v)}
function bytes(v:string,length?:number){const b=Buffer.from(v,'base64url');if(!b.length||b.toString('base64url')!==v||(length!==undefined&&b.length!==length))throw Error();return b}
export function sealAccountPeer(c:PeerContext,value:AccountPeer,keys:VaultKeyring,keyId:string,now=Date.now()):PeerEnvelope{
 context(c);const peer=accountPeerSchema.parse(value);if(accountPeerId(peer)!==c.peerId)throw new VaultError('peer_identity_mismatch');
 const k=key(keys,keyId),plain=Buffer.from(JSON.stringify(peer));
 try{const metadata={version:1 as const,keyId,createdAt:now},nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',k,nonce);cipher.setAAD(aad(c,metadata));const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);return envelopeSchema.parse({...metadata,nonce:nonce.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),ciphertext:ciphertext.toString('base64url')})}
 finally{k.fill(0);plain.fill(0)}
}
export function openAccountPeer(c:PeerContext,value:unknown,keys:VaultKeyring):AccountPeer{
 context(c);let k:Buffer|undefined,plain:Buffer|undefined;
 try{const e=envelopeSchema.parse(value);k=key(keys,e.keyId);const cipher=createDecipheriv('aes-256-gcm',k,bytes(e.nonce,12));cipher.setAAD(aad(c,e));cipher.setAuthTag(bytes(e.tag,16));plain=Buffer.concat([cipher.update(bytes(e.ciphertext)),cipher.final()]);const peer=accountPeerSchema.parse(JSON.parse(plain.toString('utf8')));if(accountPeerId(peer)!==c.peerId)throw Error();return peer}
 catch{throw new VaultError('peer_unavailable')}finally{k?.fill(0);plain?.fill(0)}
}
export class AccountPeerStore{
 private db:TransactionalSql;constructor(db:TransactionalSql){this.db=db}
 private async transaction<T>(fn:(sql:SqlExecutor)=>Promise<T>):Promise<T>{try{return await this.db.transaction(fn)}catch(e){if(e instanceof VaultError)throw e;throw new VaultError('peer_store_unavailable')}}
 async load(c:PeerContext):Promise<PeerEnvelope|undefined>{c={...c};context(c);return this.transaction(async sql=>{
  const row=(await sql.query("SELECT p.envelope FROM public.telegram_account_peers p JOIN public.telegram_account_directory d ON d.owner_id=p.owner_id AND d.alias=p.alias AND d.user_id=p.user_id AND d.vault_revision=p.vault_revision JOIN public.telegram_credential_vault v ON v.owner_id=p.owner_id AND v.alias=p.alias AND v.purpose='mtproto_account' AND v.revision=p.vault_revision WHERE p.owner_id=$1 AND p.alias=$2 AND p.user_id=$3 AND p.vault_revision=$4 AND p.peer_id=$5 AND d.active=true",[c.ownerId,c.alias,c.userId,c.vaultRevision,c.peerId])).rows[0];return row?envelopeSchema.parse(row.envelope):undefined;
 })}
 async save(c:PeerContext,envelope:PeerEnvelope){c={...c};context(c);envelope=envelopeSchema.parse(envelope);return this.transaction(async sql=>{
  // Serialize bounded per-account cache growth and bind writes to the active session.
  await sql.query('LOCK TABLE public.telegram_account_peers IN SHARE ROW EXCLUSIVE MODE');
  const active=(await sql.query("SELECT d.user_id FROM public.telegram_account_directory d JOIN public.telegram_credential_vault v ON v.owner_id=d.owner_id AND v.alias=d.alias AND v.purpose='mtproto_account' AND v.revision=d.vault_revision WHERE d.owner_id=$1 AND d.alias=$2 AND d.user_id=$3 AND d.vault_revision=$4 AND d.active=true FOR SHARE OF d,v",[c.ownerId,c.alias,c.userId,c.vaultRevision])).rows[0];if(!active)throw new VaultError('account_state_changed');
  const prior=(await sql.query('SELECT peer_id FROM public.telegram_account_peers WHERE owner_id=$1 AND alias=$2 AND peer_id=$3',[c.ownerId,c.alias,c.peerId])).rows[0];
  if(!prior){const count=Number((await sql.query('SELECT count(*) AS n FROM public.telegram_account_peers WHERE owner_id=$1 AND alias=$2',[c.ownerId,c.alias])).rows[0]?.n);if(!Number.isSafeInteger(count)||count>=1000)throw new VaultError('peer_capacity')}
  await sql.query('INSERT INTO public.telegram_account_peers(owner_id,alias,user_id,vault_revision,peer_id,envelope) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(owner_id,alias,peer_id) DO UPDATE SET user_id=EXCLUDED.user_id,vault_revision=EXCLUDED.vault_revision,envelope=EXCLUDED.envelope',[c.ownerId,c.alias,c.userId,c.vaultRevision,c.peerId,JSON.stringify(envelope)]);
 })}
}
