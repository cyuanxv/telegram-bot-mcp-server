-- Proposal only. No automatic migration, grants, deletion or retention cleanup.
-- These minimal identity markers must outlive inbox/notice TTL to prevent late
-- deliveries resurrecting deleted bodies. Retention is until explicitly approved
-- connection decommissioning; enabling requires approval of this longer retention.
CREATE TABLE public.telegram_business_deletions (
  bot_alias TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at BIGINT NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(bot_alias,connection_id,chat_id,message_id),
  CHECK(bot_alias ~ '^[A-Za-z0-9._-]{1,64}$'),
  CHECK(length(connection_id) BETWEEN 1 AND 256 AND connection_id ~ '^[A-Za-z0-9_-]+$'),
  CHECK(chat_id ~ '^-?[1-9][0-9]{0,18}$'),
  CHECK(message_id ~ '^[1-9][0-9]{0,18}$')
);
ALTER TABLE public.telegram_business_deletions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_business_deletions FROM PUBLIC;
