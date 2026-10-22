import { inboxConfig } from './config';
import { validateBotScope } from '../vault/bot-scope';
type Env = Record<string,string|undefined>;
export function inboxEndpoint(alias: string, env: Env = process.env) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(alias) || alias === '.' || alias === '..') throw new Error('Invalid inbox Bot alias');
  const origin = new URL(env.TELEGRAM_PUBLIC_ORIGIN || 'https://backend.example.invalid');
  if(origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('Invalid public origin');
  return origin.origin + '/api/telegram/webhook/' + encodeURIComponent(alias);
}
function policyFor(alias: string, env: Env) {
  const policies = inboxConfig(env)?.bots;
  const policy = policies && Object.hasOwn(policies,alias) ? policies[alias] : undefined;
  if (!policy) throw new Error('Inbox receiver must be configured before registration');
  return policy;
}
export function inboxRegistrationParameters(alias: string, env: Env) {
  const url = inboxEndpoint(alias,env), policy = policyFor(alias,env);
  return {url, secret_token:policy.secretToken,
    allowed_updates:['message','edited_message','channel_post','edited_channel_post',...(policy.acceptCallbacks===true?['callback_query']:[]),...(policy.acceptDraftStops===true?['stopped_message_generation']:[])], drop_pending_updates:false};
}
/** Internal control channel, never a general Bot API permission. */
export function assertInboxControlRequest(alias: string, method: string, params: Record<string,unknown>, env: Env) {
  inboxEndpoint(alias,env);
  if (method === 'getWebhookInfo' && Object.keys(params).length === 0) return;
  if (method !== 'setWebhook') throw new Error('Inbox control request denied');
  const expected = inboxRegistrationParameters(alias,env);
  if (Object.keys(params).sort().join(',') !== Object.keys(expected).sort().join(',')
    || params.url !== expected.url || params.secret_token !== expected.secret_token || params.drop_pending_updates !== false
    || !Array.isArray(params.allowed_updates) || JSON.stringify(params.allowed_updates) !== JSON.stringify(expected.allowed_updates)) throw new Error('Inbox control request denied');
}
export function assertVaultInboxControl(alias: string, method: string, params: Record<string,unknown>, env: Env, savedPolicy: unknown) {
  const receiver = policyFor(alias,env), policy = validateBotScope(savedPolicy);
  if (receiver.allowedChatIds.some(chat => !policy.chat_ids.includes(chat))) throw new Error('Inbox control scope denied');
  assertInboxControlRequest(alias,method,params,env);
}
