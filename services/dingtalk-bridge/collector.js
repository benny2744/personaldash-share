#!/usr/bin/env node
/**
 * DingTalk live-ish message collector.
 *
 * The dws `event consume` / `+listen-im` event bus is fragile under systemd
 * (bus child startup failures, stale locks, and consumer RPC timeouts), so this
 * collector polls `dws chat message list-all` on a short interval instead.
 * Messages are upserted idempotently; old messages are never deleted.
 */

import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import { parseDwsTime, formatDwsDate } from './dwsTime.js';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[collector] DATABASE_URL is required');
  process.exit(1);
}
// Path to the dws CLI (https://github.com/DingTalk-Real-AI/dingtalk-workspace-tool).
const DWS_PATH = process.env.DWS_PATH || 'dws';
const POLL_INTERVAL_MS = Math.max(
  5000,
  parseInt(process.env.POLL_INTERVAL_MS || '30000', 10),
);
const LOOKBACK_WINDOW_MS = Math.max(
  0,
  parseInt(process.env.LOOKBACK_WINDOW_MS || '60000', 10),
);

const pool = new Pool({ connectionString: DATABASE_URL });

function runDws(args) {
  const result = spawnSync(DWS_PATH, args, {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`[collector] dws error: ${result.stderr}`);
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    console.error(`[collector] Parse error: ${e.message}`);
    return null;
  }
}

async function upsertConversation(
  client,
  openConversationId,
  type,
  title = null,
  lastMessageAt = null,
) {
  const result = await client.query(
    `
    INSERT INTO dingtalk_conversations (open_conversation_id, type, title, last_message_at, updated_at)
    VALUES ($1, $2, $3, COALESCE($4, NOW()), NOW())
    ON CONFLICT (open_conversation_id) DO UPDATE SET
      title = COALESCE(EXCLUDED.title, dingtalk_conversations.title),
      last_message_at = GREATEST(dingtalk_conversations.last_message_at, EXCLUDED.last_message_at),
      updated_at = NOW()
    RETURNING id
  `,
    [openConversationId, type, title, lastMessageAt],
  );
  return result.rows[0].id;
}

async function upsertMessage(client, msg, conversationId) {
  await client.query(
    `
    INSERT INTO dingtalk_messages (open_message_id, conversation_id, sender_id, sender_name, sender_open_dingtalk_id, content, message_type, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (open_message_id) DO NOTHING
  `,
    [
      msg.openMessageId,
      conversationId,
      msg.senderId,
      msg.senderName,
      msg.senderOpenDingTalkId,
      msg.content,
      msg.messageType,
      msg.createdAt,
    ],
  );
}

async function pollOnce(startDate, endDate) {
  console.log(
    `[collector] Polling ${formatDwsDate(startDate)} → ${formatDwsDate(endDate)}`,
  );

  const result = runDws([
    'chat',
    'message',
    'list-all',
    '--start',
    formatDwsDate(startDate),
    '--end',
    formatDwsDate(endDate),
    '--page-all',
    '--page-limit',
    '100',
    '--max-items',
    '0',
    '--page-delay',
    '200',
  ]);

  if (!result || !result.result?.conversationMessagesList) {
    console.log('[collector] No messages returned');
    return 0;
  }

  const conversations = result.result.conversationMessagesList;
  let messageCount = 0;

  const client = await pool.connect();
  try {
    for (const conv of conversations) {
      const messages = conv.messages || [];
      if (messages.length === 0) continue;

      const firstMsg = messages[0];
      const convType = firstMsg.conversationType || 'single';
      const convTitle = firstMsg.conversationTitle || null;
      const lastMessageAt = messages[messages.length - 1]?.createTime
        ? parseDwsTime(messages[messages.length - 1].createTime)
        : null;

      const conversationId = await upsertConversation(
        client,
        firstMsg.openConversationId,
        convType,
        convTitle,
        lastMessageAt,
      );

      for (const msg of messages) {
        const normalized = {
          openMessageId: msg.openMessageId,
          senderId: msg.senderId || msg.senderStaffId || 'unknown',
          senderName: msg.senderName || msg.sender || 'Unknown',
          senderOpenDingTalkId: msg.senderOpenDingTalkId || null,
          content: msg.content || msg.text || '',
          messageType: msg.messageType || 'text',
          createdAt: parseDwsTime(msg.createTime),
        };
        await upsertMessage(client, normalized, conversationId);
        messageCount++;
      }

      console.log(
        `[collector] ✓ ${convTitle || firstMsg.openConversationId.substring(0, 20)}: ${messages.length} messages`,
      );
    }
  } finally {
    client.release();
  }

  console.log(
    `[collector] Done. Total: ${messageCount} messages from ${conversations.length} conversations`,
  );
  return messageCount;
}

async function main() {
  console.log(
    `[collector] DingTalk poll collector starting (interval: ${POLL_INTERVAL_MS}ms)`,
  );

  // Start slightly in the past so the first poll catches recent messages even
  // if the service just started.
  let lastPollEnd = new Date(Date.now() - LOOKBACK_WINDOW_MS);

  while (true) {
    const now = new Date();
    const start = new Date(Math.max(lastPollEnd.getTime() - 5000, 0));
    try {
      await pollOnce(start, now);
      lastPollEnd = now;
    } catch (error) {
      console.error('[collector] Poll failed:', error.message || error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

process.on('SIGINT', async () => {
  console.log('[collector] Shutting down...');
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[collector] Shutting down...');
  await pool.end();
  process.exit(0);
});

main().catch((err) => {
  console.error('[collector] Fatal error:', err);
  process.exit(1);
});
