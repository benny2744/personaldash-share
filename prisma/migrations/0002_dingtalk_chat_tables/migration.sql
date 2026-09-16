-- DingTalk chat tables.
--
-- These tables are written by services/dingtalk-bridge (collector/backfill)
-- and read by lib/dingtalk + app/api/dingtalk via raw SQL. They are
-- intentionally NOT in prisma/schema.prisma so Prisma Migrate never touches
-- them; this hand-written migration is applied by `prisma migrate deploy`
-- like any other migration.
--
-- Reconstructed from the live schema (see lib/dingtalk/db.js and
-- services/dingtalk-bridge for all readers/writers).

CREATE TABLE IF NOT EXISTS "dingtalk_conversations" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "open_conversation_id" TEXT NOT NULL,
    "title" TEXT,
    "type" TEXT NOT NULL,
    "member_count" INTEGER,
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dingtalk_conversations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "dingtalk_conversations_open_conversation_id_key"
    ON "dingtalk_conversations"("open_conversation_id");
CREATE INDEX IF NOT EXISTS "idx_dingtalk_conversations_last_message_at"
    ON "dingtalk_conversations"("last_message_at");
CREATE INDEX IF NOT EXISTS "idx_dingtalk_conversations_type"
    ON "dingtalk_conversations"("type");

CREATE TABLE IF NOT EXISTS "dingtalk_messages" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "open_message_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "sender_id" TEXT NOT NULL,
    "sender_name" TEXT NOT NULL,
    "sender_open_dingtalk_id" TEXT,
    "content" TEXT NOT NULL,
    "message_type" TEXT DEFAULT 'text',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recalled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "dingtalk_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dingtalk_messages_conversation_id_fkey"
        FOREIGN KEY ("conversation_id") REFERENCES "dingtalk_conversations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "dingtalk_messages_open_message_id_key"
    ON "dingtalk_messages"("open_message_id");
CREATE INDEX IF NOT EXISTS "idx_dingtalk_messages_conversation_id"
    ON "dingtalk_messages"("conversation_id");
CREATE INDEX IF NOT EXISTS "idx_dingtalk_messages_created_at"
    ON "dingtalk_messages"("created_at");
CREATE INDEX IF NOT EXISTS "idx_dingtalk_messages_sender_id"
    ON "dingtalk_messages"("sender_id");
