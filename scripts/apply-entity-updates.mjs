/**
 * scripts/apply-entity-updates.mjs — thin CLI wrapper around
 * POST /api/meetings/jobs/:id/entity-updates. Applies (or dry-runs) the
 * persisted meeting_analysis_v1 entity_updates of one meeting job; the
 * in-app worker + sweep backfill automatically once
 * MEETING_ENTITY_UPDATES_MODE is enabled, so this is a manual ops tool.
 *
 * Usage (host):
 *   node scripts/apply-entity-updates.mjs <jobId> [--mode dry_run|apply]
 */

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://127.0.0.1:3003';

const args = process.argv.slice(2);
const modeFlag = args.includes('--mode')
  ? args[args.indexOf('--mode') + 1]
  : 'dry_run';
const jobId = args.find((a) => !a.startsWith('--') && a !== modeFlag);

if (!jobId) {
  console.error(
    'usage: node scripts/apply-entity-updates.mjs <jobId> [--mode dry_run|apply]',
  );
  process.exit(1);
}

const res = await fetch(
  `${DASHBOARD_URL}/api/meetings/jobs/${jobId}/entity-updates`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: modeFlag }),
  },
);
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`[apply-entity-updates] HTTP ${res.status}:`, data);
  process.exit(1);
}
console.log(
  `[apply-entity-updates] job ${data.jobId}: ${data.processed} update(s) processed (mode=${data.mode})`,
);
