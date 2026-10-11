/**
 * lib/caldav/sync.js — Read-only CalDAV sync worker (DingTalk-oriented).
 *
 * Single-flight, bounded timeout, never writes to the remote calendar.
 * Connection settings are resolved into an immutable snapshot per sync run
 * (DB override > env > registry default); the mutable global config is never
 * written, so concurrent settings changes cannot corrupt an in-flight sync.
 */

import config, { isCaldavConfigured } from '@/lib/config';
import { normalizeCaldavUrl } from '@/lib/config';
import { getSettings } from '@/lib/settings/resolve';
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
 * Resolve live CalDAV connection settings into an immutable snapshot,
 * normalizing host-only URLs the same way deployment env defaults are.
 * @returns {Promise<{enabled: boolean, url: string, username: string, password: string, calendarUrl: string}>}
 */
export async function resolveCaldavSnapshot() {
  const live = await getSettings([
    'calendar.caldavEnabled',
    'calendar.url',
    'calendar.username',
    'calendar.password',
    'calendar.collectionUrl',
  ]);
  return Object.freeze({
    enabled: Boolean(live['calendar.caldavEnabled']),
    url: normalizeCaldavUrl(
      live['calendar.url'] || 'https://calendar.dingtalk.com/dav/',
    ),
    username: live['calendar.username'] || '',
    password: live['calendar.password'] || '',
    calendarUrl: normalizeCaldavUrl(live['calendar.collectionUrl'] || ''),
  });
}

/** True when a snapshot can drive a sync (enabled + credentials + URL). */
export function isSnapshotConfigured(snapshot) {
  return Boolean(
    snapshot.enabled && snapshot.username && snapshot.password && snapshot.url,
  );
}

/** Live configured check (settings override > env). */
export async function isCaldavConfiguredLive() {
  return isSnapshotConfigured(await resolveCaldavSnapshot());
}

/**
 * Run one full/incremental sync cycle.
 * @param {{ force?: boolean }} [options]
 */
export async function runCaldavSync(options = {}) {
  if (syncing) {
    return { ok: false, skipped: true, reason: 'Sync already in progress' };
  }

  const caldav = await resolveCaldavSnapshot();
  if (!isSnapshotConfigured(caldav)) {
    return {
      ok: false,
      skipped: true,
      reason:
        'CalDAV is not configured (set CALDAV_ENABLED=true and credentials)',
    };
  }

  syncing = true;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.caldavFetchTimeoutMs,
  );

  try {
    await setSyncStatus({ status: 'syncing', error: null });

    const client = await createCaldavClient(caldav, controller.signal);
    const calendars = await listCalendars(caldav, client);
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
        const objects = await fetchAllObjects(caldav, client, calendar);
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
    const message = redactError(error, caldav);
    console.error('[caldav] Sync failed:', message);
    await setSyncStatus({ status: 'error', error: message }).catch(() => {});
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
    syncing = false;
  }
}

export async function getCaldavSyncStatus() {
  const [status, caldav] = await Promise.all([
    getSyncStatus(),
    resolveCaldavSnapshot(),
  ]);
  return {
    ...status,
    configured: isSnapshotConfigured(caldav),
    enabled: caldav.enabled,
    syncing,
  };
}

export function startCaldavSyncWorker() {
  if (intervalId) return;

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
