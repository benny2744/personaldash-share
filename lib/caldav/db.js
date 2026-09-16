/**
 * lib/caldav/db.js — Prisma helpers for CalDAV cache + sync status.
 */

import prisma from '@/lib/db';
import { extractObjectSummary } from './parse.js';

export const CALDAV_SYNC_KEY = 'dingtalk';

export async function getSyncStatus() {
  const row = await prisma.calDavSyncState.findUnique({
    where: { key: CALDAV_SYNC_KEY },
  });
  const sourceCount = await prisma.calDavSource.count();
  const objectCount = await prisma.calDavObject.count();
  return {
    key: CALDAV_SYNC_KEY,
    lastSyncAt: row?.lastSyncAt?.toISOString() || null,
    lastSyncError: row?.lastSyncError || null,
    lastStatus: row?.lastStatus || 'idle',
    sourceCount,
    objectCount,
  };
}

export async function setSyncStatus({ status, error = null, syncedAt = null }) {
  return prisma.calDavSyncState.upsert({
    where: { key: CALDAV_SYNC_KEY },
    create: {
      key: CALDAV_SYNC_KEY,
      lastStatus: status,
      lastSyncError: error,
      lastSyncAt: syncedAt,
    },
    update: {
      lastStatus: status,
      lastSyncError: error,
      ...(syncedAt ? { lastSyncAt: syncedAt } : {}),
    },
  });
}

/**
 * Upsert a discovered calendar collection.
 * @param {{ url: string, displayName?: string|null, ctag?: string|null, syncToken?: string|null }} calendar
 */
export async function upsertSource(calendar) {
  const ctag =
    calendar.ctag == null || calendar.ctag === ''
      ? null
      : String(calendar.ctag);
  const syncToken =
    calendar.syncToken == null || calendar.syncToken === ''
      ? null
      : String(calendar.syncToken);

  return prisma.calDavSource.upsert({
    where: { url: calendar.url },
    create: {
      url: calendar.url,
      displayName: calendar.displayName || null,
      ctag,
      syncToken,
      enabled: true,
    },
    update: {
      displayName: calendar.displayName || null,
      ctag: ctag ?? undefined,
      syncToken: syncToken ?? undefined,
      enabled: true,
    },
  });
}

/**
 * Replace or update calendar objects for a source (full sync).
 * @param {string} sourceId
 * @param {Array<{ href: string, etag: string|null, data: string }>} objects
 */
export async function replaceSourceObjects(sourceId, objects) {
  const hrefs = objects.map((o) => o.href);

  await prisma.$transaction(async (tx) => {
    if (hrefs.length === 0) {
      await tx.calDavObject.deleteMany({ where: { sourceId } });
      return;
    }

    await tx.calDavObject.deleteMany({
      where: {
        sourceId,
        href: { notIn: hrefs },
      },
    });

    for (const obj of objects) {
      const summary = extractObjectSummary(obj.data);
      await tx.calDavObject.upsert({
        where: {
          sourceId_href: { sourceId, href: obj.href },
        },
        create: {
          sourceId,
          href: obj.href,
          etag: obj.etag,
          rawIcal: obj.data,
          ...summary,
        },
        update: {
          etag: obj.etag,
          rawIcal: obj.data,
          ...summary,
        },
      });
    }
  });
}

/**
 * Apply incremental upserts/deletes for a source.
 */
export async function applyObjectDelta(sourceId, { upserts = [], deletedHrefs = [] }) {
  await prisma.$transaction(async (tx) => {
    if (deletedHrefs.length) {
      await tx.calDavObject.deleteMany({
        where: { sourceId, href: { in: deletedHrefs } },
      });
    }

    for (const obj of upserts) {
      const summary = extractObjectSummary(obj.data);
      await tx.calDavObject.upsert({
        where: {
          sourceId_href: { sourceId, href: obj.href },
        },
        create: {
          sourceId,
          href: obj.href,
          etag: obj.etag,
          rawIcal: obj.data,
          ...summary,
        },
        update: {
          etag: obj.etag,
          rawIcal: obj.data,
          ...summary,
        },
      });
    }
  });
}

export async function markSourceSynced(sourceId, { syncToken, ctag, error = null }) {
  return prisma.calDavSource.update({
    where: { id: sourceId },
    data: {
      syncToken:
        syncToken == null || syncToken === ''
          ? undefined
          : String(syncToken),
      ctag: ctag == null || ctag === '' ? undefined : String(ctag),
      lastSyncAt: new Date(),
      lastSyncError: error,
    },
  });
}

export async function listEnabledSources() {
  return prisma.calDavSource.findMany({
    where: { enabled: true },
    orderBy: { displayName: 'asc' },
  });
}

/**
 * Load cached objects that might overlap a date range.
 * Recurring masters may have startAt outside the window, so we also include
 * objects with null endAt or startAt before rangeEnd (broad filter), then
 * expand precisely in memory.
 *
 * @param {Date} rangeStart
 * @param {Date} rangeEnd
 */
export async function loadObjectsForRange(rangeStart, rangeEnd) {
  // Broad prefilter: include anything that started before rangeEnd and either
  // has no end, ends after rangeStart, or looks like it might recur (we keep
  // all objects with raw ICS and filter after expansion). For simplicity and
  // correctness with RRULEs, load all objects for enabled sources when the
  // cache is small; otherwise filter by startAt < rangeEnd.
  const sources = await prisma.calDavSource.findMany({
    where: { enabled: true },
    select: { id: true },
  });
  if (!sources.length) return [];

  const sourceIds = sources.map((s) => s.id);
  const count = await prisma.calDavObject.count({
    where: { sourceId: { in: sourceIds } },
  });

  const include = {
    source: { select: { id: true, displayName: true, url: true } },
  };

  if (count <= 2000) {
    return prisma.calDavObject.findMany({
      where: { sourceId: { in: sourceIds } },
      include,
    });
  }

  return prisma.calDavObject.findMany({
    where: {
      sourceId: { in: sourceIds },
      OR: [
        { startAt: null },
        { startAt: { lt: rangeEnd } },
      ],
    },
    include,
  });
}
