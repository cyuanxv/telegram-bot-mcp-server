import {openCredential,sealCredential,validateEnvelope,VaultError,type CredentialContext,type SealedCredential,type VaultKeyring} from './crypto';
/** Re-encryption only: caller persists with the existing revision CAS and reviews reactivation. */
export function rewrapCredential(context:CredentialContext,supplied:SealedCredential,keys:VaultKeyring,targetKeyId:string,now:number){
 const envelope=structuredClone(supplied);validateEnvelope(envelope);
 if(targetKeyId===envelope.keyId||envelope.revision>=Number.MAX_SAFE_INTEGER)throw new VaultError('invalid_rotation');
 const secret=openCredential(context,envelope,keys,now);
 return sealCredential(context,secret,keys,targetKeyId,{revision:envelope.revision+1,createdAt:envelope.createdAt,...(envelope.expiresAt===undefined?{}:{expiresAt:envelope.expiresAt})});
}
