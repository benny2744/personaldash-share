/**
 * lib/dingtalk/db.js — raw pg pool for DingTalk tables.
 * The container's baked Prisma client predates the DingTalk models; until the
 * image is rebuilt these routes use SQL directly (same pattern as the
 * services/dingtalk-bridge collector).
 */

import { createRequire } from 'module';
import config from '@/lib/config';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const globalForDingTalk = globalThis;

export function getPool() {
  if (!globalForDingTalk.__dingtalkPool) {
    globalForDingTalk.__dingtalkPool = new Pool({
      connectionString: config.databaseUrl,
      max: 5,
    });
  }
  return globalForDingTalk.__dingtalkPool;
}

export async function query(text, params) {
  const pool = getPool();
  return pool.query(text, params);
}
