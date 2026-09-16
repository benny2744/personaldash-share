#!/usr/bin/env node
/**
 * DingTalk conversation title enrichment — resolves titles/member counts for
 * conversations that lack them via `dws chat conversation-info`.
 */

import { createRequire } from 'module';
import { spawnSync } from 'child_process';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
// Path to the dws CLI (https://github.com/DingTalk-Real-AI/dingtalk-workspace-tool).
const DWS_PATH = process.env.DWS_PATH || 'dws';

const pool = new Pool({ connectionString: DATABASE_URL });

function dwsJson(args) {
  const result = spawnSync(DWS_PATH, args, { encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

async function main() {
  const { rows } = await pool.query(
    `SELECT open_conversation_id, title, type FROM dingtalk_conversations`,
  );
  console.log(`[enrich] refreshing ${rows.length} conversations`);

  for (const row of rows) {
    const info = dwsJson(['chat', 'conversation-info', '--conversation-id', row.open_conversation_id]);
    const data = info?.result?.conversationInfo || info?.result || info;
    const title = data?.title || data?.name || null;
    const memberCount = data?.memberCount ?? data?.member_count ?? null;
    const type = data?.singleChat === false ? 'group' : data?.singleChat === true ? 'single' : null;
    if (title || type) {
      await pool.query(
        `UPDATE dingtalk_conversations
         SET title = COALESCE($1, title),
             type = COALESCE($2, type),
             member_count = COALESCE($3, member_count),
             updated_at = NOW()
         WHERE open_conversation_id = $4`,
        [title, type, memberCount, row.open_conversation_id],
      );
      console.log(`[enrich] ✓ ${row.open_conversation_id.substring(0, 20)} → ${title} (${type})`);
    } else {
      console.log(`[enrich] ✗ ${row.open_conversation_id.substring(0, 20)} (no info)`);
    }
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('[enrich] Fatal error:', err);
  await pool.end();
  process.exit(1);
});
