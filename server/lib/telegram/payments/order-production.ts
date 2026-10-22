import { Pool } from 'pg';
import { PgPoolDatabase } from '../delivery/pg-pool-adapter';
import { postgresConnectionConfig } from '../delivery/postgres-config';
import { PostgresPaymentOrders } from './postgres-orders';
import { PaymentOrderWorkflow } from './order-workflow';
export const paymentOrders = new PaymentOrderWorkflow(() => process.env, async (owner, guard) => {
  guard(); const pool = new Pool(postgresConnectionConfig(process.env));
  pool.on('error', () => {});
  return { orders: new PostgresPaymentOrders(new PgPoolDatabase(pool, { guard }), owner), close: async () => { await pool.end(); } };
});
