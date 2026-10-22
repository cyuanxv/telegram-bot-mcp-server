import {paymentObservation} from './update';
import type {PostgresPaymentOrders} from './postgres-orders';
type Env=Record<string,string|undefined>;
type Resource={orders:Pick<PostgresPaymentOrders,'findByPayload'|'observe'>;close():Promise<void>};
const result=(status:number,code:string)=>Response.json({ok:status===200,status:code},{status,headers:{'Cache-Control':'no-store'}});
/** Called only AFTER the existing webhook secret has been verified. No transport,
 * checkout approval or registration. Disabled mode does not open storage. */
export async function receivePayment(update:unknown,botAlias:string,env:()=>Env,open:(owner:string,guard:()=>void)=>Promise<Resource>):Promise<Response|undefined>{
 const initial=env();if(initial.TELEGRAM_PAYMENT_RECEIVER_ENABLED!=='true')return undefined;
 const owner=initial.TELEGRAM_PAYMENT_OWNER_ID,scope=initial.TELEGRAM_PAYMENT_PAYERS_JSON;
 if(!owner?.trim()||owner.length>128)return result(503,'payment_unconfigured');
 let payers:unknown;try{const parsed=JSON.parse(scope??'null');payers=parsed&&Object.hasOwn(parsed,botAlias)?parsed[botAlias]:undefined}catch{return result(503,'payment_unconfigured')}
 if(payers===undefined)return undefined;
 if(!Array.isArray(payers)||!payers.length||payers.length>100||payers.some(p=>typeof p!=='string'||!/^[1-9][0-9]{0,15}$/.test(p)||BigInt(p)>9007199254740991n))return result(503,'payment_unconfigured');
 let event;try{event=paymentObservation(update,botAlias,payers)}catch{return result(400,'invalid_payment_update')}
 if(!event)return undefined;
 const guard=()=>{const e=env();if(e.TELEGRAM_PAYMENT_RECEIVER_ENABLED!=='true'||e.TELEGRAM_PAYMENT_OWNER_ID!==owner||e.TELEGRAM_PAYMENT_PAYERS_JSON!==scope)throw Error('Payment configuration changed')};
 let resource:Resource|undefined;
 try{guard();resource=await open(owner,guard);guard();const order=await resource.orders.findByPayload(botAlias,event.invoicePayload);if(!order)return result(409,'payment_order_unmatched');guard();await resource.orders.observe(order.order.id,event);return result(200,'payment_recorded')}
 catch{return result(503,'payment_storage_unavailable')}
 finally{try{await resource?.close()}catch{}}
}
