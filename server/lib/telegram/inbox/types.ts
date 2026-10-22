export const MESSAGE_UPDATE_TYPES = ["message", "edited_message", "channel_post", "edited_channel_post", "business_message", "edited_business_message", "callback_query"] as const;
export type MessageUpdateType = typeof MESSAGE_UPDATE_TYPES[number];
export type InboxEvent = {
  version: 1; botAlias: string; updateId: string; updateType: MessageUpdateType;
  chatId: string; messageId: string; messageDate: number;
  senderId?: string; senderChatId?: string; businessConnectionId?: string;
  callbackQueryId?: string; text?: string; fingerprint: string; receivedAt: number; expiresAt: number;
};
export type InboxRecordResult = "stored" | "duplicate" | "conflict" | "ignored_deleted";
export interface InboxStore {
  record(event: InboxEvent): Promise<InboxRecordResult>;
  list(input: { botAlias: string; chatIds: string[]; businessConnectionIds?: string[]; afterSequence?: string; limit?: number; now: number }): Promise<{ sequence: string; event: InboxEvent }[]>;
  filterBusinessDeleted?(rows: { sequence: string; event: InboxEvent }[]): Promise<{ sequence: string; event: InboxEvent }[]>;
}
export type BotInboxPolicy = { secretToken: string; allowedChatIds: string[]; allowedBusinessConnectionIds?: string[]; retainText: boolean; retentionDays: number; acceptCallbacks?: boolean; acceptDraftStops?: boolean };
export type InboxConfig = { bots: Record<string, BotInboxPolicy> };
