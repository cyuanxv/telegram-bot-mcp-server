import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPaymentSnapshot,reconcilePayment,paymentSummary} from '../lib/telegram/payments/reconcile.ts';
const order={id:'order_1',botAlias:'default',payerId:'123',currency:'XTR',totalAmount:10,invoicePayload:'opaque-order_1',recurring:false};
const event={botAlias:'default',payerId:'123',currency:'XTR',totalAmount:10,invoicePayload:'opaque-order_1',chargeId:'charge_1',kind:'paid'};
test('payments and refunds sharing a charge are independent, idempotent observations',()=>{
 let s=createPaymentSnapshot(order);s=reconcilePayment(s,event);assert.deepEqual(reconcilePayment(s,event),s);
 s=reconcilePayment(s,{...event,kind:'refunded'});assert.deepEqual(reconcilePayment(s,{...event,kind:'refunded'}),s);
 assert.equal(paymentSummary(s).observed_net_amount,'0');assert.equal(paymentSummary(s).observed_payments,1);assert.equal(paymentSummary(s).matched_refunds,1);
});
test('refund arriving before success remains visible and later payment cannot resurrect value',()=>{
 const initial=createPaymentSnapshot(order),refund={...event,kind:'refunded'};
 const first=reconcilePayment(initial,refund);assert.equal(paymentSummary(first).unmatched_refunds,1);assert.equal(paymentSummary(first).requires_review,true);
 const final=reconcilePayment(first,event);assert.deepEqual(final,reconcilePayment(reconcilePayment(initial,event),refund));assert.equal(paymentSummary(final).observed_net_amount,'0');assert.equal(initial.charges.length,0);
});
test('wrong bot, payer, currency, amount or invoice payload never alter state',()=>{
 const s=createPaymentSnapshot(order);
 for(const patch of [{botAlias:'other'},{payerId:'456'},{currency:'USD'},{totalAmount:11},{invoicePayload:'other'},{kind:'pre_checkout'}])assert.throws(()=>reconcilePayment(s,{...event,...patch}));
 assert.equal(s.charges.length,0);
});
test('recurring charges remain separate, retries with conflicting expiry fail',()=>{
 let s=createPaymentSnapshot({...order,recurring:true});const first={...event,recurring:true,subscriptionExpiresAt:100};s=reconcilePayment(s,first);s=reconcilePayment(s,{...first,chargeId:'charge_2',subscriptionExpiresAt:200});
 assert.equal(paymentSummary(s).observed_payments,2);assert.equal(paymentSummary(s).requires_review,false);
 assert.throws(()=>reconcilePayment(s,{...first,subscriptionExpiresAt:101}));assert.throws(()=>reconcilePayment(s,event));
});
test('duplicate one-off payments are preserved for review and never authorize fulfillment',()=>{
 let s=reconcilePayment(createPaymentSnapshot(order),event);s=reconcilePayment(s,{...event,chargeId:'second'});const summary=paymentSummary(s);
 assert.equal(summary.requires_review,true);assert.equal(summary.gross_amount,'20');assert.equal(summary.fulfillment_authorized,false);assert.equal(summary.complete_ledger,false);
});
test('unsafe amounts, ambiguous identities and extra private fields are rejected',()=>{
 for(const patch of [{totalAmount:1.5},{totalAmount:0},{totalAmount:Number.MAX_SAFE_INTEGER+1},{payerId:'001'},{payerId:'9007199254740992'},{invoicePayload:'中'.repeat(50)},{email:'private'}])assert.throws(()=>createPaymentSnapshot({...order,...patch}));
 assert.throws(()=>reconcilePayment(createPaymentSnapshot(order),{...event,recurring:null}));
 assert.throws(()=>reconcilePayment(createPaymentSnapshot(order),{...event,order_info:{email:'private'}}));
});
test('aggregate precision is preserved beyond safe integer and returned snapshots are isolated',()=>{
 const o={...order,totalAmount:Number.MAX_SAFE_INTEGER};let s=reconcilePayment(createPaymentSnapshot(o),{...event,totalAmount:o.totalAmount});s=reconcilePayment(s,{...event,chargeId:'second',totalAmount:o.totalAmount});
 assert.equal(paymentSummary(s).gross_amount,'18014398509481982');s.order.totalAmount=1;assert.equal(o.totalAmount,Number.MAX_SAFE_INTEGER);
});
