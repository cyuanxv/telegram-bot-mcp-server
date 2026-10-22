import {createHash} from 'node:crypto';
import type {TransactionalSql,SqlExecutor} from '../delivery/postgres-store';
import {validateContext,validateEnvelope,VaultError,type SealedCredential,type VaultKeyring} from './crypto';
import {rewrapCredential} from './rewrap';
export type RotationScope={ownerId:string;aliases:string[];fromKeyId:string;toKeyId:string};
export function rotationScope(input:unknown):RotationScope{
 const s=input as RotationScope;
 if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(k=>!['ownerId','aliases','fromKeyId','toKeyId'].includes(k))
  ||!Array.isArray(s.aliases)||s.aliases.length<1||s.aliases.length>100||new Set(s.aliases).size!==s.aliases.length
  ||[s.fromKeyId,s.toKeyId].some(k=>typeof k!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(k))||s.fromKeyId===s.toKeyId)throw new VaultError('invalid_rotation');
 for(const alias of s.aliases){if(typeof alias!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias))throw new VaultError('invalid_rotation');validateContext({ownerId:s.ownerId,alias,purpose:'bot_token'})}
 return {...s,aliases:[...s.aliases].sort()};
}
/** Explicit owner/alias batch; no keys, plaintext or encrypted envelopes in results. */
export class KeyRotation{
 private db:TransactionalSql;private scope:RotationScope;private guard:()=>void;
 constructor(db:TransactionalSql,scope:RotationScope,guard:()=>void){this.db=db;this.scope=rotationScope(scope);this.guard=guard}
 private async read(sql:SqlExecutor,lock:boolean){
  this.guard();const s=this.scope;
  const rows=(await sql.query(`SELECT alias,revision,envelope FROM public.telegram_credential_vault WHERE owner_id=$1 AND purpose='bot_token' AND alias=ANY($2::text[]) ORDER BY alias${lock?' FOR UPDATE':''}`,[s.ownerId,s.aliases])).rows;
  this.guard();if(rows.length!==s.aliases.length)throw new VaultError('rotation_state_changed');
  rows.sort((a,b)=>String(a.alias)<String(b.alias)?-1:String(a.alias)>String(b.alias)?1:0);
  return rows.map((row,i)=>{
   const e=structuredClone(row.envelope) as SealedCredential;validateEnvelope(e);
   if(row.alias!==s.aliases[i]||e.alias!==row.alias||e.ownerId!==s.ownerId||e.purpose!=='bot_token'||e.revision!==Number(row.revision)||e.keyId!==s.fromKeyId)throw new VaultError('rotation_state_changed');
   return e;
  });
 }
 private project(records:SealedCredential[]){
  const scope=structuredClone(this.scope);
  const digest=createHash('sha256').update(JSON.stringify({domain:'telegram.key-rotation.v1',scope,records})).digest('hex');
  return {scope,digest,count:records.length,records:records.map(e=>({alias:e.alias,revision:e.revision,next_revision:e.revision+1,expiresAt:e.expiresAt??null})),requires_reactivation:true,credentials_verified:false};
 }
 async inspect(){
  return this.db.transaction(async sql=>{
   this.guard();const s=this.scope;
   // Project metadata in SQL: encrypted content never leaves storage for this action.
   const rows=(await sql.query("SELECT alias,revision,envelope->>'keyId' AS key_id,envelope->>'revision' AS sealed_revision,envelope->>'ownerId' AS sealed_owner,envelope->>'alias' AS sealed_alias,envelope->>'purpose' AS sealed_purpose FROM public.telegram_credential_vault WHERE owner_id=$1 AND purpose='bot_token' AND alias=ANY($2::text[])",[s.ownerId,s.aliases])).rows;
   const found=new Map<string,{alias:string;revision:number;keyId:string;key_state:string}>();
   for(const row of rows){
    const revision=Number(row.revision);
    if(typeof row.alias!=='string'||!s.aliases.includes(row.alias)||found.has(row.alias)||!Number.isSafeInteger(revision)||revision<1
      ||Number(row.sealed_revision)!==revision||row.sealed_owner!==s.ownerId||row.sealed_alias!==row.alias||row.sealed_purpose!=='bot_token'
      ||typeof row.key_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(row.key_id))throw new VaultError('invalid_metadata');
    found.set(row.alias,{alias:row.alias,revision,keyId:row.key_id,key_state:row.key_id===s.fromKeyId?'source':row.key_id===s.toKeyId?'target':'other'});
   }
   this.guard();return {status:'rotation_metadata',records:s.aliases.map(alias=>found.get(alias)??{alias,key_state:'missing'}),credentials_verified:false,activation_verified:false,retry_automatically:false};
  });
 }
 async plan(){return this.db.transaction(async sql=>this.project(await this.read(sql,false)))}
 async apply(expectedDigest:string,keys:VaultKeyring,now=Date.now()){
  if(!/^[0-9a-f]{64}$/.test(expectedDigest))throw new VaultError('invalid_rotation');
  return this.db.transaction(async sql=>{
   const old=await this.read(sql,true),plan=this.project(old);
   if(plan.digest!==expectedDigest)throw new VaultError('rotation_state_changed');
   const next=old.map(e=>rewrapCredential({ownerId:e.ownerId,alias:e.alias,purpose:e.purpose},e,keys,this.scope.toKeyId,now));
   for(let i=0;i<next.length;i++){
    this.guard();const e=next[i];
    const rows=(await sql.query("UPDATE public.telegram_credential_vault SET revision=$1,envelope=$2::jsonb WHERE owner_id=$3 AND alias=$4 AND purpose='bot_token' AND revision=$5 RETURNING revision",[e.revision,JSON.stringify(e),e.ownerId,e.alias,old[i].revision])).rows;
    if(rows.length!==1)throw new VaultError('rotation_state_changed');
   }
   this.guard();return {status:'rotation_committed',count:next.length,records:next.map(e=>({alias:e.alias,revision:e.revision,keyId:e.keyId})),requires_reactivation:true,retry_automatically:false};
  });
 }
}
