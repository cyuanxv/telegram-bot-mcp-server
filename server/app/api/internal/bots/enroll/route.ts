import { enrollBot } from "@/lib/telegram/vault/bot-enrollment";
export const runtime = "nodejs";
export const maxDuration = 30;
export function POST(request: Request) { return enrollBot(request); }
