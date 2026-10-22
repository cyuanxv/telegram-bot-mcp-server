import {receiveRichEvent} from '@/lib/telegram/rich-events';
import { receiveDraftStop } from '@/lib/telegram/draft-stop-receiver';
import { DraftSessions } from '@/lib/telegram/draft-sessions';
import { businessNoticeEnabled } from '@/lib/telegram/business-notice-config';
import { businessDeletionGate } from '@/lib/telegram/business-deletions';
import { receiveBusinessNotice } from '@/lib/telegram/business-notice-receiver';
import { BusinessNoticeStore } from '@/lib/telegram/business-notice-store';
import { authorizeInboxBot } from "@/lib/telegram/inbox/vault-access";
import { receivePayment } from "@/lib/telegram/payments/receiver";
import { PostgresPaymentOrders } from "@/lib/telegram/payments/postgres-orders";
import { Pool } from "pg";
import { PgPoolDatabase } from "@/lib/telegram/delivery/pg-pool-adapter";
import { postgresConnectionConfig } from "@/lib/telegram/delivery/postgres-config";
import { inboxConfig, inboxPolicyGuard } from "@/lib/telegram/inbox/config";
import { PostgresInboxStore } from "@/lib/telegram/inbox/postgres-inbox";
import { handleWebhook } from "@/lib/telegram/inbox/receiver";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ bot: string }> }) {
  let config; try { config = inboxConfig(process.env); }
  catch { return Response.json({ ok: false, status: "receiver_unconfigured" }, { status: 503 }); }
  const bot = (await context.params).bot;
  const guardReceiver = inboxPolicyGuard(() => process.env, bot, config?.bots[bot], request.signal);
  return handleWebhook(request, bot, config, async () => {
    guardReceiver();
    const pool = new Pool(postgresConnectionConfig(process.env));
    pool.on("error", () => { /* Do not log sensitive provider details or incoming payloads. */ });
    return { store: new PostgresInboxStore(new PgPoolDatabase(pool, { guard: guardReceiver }), authorizeInboxBot(),businessDeletionGate()), close: async () => { try { await pool.end(); } catch { /* sanitized by receiver */ } } };
  }, Date.now(), async update => {
    const rich = await receiveRichEvent(update,bot,config?.bots[bot]);
    if(rich)return rich;
    const stopped = await receiveDraftStop(update, bot, config?.bots[bot], () => process.env, async guard => {
      const combinedGuard = () => { guardReceiver(); guard(); };
      combinedGuard(); const pool = new Pool(postgresConnectionConfig(process.env));
      pool.on('error', () => {});
      return { sessions: new DraftSessions(new PgPoolDatabase(pool, { guard: combinedGuard })), close: () => pool.end() };
    });
    if (stopped) return stopped;
    // No implicit subscription: both the exact bot and connection IDs must be approved.
    const enabled = () => businessNoticeEnabled(bot,process.env);
    const notice = await receiveBusinessNotice(update, bot, config?.bots[bot], enabled, async guard => {
      const combinedGuard = () => { guardReceiver(); guard(); };
      combinedGuard(); const pool = new Pool(postgresConnectionConfig(process.env));
      pool.on('error', () => {});
      return { store: new BusinessNoticeStore(new PgPoolDatabase(pool, { guard: combinedGuard }),businessDeletionGate()), close: () => pool.end() };
    });
    if (notice) return notice;
    return receivePayment(update, bot, () => process.env, async (owner, guard) => {
    const combinedGuard = () => { guardReceiver(); guard(); };
    combinedGuard(); const pool = new Pool(postgresConnectionConfig(process.env));
    pool.on("error", () => {});
    return { orders: new PostgresPaymentOrders(new PgPoolDatabase(pool, { guard: combinedGuard }), owner), close: async () => { try { await pool.end(); } catch {} } };
  });
  }, guardReceiver);
}
