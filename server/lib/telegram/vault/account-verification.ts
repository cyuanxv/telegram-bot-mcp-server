import {TelegramClient} from 'teleproto';
import {StringSession} from 'teleproto/sessions';
import {Logger,LogLevel} from 'teleproto/extensions/Logger';
import {z} from 'zod';
import type {AccountSecret} from './crypto';
const secretSchema=z.object({apiId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),apiHash:z.string().regex(/^[a-fA-F0-9]{32}$/),session:z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/)}).strict();
export const ACCOUNT_VERIFICATION_TIMEOUT_MS=30000;
/** Trusted backend-only read-only verification. Never expose this input as an MCP tool. */
export async function verifyAccountSession(supplied:AccountSecret,options:{signal?:AbortSignal;guard?:()=>void}={}){
 let secret:AccountSecret;
 try{secret=secretSchema.parse(supplied)}catch{throw Error('Account session input invalid')}
 let client:TelegramClient|undefined,timer:ReturnType<typeof setTimeout>|undefined,cancelled=false;
 let abort:(()=>void)|undefined;
 const guard=()=>{if(cancelled||options.signal?.aborted)throw Error('Account verification cancelled');options.guard?.()};
 const interrupted=new Promise<never>((_,reject)=>{
  const stop=()=>{cancelled=true;reject(Error('Account verification unconfirmed'))};
  timer=setTimeout(stop,ACCOUNT_VERIFICATION_TIMEOUT_MS);abort=stop;
  options.signal?.addEventListener('abort',abort,{once:true});
 });
 const operation=async()=>{
  try{
   guard();client=new TelegramClient(new StringSession(secret.session),secret.apiId,secret.apiHash,{connectionRetries:1,requestRetries:1,timeout:20,autoReconnect:false,floodSleepThreshold:0,baseLogger:new Logger(LogLevel.NONE)});
   await client.connect();guard();if(!await client.isUserAuthorized())throw Error();guard();
   const me=await client.getMe();guard();
   const id=String(me?.id??'');
   if(!/^[1-9][0-9]{0,15}$/.test(id)||!Number.isSafeInteger(Number(id))||me.bot===true||me.deleted===true)throw Error();
   // No username, phone, access hash, raw TL object or session string is returned.
   return {user_id:id,provider_authorization_verified:true as const,saved:false as const,activated:false as const};
  }finally{await client?.disconnect().catch(()=>{})}
 };
 try{const result=await Promise.race([operation(),interrupted]);guard();return result}
 catch{throw Error('Account verification unconfirmed')}
 finally{clearTimeout(timer);if(abort)options.signal?.removeEventListener('abort',abort);if(cancelled&&client)void client.disconnect().catch(()=>{})}
}
