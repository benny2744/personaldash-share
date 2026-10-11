import { NextResponse } from 'next/server';
import { triggerGbrainSyncUrl } from '@/lib/gbrainSync';
import { getIndexerStatus } from '@/lib/indexer';
import { getSyncQueueStatus } from '@/lib/syncWorker';
import { computeGbrainHealth } from '@/lib/gbrainHealth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/gbrain/status — gbrain integration health for the dashboard.
 * Proxies the host trigger service GET :9103/status (jobs, sync failures,
 * stats, last dream run, write_through) and adds the app-side indexer and
 * vault sync-queue state. Never throws; degrades per-section.
 */
export async function GET() {
  let host = { ok: false, error: 'not fetched' };
  try {
    const res = await fetch(triggerGbrainSyncUrl('/status'), {
      signal: AbortSignal.timeout(45000),
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      host = await res.json();
    } else {
      host = { ok: false, error: `HTTP ${res.status}` };
    }
  } catch (err) {
    host = { ok: false, error: err?.message || 'fetch failed' };
  }

  let indexer;
  try {
    indexer = getIndexerStatus();
  } catch (err) {
    indexer = { running: false, initialScanDone: false, error: err?.message || 'unavailable' };
  }

  let syncQueue;
  try {
    syncQueue = getSyncQueueStatus();
  } catch (err) {
    syncQueue = { pending: 0, isPaused: false, error: err?.message || 'unavailable' };
  }

  const payload = {
    host,
    indexer,
    syncQueue,
    retrievalOnly: host?.write_through?.['sync.write_through'] === 'false',
  };
  let health = null;
  try {
    health = computeGbrainHealth(payload);
  } catch {
    health = null;
  }

  return NextResponse.json(
    { ...payload, health },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
