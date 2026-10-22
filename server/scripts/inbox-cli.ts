import { planInboxRetention } from "../lib/telegram/inbox/retention-plan";
import { readInboxForCli } from "../lib/telegram/inbox/cli-read";
async function main() {
  if (!["list", "plan-retention"].includes(process.argv[2])) {
    console.log("Inbox CLI: list reads approved scope {botAlias, chatIds?, afterSequence?, limit?}; plan-retention accepts {botAlias} and prints review-only SQL without database access. No apply, send, purge or webhook registration command is exposed."); return;
  }
  let bytes = 0; const parts: Buffer[] = [];
  for await (const chunk of process.stdin) { const part = Buffer.from(chunk); bytes += part.length; if (bytes > 65536) throw new Error("Inbox read input exceeds 64 KiB"); parts.push(part); }
  let input: Record<string, unknown>;
  try { input = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new Error("Provide a JSON scope object on stdin"); }
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["botAlias", "chatIds", "afterSequence", "limit"].includes(key)) || typeof input.botAlias !== "string") throw new Error("Invalid inbox scope input");
  if (process.argv[2] === 'plan-retention') {
    if (Object.keys(input).some(key => key !== 'botAlias')) throw new Error('Retention plan accepts only botAlias');
    console.log(JSON.stringify(planInboxRetention(input.botAlias))); return;
  }
  console.log(JSON.stringify(await readInboxForCli(input)));
}
main().catch(() => { console.error(JSON.stringify({ error: "Inbox command failed; verify input, read flags, approved scope and connection state" })); process.exitCode = 1; });
