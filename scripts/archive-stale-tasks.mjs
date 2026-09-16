#!/usr/bin/env node

/**
 * scripts/archive-stale-tasks.mjs — One-off backfill that archives tasks whose
 * `updatedAt` is older than 30 days (statuses: Done / Proposed / Todo, plus any
 * null/empty-status rows). Mirrors the recurring worker in lib/autoArchiver.js.
 *
 * Usage:
 *   node scripts/archive-stale-tasks.mjs --dry-run   # preview count + sample
 *   node scripts/archive-stale-tasks.mjs             # perform the archive
 */

import { config } from 'dotenv';
import { resolve } from 'node:path';

// Load env + flag the runtime so the Prisma proxy in lib/db.js initialises.
config({ path: resolve(process.cwd(), '.env') });
process.env.NEXT_RUNTIME = 'nodejs';

const DRY_RUN = process.argv.includes('--dry-run');

const { archiveStaleTasks, STALE_DAYS } =
  await import('../lib/autoArchiver.js');

const result = await archiveStaleTasks({ dryRun: DRY_RUN });

const label = DRY_RUN ? 'DRY RUN — would archive' : 'Archived';
console.log(
  `[auto-archive] ${label} ${result.skipped || result.archived} stale task(s) (updatedAt > ${STALE_DAYS}d).`,
);
if (result.conflicts)
  console.log(`[auto-archive] conflicts: ${result.conflicts}`);
if (result.failed) console.log(`[auto-archive] failed: ${result.failed}`);

const sample = result.filepaths.slice(0, 10);
if (sample.length > 0) {
  console.log('[auto-archive] sample filepaths:');
  for (const filepath of sample) console.log(`  - ${filepath}`);
  if (result.filepaths.length > sample.length) {
    console.log(`  ...and ${result.filepaths.length - sample.length} more`);
  }
}

process.exit(result.failed > 0 ? 1 : 0);
