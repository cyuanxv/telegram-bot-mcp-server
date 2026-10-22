import {Api,TelegramClient} from 'teleproto';
import {StringSession} from 'teleproto/sessions';
import {Logger,LogLevel} from 'teleproto/extensions/Logger';
import {computeCheck} from 'teleproto/Password';
import {z} from 'zod';
const credentials=z.object({apiId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),apiHash:z.string().regex(/^[a-fA-F0-9]{32}$/)}).strict();
const continuation=credentials.extend({session:z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/)});
const inputSchema=z.discriminatedUnion('action',[
 credentials.extend({action:z.literal('request_code'),phone:z.string().regex(/^\+[1-9][0-9]{5,14}$/)}),
 continuation.extend({action:z.literal('submit_code'),phone:z.string().regex(/^\+[1-9][0-9]{5,14}$/),phoneCodeHash:z.string().min(1).max(1024),code:z.string().regex(/^[0-9]{3,12}$/)}),
 continuation.extend({action:z.literal('submit_password'),password:z.string().min(1).max(1024)}),
]);
export class AccountLoginError extends Error{code:string;retryAfter?:number;constructor(code:string,retryAfter?:number){super(`Account login: ${code}`);this.code=code;this.retryAfter=retryAfter}}
/** Internal secret-bearing result. Never send this object to HTTP/MCP or logs. */
export type LoginProviderResult=
 |{phase:'code_required';session:string;phoneCodeHash:string;delivery:'app'|'sms'|'call';codeLength?:number;retryAfter?:number}
 |{phase:'password_required';session:string}
 |{phase:'authorized';session:string;userId:string};
function safeError(error:unknown){
 if(error instanceof AccountLoginError)return error;
 const code=error&&typeof error==='object'?(error as {errorMessage?:unknown}).errorMessage:undefined;
 if(typeof code==='string'){
  const flood=/^FLOOD_WAIT_([0-9]{1,6})$/.exec(code);if(flood)return new AccountLoginError('rate_limited',Number(flood[1]));
  const allowed:Record<string,string>={PHONE_CODE_INVALID:'invalid_code',PHONE_CODE_EXPIRED:'code_expired',PASSWORD_HASH_INVALID:'invalid_password',PHONE_NUMBER_INVALID:'invalid_phone',PHONE_NUMBER_BANNED:'phone_unavailable',API_ID_INVALID:'invalid_api_configuration',AUTH_KEY_UNREGISTERED:'session_expired',SESSION_REVOKED:'session_expired'};
  if(allowed[code])return new AccountLoginError(allowed[code]);
 }
 return new AccountLoginError('result_unconfirmed');
}
export const ACCOUNT_LOGIN_TIMEOUT_MS=30000;
/** One explicit step per call, never retries, signs up, accepts terms, resets a password or pays. */
export async function accountLoginStep(supplied:unknown,options:{signal?:AbortSignal;guard?:()=>void}={}):Promise<LoginProviderResult>{
 const parsed=inputSchema.safeParse(supplied);if(!parsed.success)throw new AccountLoginError('invalid_input');const input=parsed.data;
 let client:TelegramClient|undefined,timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined,stopped=false;
 const guard=()=>{if(stopped||options.signal?.aborted)throw new AccountLoginError('result_unconfirmed');options.guard?.()};
 const interruption=new Promise<never>((_,reject)=>{abort=()=>{stopped=true;reject(new AccountLoginError('result_unconfirmed'))};timer=setTimeout(abort,ACCOUNT_LOGIN_TIMEOUT_MS);options.signal?.addEventListener('abort',abort,{once:true})});
 const operation=async():Promise<LoginProviderResult>=>{
  try{
   guard();client=new TelegramClient(new StringSession(input.action==='request_code'?'':input.session),input.apiId,input.apiHash,{connectionRetries:1,requestRetries:1,timeout:20,autoReconnect:false,floodSleepThreshold:0,baseLogger:new Logger(LogLevel.NONE)});
   await client.connect();guard();
   const session=()=>{const value=client!.session.save();if(typeof value!=='string'||!value||value.length>8192||!/^[\x21-\x7e]+$/.test(value))throw Error();return value};
   const authorized=async():Promise<LoginProviderResult>=>{guard();const me=await client!.getMe();guard();const id=String(me?.id??'');if(me.bot||me.deleted||!/^[1-9][0-9]{0,15}$/.test(id)||!Number.isSafeInteger(Number(id)))throw Error();return {phase:'authorized',userId:id,session:session()}};
   if(input.action==='request_code'){
    const result=await client.invoke(new Api.auth.SendCode({phoneNumber:input.phone,apiId:input.apiId,apiHash:input.apiHash,settings:new Api.CodeSettings({})}));guard();
    if(result instanceof Api.auth.SentCodeSuccess){if(result.authorization instanceof Api.auth.AuthorizationSignUpRequired)throw new AccountLoginError('signup_not_supported');return await authorized()}
    if(!(result instanceof Api.auth.SentCode))throw new AccountLoginError('delivery_not_supported');
    let delivery:'app'|'sms'|'call';if(result.type instanceof Api.auth.SentCodeTypeApp)delivery='app';else if(result.type instanceof Api.auth.SentCodeTypeSms)delivery='sms';else if(result.type instanceof Api.auth.SentCodeTypeCall)delivery='call';else throw new AccountLoginError('delivery_not_supported');
    if(!result.phoneCodeHash||result.phoneCodeHash.length>1024)throw Error();
    return {phase:'code_required',session:session(),phoneCodeHash:result.phoneCodeHash,delivery,...(Number.isSafeInteger(result.type.length)&&result.type.length>0?{codeLength:result.type.length}:{}),...(Number.isSafeInteger(result.timeout)&&result.timeout!>=0?{retryAfter:result.timeout}: {})};
   }
   if(input.action==='submit_code'){
    try{const result=await client.invoke(new Api.auth.SignIn({phoneNumber:input.phone,phoneCodeHash:input.phoneCodeHash,phoneCode:input.code}));guard();if(result instanceof Api.auth.AuthorizationSignUpRequired)throw new AccountLoginError('signup_not_supported')}
    catch(error){guard();if((error as {errorMessage?:string})?.errorMessage==='SESSION_PASSWORD_NEEDED')return {phase:'password_required',session:session()};throw error}
   }else{
    const parameters=await client.invoke(new Api.account.GetPassword());guard();
    const proof=await computeCheck(parameters,input.password);guard();
    const result=await client.invoke(new Api.auth.CheckPassword({password:proof}));guard();if(result instanceof Api.auth.AuthorizationSignUpRequired)throw new AccountLoginError('signup_not_supported');
   }
   return await authorized();
  }finally{await client?.disconnect().catch(()=>{})}
 };
 try{const result=await Promise.race([operation(),interruption]);guard();return result}catch(error){throw safeError(error)}
 finally{clearTimeout(timer);if(abort)options.signal?.removeEventListener('abort',abort);if(stopped&&client)void client.disconnect().catch(()=>{})}
}
