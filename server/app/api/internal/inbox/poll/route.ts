import {handlePolling} from '@/lib/telegram/inbox/polling-http';
export const runtime='nodejs';
export const maxDuration=60;
export function POST(request:Request){return handlePolling(request)}
