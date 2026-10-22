import { callBotApi } from "./bot-api";

// Official BusinessBotRights fields. Unknown future fields are not projected.
export const BUSINESS_RIGHTS = [
  "can_reply", "can_read_messages", "can_delete_sent_messages", "can_delete_all_messages",
  "can_edit_name", "can_edit_bio", "can_edit_profile_photo", "can_edit_username",
  "can_change_gift_settings", "can_view_gifts_and_stars", "can_convert_gifts_to_stars",
  "can_transfer_and_upgrade_gifts", "can_transfer_stars", "can_manage_stories",
] as const;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export async function inspectBusinessConnection(botAlias: string, connectionId: string, signal?: AbortSignal) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(botAlias) || !/^[A-Za-z0-9_-]{1,256}$/.test(connectionId)) throw Error("Invalid Business inspection arguments");
  const response = await callBotApi(botAlias, "getBusinessConnection", { business_connection_id: connectionId }, {}, { signal });
  const value: unknown = response.result;
  if (response.bot !== botAlias || !record(value) || value.id !== connectionId || typeof value.is_enabled !== "boolean" || !Number.isSafeInteger(value.date) || (value.date as number) < 0) throw Error("Invalid Business connection response");
  const rights = value.rights;
  if (rights !== undefined && !record(rights)) throw Error("Invalid Business rights response");
  const projected: Record<string, boolean | null> = {};
  for (const field of BUSINESS_RIGHTS) {
    if (record(rights) && Object.hasOwn(rights, field) && typeof rights[field] !== "boolean") throw Error("Invalid Business rights response");
    // Whole rights object omitted: unknown. An absent optional flag inside a supplied object is not granted.
    projected[field] = rights === undefined ? null : rights[field] === true;
  }
  return {
    bot_alias: botAlias, business_connection_id: connectionId,
    is_enabled: value.is_enabled, connected_at: value.date,
    rights_available: rights !== undefined, rights: projected,
    // A granted flag does not establish availability for any particular recipient.
    can_reply_requires_recent_incoming_message: true,
    can_read_messages_means_mark_as_read: true,
    message_history_access_verified: false,
    sent: false,
  };
}
