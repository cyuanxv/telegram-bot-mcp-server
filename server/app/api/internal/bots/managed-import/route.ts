import {handleManagedImport} from '@/lib/telegram/vault/managed-import-http';
export const runtime='nodejs';
export const maxDuration=30;
export function POST(request:Request){return handleManagedImport(request)}
