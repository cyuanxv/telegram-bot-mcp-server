import type { PaymentObservation } from './reconcile';
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function id(v:unknown):string{if(typeof v!=='string'||!/^[1-9][0-9]{0,15}$/.test(v)||BigInt(v)>9007199254740991n)throw Error('Invalid payment identity');return v}
/** Input comes from authenticated readWebhookBody, which preserves exact ID tokens. */
export function paymentObservation(update:unknown,botAlias:string,allowedPayerIds:string[]):PaymentObservation|undefined{
 if(!record(update)||!record(update.message))return undefined;
 const m=update.message,paid=m.successful_payment!==undefined,refunded=m.refunded_payment!==undefined;
 if(!paid&&!refunded)return undefined;
 if(typeof update.update_id!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(update.update_id)||BigInt(update.update_id)>9007199254740991n||!Number.isSafeInteger(m.date)||(m.date as number)<0)throw Error('Invalid payment update identity');
 id(m.message_id);
 if(paid&&refunded)throw Error('Ambiguous payment update');
 if(!record(m.from)||!record(m.chat)||m.chat.type!=='private'||m.business_connection_id!==undefined||m.forward_origin!==undefined||m.from.is_bot===true)throw Error('Unsupported payment source');
 const payer=id(m.from.id);if(id(m.chat.id)!==payer||!allowedPayerIds.includes(payer))throw Error('Payment payer not allowed');
 const p=paid?m.successful_payment:m.refunded_payment;
 if(!record(p)||typeof p.currency!=='string'||!/^[A-Z]{3}$/.test(p.currency)||!Number.isSafeInteger(p.total_amount)||(p.total_amount as number)<=0||typeof p.invoice_payload!=='string'||!p.invoice_payload.length||Buffer.byteLength(p.invoice_payload)>128||typeof p.telegram_payment_charge_id!=='string'||!p.telegram_payment_charge_id.length||p.telegram_payment_charge_id.length>1024)throw Error('Invalid payment update');
 if(refunded&&(p.is_recurring!==undefined||p.is_first_recurring!==undefined||p.subscription_expiration_date!==undefined))throw Error('Invalid refund recurrence');
 if(p.is_recurring!==undefined&&p.is_recurring!==true)throw Error('Invalid payment recurrence');
 if(p.is_first_recurring!==undefined&&(p.is_first_recurring!==true||p.is_recurring!==true))throw Error('Invalid first subscription payment');
 if(paid&&((p.is_recurring===true)!==(p.subscription_expiration_date!==undefined)))throw Error('Incomplete payment recurrence');
 if(p.subscription_expiration_date!==undefined&&(!Number.isSafeInteger(p.subscription_expiration_date)||(p.subscription_expiration_date as number)<=0))throw Error('Invalid payment expiry');
 return {botAlias,payerId:payer,kind:paid?'paid':'refunded',currency:p.currency,totalAmount:p.total_amount as number,invoicePayload:p.invoice_payload,chargeId:p.telegram_payment_charge_id,...(paid?{recurring:p.is_recurring===true,...(p.subscription_expiration_date===undefined?{}:{subscriptionExpiresAt:p.subscription_expiration_date as number})}:{})};
}
