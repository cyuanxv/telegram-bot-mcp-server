/** Pure reconciliation only. Callers must authenticate webhook provenance and persist
 * the returned snapshot atomically. This module never accepts checkout or moves money. */
export type PaymentOrder = {
  id: string; botAlias: string; payerId: string; currency: string;
  totalAmount: number; invoicePayload: string; recurring: boolean;
};
export type PaymentObservation = {
  botAlias: string; payerId: string; kind: 'paid' | 'refunded';
  currency: string; totalAmount: number; invoicePayload: string; chargeId: string;
  recurring?: boolean; subscriptionExpiresAt?: number;
};
export type Charge = { chargeId: string; paid: boolean; refunded: boolean; subscriptionExpiresAt?: number };
export type PaymentSnapshot = { order: PaymentOrder; charges: Charge[] };
function invalid(): never { throw Error('Invalid payment reconciliation input'); }
function text(v: unknown, max: number): v is string { return typeof v === 'string' && v.length > 0 && v.length <= max; }
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function exact(v: object, keys: string[]) { if (Object.keys(v).some(k => !keys.includes(k))) invalid(); }
function validateOrder(o: PaymentOrder) {
  if (!record(o)) invalid();
  exact(o, ['id','botAlias','payerId','currency','totalAmount','invoicePayload','recurring']);
  if (!text(o.id,128) || !text(o.botAlias,64) || !text(o.payerId,16) || !/^[1-9][0-9]*$/.test(o.payerId) || BigInt(o.payerId)>9007199254740991n || (typeof o.currency!=='string'||!/^[A-Z]{3}$/.test(o.currency)) || !Number.isSafeInteger(o.totalAmount) || o.totalAmount<=0 || !text(o.invoicePayload,128) || Buffer.byteLength(o.invoicePayload,'utf8')>128 || typeof o.recurring!=='boolean') invalid();
}
export function createPaymentSnapshot(order: PaymentOrder): PaymentSnapshot {
  validateOrder(order); return { order: structuredClone(order), charges: [] };
}
function validateSnapshot(snapshot: PaymentSnapshot) {
  if (!record(snapshot)) invalid(); exact(snapshot,['order','charges']); validateOrder(snapshot.order);
  if (!Array.isArray(snapshot.charges) || snapshot.charges.length>10000) invalid();
  const ids=new Set<string>();
  for (const charge of snapshot.charges) {
    if (!record(charge)) invalid(); exact(charge,['chargeId','paid','refunded','subscriptionExpiresAt']);
    if (!text(charge.chargeId,1024) || ids.has(charge.chargeId) || typeof charge.paid!=='boolean' || typeof charge.refunded!=='boolean' || (!charge.paid&&!charge.refunded)) invalid();
    if (snapshot.order.recurring && charge.paid && charge.subscriptionExpiresAt===undefined) invalid();
    if (charge.subscriptionExpiresAt!==undefined && (!snapshot.order.recurring || !charge.paid || !Number.isSafeInteger(charge.subscriptionExpiresAt) || charge.subscriptionExpiresAt<=0)) invalid();
    ids.add(charge.chargeId);
  }
}
export function reconcilePayment(snapshot: PaymentSnapshot, event: PaymentObservation): PaymentSnapshot {
  validateSnapshot(snapshot);
  if (!record(event)) invalid(); exact(event,['botAlias','payerId','kind','currency','totalAmount','invoicePayload','chargeId','recurring','subscriptionExpiresAt']);
  const o=snapshot.order;
  if (!['paid','refunded'].includes(event.kind) || !text(event.chargeId,1024) || event.botAlias!==o.botAlias || event.payerId!==o.payerId || event.currency!==o.currency || event.totalAmount!==o.totalAmount || event.invoicePayload!==o.invoicePayload) throw Error('Payment does not match order');
  if (event.kind==='paid') {
    if (event.recurring!==undefined && typeof event.recurring!=='boolean') invalid();
    if ((event.recurring??false)!==o.recurring) throw Error('Payment recurrence does not match order');
    if (o.recurring ? !Number.isSafeInteger(event.subscriptionExpiresAt) || event.subscriptionExpiresAt!<=0 : event.subscriptionExpiresAt!==undefined) invalid();
  } else if (event.recurring!==undefined || event.subscriptionExpiresAt!==undefined) invalid();
  const next=structuredClone(snapshot);
  let charge=next.charges.find(c=>c.chargeId===event.chargeId);
  if (!charge) {
    if (next.charges.length>=10000) throw Error('Payment reconciliation capacity reached');
    charge={chargeId:event.chargeId,paid:false,refunded:false}; next.charges.push(charge);
  }
  if (event.kind==='paid') {
    if (charge.paid && charge.subscriptionExpiresAt!==event.subscriptionExpiresAt) throw Error('Conflicting payment observation');
    charge.paid=true;
    if(event.subscriptionExpiresAt!==undefined)charge.subscriptionExpiresAt=event.subscriptionExpiresAt;
  } else charge.refunded=true;
  validateSnapshot(next);return next;
}
export function paymentSummary(snapshot: PaymentSnapshot) {
  validateSnapshot(snapshot);
  const paid=snapshot.charges.filter(c=>c.paid).length,refunded=snapshot.charges.filter(c=>c.paid&&c.refunded).length;
  const unmatchedRefunds=snapshot.charges.filter(c=>c.refunded&&!c.paid).length;
  // Decimal strings avoid precision loss when many safe individual amounts are aggregated.
  const amount=BigInt(snapshot.order.totalAmount);
  return { observed_payments:paid,matched_refunds:refunded,unmatched_refunds:unmatchedRefunds,
    gross_amount:(amount*BigInt(paid)).toString(),matched_refund_amount:(amount*BigInt(refunded)).toString(),
    observed_net_amount:(amount*BigInt(paid-refunded)).toString(),currency:snapshot.order.currency,
    requires_review:unmatchedRefunds>0||(!snapshot.order.recurring&&paid>1),
    fulfillment_authorized:false,complete_ledger:false };
}
