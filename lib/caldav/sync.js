/**
 * lib/caldav/sync.js — Read-only CalDAV sync worker (DingTalk-oriented).
 *
 * Single-flight, bounded timeout, never writes to the remote calendar.
 */

import config, { isCaldavConfigured } from '@/lib/config';
import {
  createCaldavClient,
  listCalendars,
  fetchAllObjects,
  syncCollectionObjects,
  redactError,
} from './client.js';
import {
  getSyncStatus,
  setSyncStatus,
  upsertSource,
  replaceSourceObjects,
  applyObjectDelta,
  markSourceSynced,
} from './db.js';

let syncing = false;
let intervalId = null;
let firstRunTimer = null;

/**
 * Run one full/incremental sync cycle.
 * @param {{ force?: boolean }} [options]
 */
export async function runCaldavSync(options = {}) {
  if (!isCaldavConfigured()) {
    return {
      ok: false,
      skipped: true,
      reason: 'CalDAV is not configured (set CALDAV_ENABLED=true and credentials)',
    };
  }

  if (syncing) {
    return { ok: false, skipped: true, reason: 'Sync already in progress' };
  }

  syncing = true;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.caldavFetchTimeoutMs,
  );

  try {
    await setSyncStatus({ status: 'syncing', error: null });

    const client = await createCaldavClient(controller.signal);
    const calendars = await listCalendars(client);
    if (!calendars.length) {
      throw new Error('No CalDAV calendars discovered');
    }

    let objectCount = 0;

    for (const calendar of calendars) {
      const source = await upsertSource(calendar);
      const existing = {
        url: source.url,
        syncToken: source.syncToken,
        ctag: source.ctag,
      };

      let usedIncremental = false;
      if (!options.force && existing.syncToken) {
        const delta = await syncCollectionObjects(client, {
          url: existing.url,
          syncToken: existing.syncToken,
        });
        if (delta) {
          usedIncremental = true;
          await applyObjectDelta(source.id, {
            upserts: delta.upserts,
            deletedHrefs: delta.deletedHrefs,
          });
          await markSourceSynced(source.id, {
            syncToken: delta.syncToken,
            ctag: delta.ctag,
          });
          objectCount += delta.upserts.length;
        }
      }

      if (!usedIncremental) {
        const objects = await fetchAllObjects(client, calendar);
        await replaceSourceObjects(source.id, objects);
        // Prefer server-reported tokens from discovery when present.
        await markSourceSynced(source.id, {
          syncToken: calendar.syncToken || source.syncToken,
          ctag: calendar.ctag || source.ctag,
        });
        objectCount += objects.length;
      }
    }

    const syncedAt = new Date();
    await setSyncStatus({ status: 'ok', error: null, syncedAt });
    console.info(
      `[caldav] Sync complete: ${calendars.length} calendar(s), ~${objectCount} object ops`,
    );
    return {
      ok: true,
      calendars: calendars.length,
      objects: objectCount,
      lastSyncAt: syncedAt.toISOString(),
    };
  } catch (error) {
    const message = redactError(error);
    console.error('[caldav] Sync failed:', message);
    await setSyncStatus({ status: 'error', error: message }).catch(() => {});
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
    syncing = false;
  }
}

export async function getCaldavSyncStatus() {
  const status = await getSyncStatus();
  return {
    ...status,
    configured: isCaldavConfigured(),
    enabled: config.caldavEnabled,
    syncing,
  };
}

export function startCaldavSyncWorker() {
  if (intervalId || !isCaldavConfigured()) return;

  const run = () => {
    runCaldavSync().catch((err) => {
      console.error('[caldav] Background sync error:', redactError(err));
    });
  };

  firstRunTimer = setTimeout(run, 30_000);
  intervalId = setInterval(run, config.caldavSyncIntervalMs);
  intervalId.unref?.();
  firstRunTimer.unref?.();
  console.info(
    `[caldav] Worker started (interval ${config.caldavSyncIntervalMs}ms)`,
  );
}

export function stopCaldavSyncWorker() {
  if (firstRunTimer) {
    clearTimeout(firstRunTimer);
    firstRunTimer = null;
  }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
