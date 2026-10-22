import {manageBot} from "@/lib/telegram/vault/bot-management";
export const runtime="nodejs";
export const maxDuration=30;
export function POST(request:Request){return manageBot(request)}
