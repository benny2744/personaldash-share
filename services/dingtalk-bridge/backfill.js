#!/usr/bin/env node
/**
 * DingTalk history backfill — pulls recent messages via dws chat message list-all
 * and upserts into the database using raw SQL (since Prisma client is out of sync).
 */

import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import { parseDwsTime, formatDwsDate } from './dwsTime.js';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
// Path to the dws CLI (https://github.com/DingTalk-Real-AI/dingtalk-workspace-tool).
const DWS_PATH = process.env.DWS_PATH || 'dws';
const DAYS_BACK = parseInt(process.env.DAYS_BACK || '90');

const pool = new Pool({ connectionString: DATABASE_URL });

function runDws(args) {
  const result = spawnSync(DWS_PATH, args, {
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`dws error: ${result.stderr}`);
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    console.error(`Parse error: ${e.message}`);
    return null;
  }
}

async function upsertConversation(
  client,
  openConversationId,
  type,
  title = null,
) {
  const result = await client.query(
    `
    INSERT INTO dingtalk_conversations (open_conversation_id, type, title, last_message_at, updated_at)
    VALUES ($1, $2, $3, NOW(), NOW())
    ON CONFLICT (open_conversation_id) DO UPDATE SET last_message_at = NOW(), updated_at = NOW()
    RETURNING id
  `,
    [openConversationId, type, title],
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
      msg.senderId || msg.senderOpenDingTalkId || 'unknown',
      msg.senderName || msg.sender || 'Unknown',
      msg.senderOpenDingTalkId || null,
      msg.content || msg.text || '',
      msg.messageType || 'text',
      parseDwsTime(msg.createTime),
    ],
  );
}

async function main() {
  console.log(`[backfill] Pulling messages from last ${DAYS_BACK} days...`);

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - DAYS_BACK);

  const startIso = formatDwsDate(startDate);
  const endIso = formatDwsDate(endDate);

  console.log(`[backfill] Range: ${startIso} to ${endIso}`);

  const result = runDws([
    'chat',
    'message',
    'list-all',
    '--start',
    startIso,
    '--end',
    endIso,
    '--page-all',
    '--page-limit',
    '100',
    '--max-items',
    '0',
    '--page-delay',
    '200',
  ]);

  if (!result || !result.result?.conversationMessagesList) {
    console.error('[backfill] No messages returned');
    await pool.end();
    return;
  }

  const conversations = result.result.conversationMessagesList;
  console.log(
    `[backfill] Found ${conversations.length} conversations with messages`,
  );

  const client = await pool.connect();
  let messageCount = 0;

  try {
    for (const conv of conversations) {
      const messages = conv.messages || [];
      if (messages.length === 0) continue;

      const firstMsg = messages[0];
      const convType = firstMsg.conversationType || 'single';
      const convTitle = firstMsg.conversationTitle || null;

      const conversationId = await upsertConversation(
        client,
        firstMsg.openConversationId,
        convType,
        convTitle,
      );

      for (const msg of messages) {
        await upsertMessage(client, msg, conversationId);
        messageCount++;
      }

      console.log(
        `[backfill] ✓ ${convTitle || firstMsg.openConversationId.substring(0, 20)}: ${messages.length} messages`,
      );
    }
  } finally {
    client.release();
  }

  console.log(
    `[backfill] Done. Total: ${messageCount} messages from ${conversations.length} conversations`,
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error('[backfill] Fatal error:', err);
  await pool.end();
  process.exit(1);
});
