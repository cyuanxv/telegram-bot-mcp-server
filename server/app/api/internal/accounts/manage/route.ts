import {handleAccountManagement} from '@/lib/telegram/vault/account-management-http';
export const runtime='nodejs';export const maxDuration=60;
export function POST(request:Request){return handleAccountManagement(request)}
