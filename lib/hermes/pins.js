/**
 * lib/hermes/pins.js — Server-side persistence for pinned Hermes chat sessions.
 *
 * Pins are scoped per Hermes profile (session ids are only unique within a
 * profile) and ordered by pin time (createdAt), oldest pin first.
 */

import prisma from '@/lib/db';

export async function listPins(profile) {
  const rows = await prisma.hermesSessionPin.findMany({
    where: { profile: profile || '' },
    orderBy: { createdAt: 'asc' },
    select: { sessionId: true, createdAt: true },
  });
  return rows.map((row) => ({
    sessionId: row.sessionId,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function pinSession(profile, sessionId) {
  await prisma.hermesSessionPin.upsert({
    where: {
      profile_sessionId: { profile: profile || '', sessionId },
    },
    create: { profile: profile || '', sessionId },
    // Re-pinning refreshes the pin so the session floats to the top of the
    // pinned group.
    update: { createdAt: new Date() },
  });
}

export async function unpinSession(profile, sessionId) {
  await prisma.hermesSessionPin.deleteMany({
    where: { profile: profile || '', sessionId },
  });
}
