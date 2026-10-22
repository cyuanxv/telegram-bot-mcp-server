import { isDeepStrictEqual } from 'node:util';
import type { TransactionalSql } from '../delivery/postgres-store';
import { createPaymentSnapshot, reconcilePayment, paymentSummary, type PaymentOrder, type PaymentObservation, type PaymentSnapshot } from './reconcile';
/** Fixed authenticated owner from server configuration, never an MCP argument.
 * Caller authenticates observations. Transactions commit snapshot and charge binding together. */
export class PostgresPaymentOrders {
 private db:TransactionalSql;private owner:string;
 constructor(db:TransactionalSql,owner:string){if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw Error('Invalid payment owner');this.db=db;this.owner=owner}
 private decode(row:Record<string,unknown>|undefined,id:string):PaymentSnapshot|undefined{
  if(!row)return undefined;
  const s=structuredClone(row.document) as PaymentSnapshot;paymentSummary(s);
  if(s.order.id!==id||s.order.id!==row.order_id||s.order.botAlias!==row.bot_alias||s.order.invoicePayload!==row.invoice_payload)throw Error('Invalid stored payment identity');return s;
 }
 private async safely<T>(fn:()=>Promise<T>):Promise<T>{try{return await fn()}catch{throw Error('Payment storage operation failed')}}
 create(input:PaymentOrder):Promise<PaymentSnapshot>{
  const snapshot=createPaymentSnapshot(input),o=snapshot.order;
  return this.safely(()=>this.db.transaction(async sql=>{
   await sql.query('INSERT INTO public.telegram_payment_orders(owner_id,order_id,bot_alias,invoice_payload,document) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING',[this.owner,o.id,o.botAlias,o.invoicePayload,JSON.stringify(snapshot)]);
   const prior=this.decode((await sql.query('SELECT order_id,bot_alias,invoice_payload,document FROM public.telegram_payment_orders WHERE owner_id=$1 AND order_id=$2 FOR UPDATE',[this.owner,o.id])).rows[0],o.id);
   if(!prior||!isDeepStrictEqual(prior.order,o))throw Error('Payment order conflict');return prior;
  }));
 }
 get(id:string):Promise<PaymentSnapshot|undefined>{
  if(typeof id!=='string'||!id.length||id.length>128)throw Error('Invalid payment order ID');
  return this.safely(()=>this.db.transaction(async sql=>this.decode((await sql.query('SELECT order_id,bot_alias,invoice_payload,document FROM public.telegram_payment_orders WHERE owner_id=$1 AND order_id=$2',[this.owner,id])).rows[0],id)));
 }
 findByPayload(botAlias:string,payload:string):Promise<PaymentSnapshot|undefined>{
  if(typeof botAlias!=='string'||!botAlias.length||botAlias.length>64||typeof payload!=='string'||!payload.length||Buffer.byteLength(payload)>128)throw Error('Invalid payment lookup');
  return this.safely(()=>this.db.transaction(async sql=>{
   const row=(await sql.query('SELECT order_id,bot_alias,invoice_payload,document FROM public.telegram_payment_orders WHERE owner_id=$1 AND bot_alias=$2 AND invoice_payload=$3',[this.owner,botAlias,payload])).rows[0];
   return row?this.decode(row,String(row.order_id)):undefined;
  }));
 }
 observe(id:string,supplied:PaymentObservation):Promise<PaymentSnapshot>{
  const event=structuredClone(supplied);if(typeof id!=='string'||!id.length||id.length>128)throw Error('Invalid payment order ID');
  return this.safely(()=>this.db.transaction(async sql=>{
   const prior=this.decode((await sql.query('SELECT order_id,bot_alias,invoice_payload,document FROM public.telegram_payment_orders WHERE owner_id=$1 AND order_id=$2 FOR UPDATE',[this.owner,id])).rows[0],id);
   if(!prior)throw Error('Unknown order');const next=reconcilePayment(prior,event);
   await sql.query('INSERT INTO public.telegram_payment_charge_bindings(owner_id,bot_alias,charge_id,order_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[this.owner,event.botAlias,event.chargeId,id]);
   const binding=(await sql.query('SELECT order_id FROM public.telegram_payment_charge_bindings WHERE owner_id=$1 AND bot_alias=$2 AND charge_id=$3',[this.owner,event.botAlias,event.chargeId])).rows[0];
   if(binding?.order_id!==id)throw Error('Charge already assigned');
   await sql.query('UPDATE public.telegram_payment_orders SET document=$1::jsonb WHERE owner_id=$2 AND order_id=$3',[JSON.stringify(next),this.owner,id]);return next;
  }));
 }
}
