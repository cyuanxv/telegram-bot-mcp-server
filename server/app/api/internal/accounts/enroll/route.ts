import {handleAccountEnrollment} from '@/lib/telegram/vault/account-enrollment-http';
export const runtime='nodejs';
export const maxDuration=60;
export function POST(request:Request){return handleAccountEnrollment(request)}
