/**
 * lib/gbrain/db.js — read-only pg pool for the gbrain Postgres.
 *
 * The app never execs the gbrain CLI and never writes to this database; the
 * workdash_ro role only has SELECT on public.pages and public.content_chunks.
 * Used by lib/gbrain/search.js for semantic vault search (see the GBrain
 * Integration Contract in AGENTS.md — retrieval-only).
 */

import { createRequire } from 'module';
import config from '@/lib/config';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const globalForGbrain = globalThis;

export function isGbrainSearchConfigured() {
  return Boolean(config.gbrainDatabaseUrl);
}

export function getGbrainPool() {
  if (!globalForGbrain.__gbrainReadPool) {
    globalForGbrain.__gbrainReadPool = new Pool({
      connectionString: config.gbrainDatabaseUrl,
      max: 3,
    });
  }
  return globalForGbrain.__gbrainReadPool;
}

export async function gbrainQuery(text, params) {
  if (!isGbrainSearchConfigured()) return { rows: [] };
  const pool = getGbrainPool();
  return pool.query(text, params);
}
