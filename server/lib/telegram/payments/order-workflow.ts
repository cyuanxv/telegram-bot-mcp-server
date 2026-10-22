import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getBots } from '../config';
import { paymentSummary, type PaymentOrder, type PaymentSnapshot } from './reconcile';
import type { PostgresPaymentOrders } from './postgres-orders';

type Env = Record<string, string | undefined>;
type Resource = { orders: Pick<PostgresPaymentOrders, 'create' | 'get'>; close(): Promise<void> };
export type OpenOrders = (owner: string, guard: () => void) => Promise<Resource>;
const orderId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const payerId = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(v => /^[1-9][0-9]{0,15}$/.test(v) && BigInt(v) <= 9007199254740991n);
export const draftPaymentOrderSchema = z.object({
  id: orderId, bot_alias: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), payer_id: payerId,
  currency: z.string().regex(/^[A-Z]{3}$/), total_amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), recurring: z.boolean(),
}).strict();
export const paymentOrderStatusSchema = z.object({ id: orderId }).strict();
const keys = ['TELEGRAM_PAYMENT_ORDERS_ENABLED', 'TELEGRAM_PAYMENT_OWNER_ID', 'TELEGRAM_PAYMENT_PAYERS_JSON', 'TELEGRAM_BOTS_JSON', 'TELEGRAM_BOT_TOKEN'] as const;
class OrderError extends Error {}
function fail(code: string): never { throw new OrderError(code); }
function authorized(env: Env, bot: string, payer: string) {
  let scopes: unknown;
  try { scopes = JSON.parse(env.TELEGRAM_PAYMENT_PAYERS_JSON ?? 'null'); } catch { fail('payment_scope_invalid'); }
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes) || !Object.hasOwn(scopes, bot)) fail('payment_target_not_allowed');
  const allowed = (scopes as Record<string, unknown>)[bot];
  if (!Array.isArray(allowed) || !allowed.length || allowed.length > 100 || allowed.some(v => !payerId.safeParse(v).success)) fail('payment_scope_invalid');
  if (!allowed.includes(payer)) fail('payment_target_not_allowed');
  // Vault Bot activation does not silently grant payment rights. Static Bots only until a payment scope exists.
  try { if (!Object.hasOwn(getBots(env), bot)) fail('payment_target_not_allowed'); }
  catch { fail('payment_target_not_allowed'); }
}
function publicOrder(snapshot: PaymentSnapshot) {
  const summary = paymentSummary(snapshot), o = snapshot.order;
  return { id: o.id, bot_alias: o.botAlias, total_amount: o.totalAmount, recurring: o.recurring,
    ...summary, order_recorded: true, invoice_sent_by_this_operation: false, checkout_authorized: false };
}
/** Owner is server configured. This workflow only stores/reads orders; no Telegram transport. */
export class PaymentOrderWorkflow {
  private env: () => Env; private open: OpenOrders;
  constructor(env: () => Env, open: OpenOrders) { this.env = env; this.open = open; }
  async execute(action: 'draft' | 'status', supplied: unknown, signal?: AbortSignal) {
    const initial = { ...this.env() };
    const guard = () => {
      if (signal?.aborted) fail('payment_request_cancelled');
      const now = this.env();
      if (now.TELEGRAM_PAYMENT_ORDERS_ENABLED !== 'true') fail('payment_orders_disabled');
      if (keys.some(k => now[k] !== initial[k])) fail('payment_configuration_changed');
    };
    guard();
    const owner = initial.TELEGRAM_PAYMENT_OWNER_ID;
    if (!owner?.trim() || owner.length > 128) fail('payment_owner_unconfigured');
    const parsed = (action === 'draft' ? draftPaymentOrderSchema : paymentOrderStatusSchema).safeParse(supplied);
    if (!parsed.success) fail('payment_order_input_invalid');
    const input = parsed.data;
    let order: PaymentOrder | undefined;
    if (action === 'draft') {
      const a = draftPaymentOrderSchema.parse(input);
      authorized(initial, a.bot_alias, a.payer_id);
      // Stable across retries and independent of mutable amount; storage rejects conflicting reuse of the ID.
      const payload = 'order:' + createHash('sha256').update(JSON.stringify([owner, a.id])).digest('hex');
      order = { id: a.id, botAlias: a.bot_alias, payerId: a.payer_id, currency: a.currency, totalAmount: a.total_amount, recurring: a.recurring, invoicePayload: payload };
    }
    let resource: Resource | undefined;
    try {
      guard(); resource = await this.open(owner, guard); guard();
      const snapshot = order ? await resource.orders.create(order) : await resource.orders.get(input.id);
      guard();
      if (!snapshot) return { id: input.id, found: false };
      if (snapshot.order.id !== input.id) fail('payment_order_identity_mismatch');
      authorized(this.env(), snapshot.order.botAlias, snapshot.order.payerId);
      const result = publicOrder(snapshot); guard(); return result;
    } catch (error) {
      if (error instanceof OrderError) throw error;
      // A lost COMMIT acknowledgement may follow a successful write. Query this ID; never create a new ID as retry.
      fail(order ? 'payment_order_write_unknown_query_same_id' : 'payment_order_storage_unavailable');
    } finally { try { await resource?.close(); } catch {} }
  }
}
