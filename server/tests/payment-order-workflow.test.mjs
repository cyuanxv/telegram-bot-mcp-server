import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {PostgresPaymentOrders} from '../lib/telegram/payments/postgres-orders.ts';
import {PaymentOrderWorkflow} from '../lib/telegram/payments/order-workflow.ts';
const input={id:'test:one',bot_alias:'default',payer_id:'123',currency:'XTR',total_amount:10,recurring:false};
const config=()=>({TELEGRAM_PAYMENT_ORDERS_ENABLED:'true',TELEGRAM_PAYMENT_OWNER_ID:'owner',TELEGRAM_PAYMENT_PAYERS_JSON:'{"default":["123"]}',TELEGRAM_BOT_TOKEN:'fake-not-used'});
async function setup(t){const pg=new PGlite();t.after(()=>pg.close());await pg.exec(readFileSync(new URL('../migrations/008_payment_orders.sql',import.meta.url),'utf8'));let env=config(),opened=0,closed=0;const stores=[];const open=async(owner,guard)=>{opened++;const db={transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>{guard();return tx.query(q,p)}}))};const store=new PostgresPaymentOrders(db,owner);stores.push(store);return {orders:store,close:async()=>{closed++}}};return {get env(){return env},set env(v){env=v},open,workflow:new PaymentOrderWorkflow(()=>env,open),stores,get opened(){return opened},get closed(){return closed}}}
test('disabled, cancelled, unscopeable and injected orders open no database',async()=>{
 for(const [env,args,signal] of [[{},input],[config(),{...input,payer_id:'999'}],[config(),{...input,owner_id:'other'}],[config(),{...input,invoice_payload:'x'}],[config(),{...input,total_amount:0}],[config(),input,AbortSignal.abort()]]){
  let opened=0;const workflow=new PaymentOrderWorkflow(()=>env,async()=>{opened++;throw Error('unreachable')});await assert.rejects(workflow.execute('draft',args,signal));assert.equal(opened,0);
 }
});
test('draft repeat preserves observations; status is sanitized and immutable conflicts do not overwrite',async t=>{
 const f=await setup(t),first=await f.workflow.execute('draft',input);assert.equal(first.order_recorded,true);assert.equal(first.invoice_sent_by_this_operation,false);
 const store=f.stores[0],snapshot=await store.get(input.id);assert.match(snapshot.order.invoicePayload,/^order:[a-f0-9]{64}$/);
 await store.observe(input.id,{botAlias:'default',payerId:'123',currency:'XTR',totalAmount:10,invoicePayload:snapshot.order.invoicePayload,chargeId:'charge-secret',kind:'paid'});
 const again=await f.workflow.execute('draft',input);assert.equal(again.observed_payments,1);
 await assert.rejects(f.workflow.execute('draft',{...input,total_amount:11}),/write_unknown/);
 const status=await f.workflow.execute('status',{id:input.id});assert.equal(status.total_amount,10);assert.equal(status.observed_net_amount,'10');assert.equal(status.checkout_authorized,false);
 const text=JSON.stringify(status);for(const secret of ['payer_id','payerId','invoicePayload','charge-secret'])assert.ok(!text.includes(secret));assert.equal(f.opened,f.closed);
});
test('owner isolation and revoked payer scope prevent order disclosure',async t=>{
 const f=await setup(t);await f.workflow.execute('draft',input);f.env={...f.env,TELEGRAM_PAYMENT_OWNER_ID:'other'};assert.deepEqual(await f.workflow.execute('status',{id:input.id}),{id:input.id,found:false});
 f.env={...f.env,TELEGRAM_PAYMENT_OWNER_ID:'owner',TELEGRAM_PAYMENT_PAYERS_JSON:'{"default":["999"]}'};await assert.rejects(f.workflow.execute('status',{id:input.id}),/target_not_allowed/);
});
test('revocation during opening prevents create and closes resources',async()=>{
 let env=config(),creates=0,closed=0;const w=new PaymentOrderWorkflow(()=>env,async()=>{env={...env,TELEGRAM_PAYMENT_ORDERS_ENABLED:'false'};return {orders:{create:async()=>{creates++}},close:async()=>{closed++}}});await assert.rejects(w.execute('draft',input),/disabled/);assert.equal(creates,0);assert.equal(closed,1);
});
test('lost acknowledgement is resolved by same-ID query without a second order',async t=>{
 const f=await setup(t);const uncertain=new PaymentOrderWorkflow(()=>f.env,async(owner,guard)=>{const r=await f.open(owner,guard);return {...r,orders:{get:r.orders.get.bind(r.orders),create:async o=>{await r.orders.create(o);throw Error('secret-provider-detail')}}}});
 await assert.rejects(uncertain.execute('draft',input),e=>e.message==='payment_order_write_unknown_query_same_id');assert.equal((await f.workflow.execute('status',{id:input.id})).order_recorded,true);assert.equal((await f.workflow.execute('draft',input)).observed_payments,0);
});
test('scope change after a read hides response; close errors cannot invalidate a known result',async t=>{
 const f=await setup(t);await f.workflow.execute('draft',input);
 const changed=new PaymentOrderWorkflow(()=>f.env,async(owner,guard)=>{const r=await f.open(owner,guard);return {...r,orders:{get:async id=>{const s=await r.orders.get(id);f.env={...f.env,TELEGRAM_BOT_TOKEN:'changed'};return s}}}});await assert.rejects(changed.execute('status',{id:input.id}),/configuration_changed/);
 const cleanup=new PaymentOrderWorkflow(()=>f.env,async(owner,guard)=>{const r=await f.open(owner,guard);return {...r,close:async()=>{await r.close();throw Error('cleanup-secret')}}});assert.equal((await cleanup.execute('status',{id:input.id})).order_recorded,true);
});

test('malformed payer input/config is sanitized instead of reaching BigInt conversion errors',async()=>{
 for(const [env,args,expected] of [[config(),{...input,payer_id:'private-invalid'},'payment_order_input_invalid'],[{...config(),TELEGRAM_PAYMENT_PAYERS_JSON:'{"default":["private-invalid"]}'},input,'payment_scope_invalid']]){
  let opens=0;const w=new PaymentOrderWorkflow(()=>env,async()=>{opens++;throw Error('unused')});await assert.rejects(w.execute('draft',args),e=>e.message===expected);assert.equal(opens,0);
 }
});
