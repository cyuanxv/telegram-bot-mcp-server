import type { TransactionalSql } from "../delivery/postgres-store";
import { decimalId } from "./normalize";
export type AnswerClaim = { key: string; fingerprint: string; sequence: string; createdAt: number };
export type AnswerState = "claimed" | "inflight" | "answered" | "unknown";
export interface CallbackAnswerStore {
 assertReady(): Promise<void>;
 claim(input: AnswerClaim): Promise<AnswerState>;
 settle(key: string, fingerprint: string, state: "answered" | "unknown"): Promise<void>;
}
function hash(value: string) { if (!/^[a-f0-9]{64}$/.test(value)) throw Error("Invalid callback ledger key"); }
export class PostgresCallbackAnswerStore implements CallbackAnswerStore {
 private database: TransactionalSql;
 constructor(database: TransactionalSql) {this.database=database}
 async assertReady() {
  await this.database.transaction(async sql=>{
   const row=(await sql.query("SELECT has_table_privilege(current_user,'public.telegram_callback_answers','SELECT') AND has_table_privilege(current_user,'public.telegram_callback_answers','INSERT') AND has_table_privilege(current_user,'public.telegram_callback_answers','UPDATE') AS ready")).rows[0];
   if(row?.ready!==true)throw Error("Callback ledger permissions missing");
  });
 }
 async claim(input: AnswerClaim): Promise<AnswerState> {
  input=structuredClone(input); hash(input.key);hash(input.fingerprint);decimalId(input.sequence);
  if(!Number.isSafeInteger(input.createdAt)||input.createdAt<0)throw Error("Invalid callback ledger timestamp");
  return this.database.transaction(async sql=>{
   const inserted=await sql.query("INSERT INTO public.telegram_callback_answers(callback_key,request_fingerprint,inbox_sequence,state,created_at) VALUES($1,$2,$3,'inflight',$4) ON CONFLICT(callback_key) DO NOTHING RETURNING callback_key",[input.key,input.fingerprint,input.sequence,input.createdAt]);
   if(inserted.rows.length===1)return "claimed";
   const row=(await sql.query("SELECT request_fingerprint,state FROM public.telegram_callback_answers WHERE callback_key=$1",[input.key])).rows[0];
   if(!row||row.request_fingerprint!==input.fingerprint)throw Error("Callback already claimed with different answer");
   if(!["inflight","answered","unknown"].includes(String(row.state)))throw Error("Invalid callback ledger state");
   return row.state as AnswerState;
  });
 }
 async settle(key: string,fingerprint: string,state: "answered"|"unknown") {
  hash(key);hash(fingerprint);if(!["answered","unknown"].includes(state))throw Error("Invalid callback settlement");
  await this.database.transaction(async sql=>{
   const result=await sql.query("UPDATE public.telegram_callback_answers SET state=$3 WHERE callback_key=$1 AND request_fingerprint=$2 AND state='inflight' RETURNING callback_key",[key,fingerprint,state]);
   if(result.rows.length!==1)throw Error("Callback settlement unavailable");
  });
 }
}
