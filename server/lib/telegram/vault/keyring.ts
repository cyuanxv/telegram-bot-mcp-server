import {VaultError} from './crypto';
type Env=Record<string,string|undefined>;
/** Trusted server configuration only. Never return keys from an HTTP/MCP handler. */
export function loadVaultKeyring(env:Env){
 const keys=new Map<string,Buffer>();
 const dispose=()=>{for(const key of keys.values())key.fill(0);keys.clear()};
 try{
  const add=(id:unknown,encoded:unknown)=>{
   if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(id)||keys.has(id)||typeof encoded!=='string'||encoded.length!==44)throw Error();
   const key=Buffer.from(encoded,'base64');
   if(key.length!==32||key.toString('base64')!==encoded){key.fill(0);throw Error()}
   keys.set(id,key);
  };
  add(env.TELEGRAM_VAULT_KEY_ID,env.TELEGRAM_VAULT_KEY_BASE64);
  const raw=env.TELEGRAM_VAULT_PREVIOUS_KEYS_JSON;
  if(raw!==undefined){
   if(raw.length>2048)throw Error();const prior:unknown=JSON.parse(raw);
   if(!prior||typeof prior!=='object'||Array.isArray(prior)||Object.keys(prior).length>4)throw Error();
   for(const [id,value] of Object.entries(prior))add(id,value);
  }
  return {keys,activeKeyId:env.TELEGRAM_VAULT_KEY_ID!,dispose};
 }catch{dispose();throw new VaultError('key_unavailable')}
}
