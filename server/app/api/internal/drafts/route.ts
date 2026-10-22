import {handleDraftWorkflow} from '@/lib/telegram/draft-http';
export const runtime='nodejs';
export const maxDuration=60;
export function POST(request:Request){return handleDraftWorkflow(request)}
