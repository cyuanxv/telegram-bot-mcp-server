import { runDeliveryWorker } from "@/lib/telegram/automation/delivery-worker";
import { WorkflowMcp } from "@/lib/telegram/workflow-mcp";
export const runtime = "nodejs";
export const maxDuration = 60;
const workflow = new WorkflowMcp();
function run(request: Request) { return runDeliveryWorker(request, () => process.env, workflow); }
export { run as GET, run as POST };
