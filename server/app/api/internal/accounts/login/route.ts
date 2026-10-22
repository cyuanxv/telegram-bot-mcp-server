import {handleAccountLogin} from '@/lib/telegram/vault/account-login-http';
export const runtime='nodejs';export const maxDuration=60;
export function POST(request:Request){return handleAccountLogin(request)}
