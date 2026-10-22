import { createHash } from 'node:crypto';
import { BUSINESS_RIGHTS } from './business-inspect';
import { decimalId } from './inbox/normalize';
import type { BotInboxPolicy } from './inbox/types';

type ConnectionNotice = { kind: 'connection'; enabled: boolean; connectedAt: number; rights: Record<string, boolean> | null };
type DeletedNotice = { kind: 'deleted'; chatId: string; messageIds: string[] };
export type BusinessNotice = {
  version: 1; botAlias: string; updateId: string; connectionId: string;
  observation: ConnectionNotice | DeletedNotice; receivedAt: number; expiresAt: number; fingerprint: string;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const connection = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v);
function clock(v: unknown): asserts v is number {
  if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > 8_000_000_000_000_000) throw Error('Invalid Business timestamp');
}
function rights(v: unknown): Record<string, boolean> | null {
  if (v === undefined) return null;
  if (!object(v)) throw Error('Invalid Business rights');
  const result: Record<string, boolean> = {};
  for (const name of BUSINESS_RIGHTS) {
    if (Object.hasOwn(v, name) && typeof v[name] !== 'boolean') throw Error('Invalid Business rights');
    result[name] = v[name] === true;
  }
  return result;
}
function fingerprint(e: Pick<BusinessNotice, 'botAlias' | 'updateId' | 'connectionId' | 'observation'>): string {
  const o = e.observation;
  const observation = o.kind === 'deleted' ? { kind: o.kind, chatId: o.chatId, messageIds: o.messageIds } : {
    kind: o.kind, enabled: o.enabled, connectedAt: o.connectedAt,
    rights: o.rights === null ? null : Object.fromEntries(BUSINESS_RIGHTS.map(k => [k, o.rights![k]])),
  };
  return createHash('sha256').update(JSON.stringify({ version: 1, botAlias: e.botAlias, updateId: e.updateId, connectionId: e.connectionId, observation })).digest('hex');
}

/** An authenticated notification, not a current authorization decision. The API's
 * connection date is its creation date, not a permissions revision timestamp. */
export function businessNotice(update: unknown, botAlias: string, policy: BotInboxPolicy, now: number): BusinessNotice | undefined {
  if (!object(update)) throw Error('Invalid Business update');
  const kinds = ['business_connection', 'deleted_business_messages'].filter(k => Object.hasOwn(update, k));
  if (!kinds.length) return undefined;
  // Telegram Update contains at most one update payload. Never consume a mixed envelope.
  if (kinds.length !== 1 || Object.keys(update).some(k => !['update_id', kinds[0]].includes(k))) throw Error('Ambiguous Business update');
  const payload = update[kinds[0]];
  if (!object(payload)) throw Error('Invalid Business notification');
  const id = kinds[0] === 'business_connection' ? payload.id : payload.business_connection_id;
  if (!connection(id)) throw Error('Invalid Business connection');
  if (!policy.allowedBusinessConnectionIds?.includes(id)) return undefined;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(botAlias)) throw Error('Invalid Business bot');
  const updateId = decimalId(update.update_id, 'nonnegative');
  let observation: BusinessNotice['observation'];
  if (kinds[0] === 'business_connection') {
    if (typeof payload.is_enabled !== 'boolean') throw Error('Invalid Business enabled state');
    clock(payload.date);
    // Names, account IDs, private chat IDs and unknown permission fields are not retained.
    observation = { kind: 'connection', enabled: payload.is_enabled, connectedAt: payload.date, rights: rights(payload.rights) };
  } else {
    if (!object(payload.chat)) throw Error('Invalid Business chat');
    const chatId = decimalId(payload.chat.id, 'chat');
    if (!policy.allowedChatIds.includes(chatId)) return undefined;
    if (!Array.isArray(payload.message_ids) || payload.message_ids.length < 1 || payload.message_ids.length > 10000) throw Error('Invalid deleted message IDs');
    const messageIds = payload.message_ids.map(v => decimalId(v));
    if (new Set(messageIds).size !== messageIds.length) throw Error('Duplicate deleted message IDs');
    // The deletion is a set; payload array order cannot create an idempotency conflict.
    messageIds.sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
    observation = { kind: 'deleted', chatId, messageIds };
  }
  clock(now);
  if (!Number.isSafeInteger(policy.retentionDays) || policy.retentionDays < 1 || policy.retentionDays > 30) throw Error('Invalid Business retention');
  const body = { version: 1 as const, botAlias, updateId, connectionId: id, observation };
  return { ...body, receivedAt: now, expiresAt: now + policy.retentionDays * 86400000, fingerprint: fingerprint(body) };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
/** Re-project through the same validation contract before storage. */
export function checkedBusinessNotice(input: BusinessNotice): BusinessNotice {
  if (!object(input) || input.version !== 1 || !object(input.observation) || Object.keys(input).some(k => !['version','botAlias','updateId','connectionId','observation','receivedAt','expiresAt','fingerprint'].includes(k))) throw Error('Invalid stored Business notice');
  const o = input.observation;
  const days = (input.expiresAt - input.receivedAt) / 86400000;
  const payload = o.kind === 'connection' ? { business_connection: { id: input.connectionId, is_enabled: o.enabled, date: o.connectedAt, ...(o.rights === null ? {} : { rights: o.rights }) } }
    : o.kind === 'deleted' ? { deleted_business_messages: { business_connection_id: input.connectionId, chat: { id: o.chatId }, message_ids: o.messageIds } } : undefined;
  if (!payload || typeof input.updateId !== 'string') throw Error('Invalid stored Business observation');
  const result = businessNotice({ update_id: input.updateId, ...payload }, input.botAlias, {
    secretToken: '', allowedBusinessConnectionIds: [input.connectionId], allowedChatIds: o.kind === 'deleted' ? [o.chatId] : [], retainText: false, retentionDays: days,
  }, input.receivedAt);
  if (!result || result.fingerprint !== input.fingerprint || stable(result.observation) !== stable(input.observation)) throw Error('Invalid stored Business fingerprint');
  return result;
}
