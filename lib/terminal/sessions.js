/**
 * lib/terminal/sessions.js — session service layer for the web terminal app
 * tier: target listing, session create/refresh/close, limits enforcement.
 * Authorization lives in authz.js; leases in lease.js; the sidecar owns the
 * SSH connection itself.
 *
 * Errors: throws httpError(message, status); routes map to NextResponse.
 */

import { randomBytes } from 'node:crypto';
import prisma from '@/lib/db';
import { getSetting } from '@/lib/settings/resolve';
import { canAccessHost, filterHostsForIdentity } from '@/lib/terminal/authz';
import { isTerminalAdmin, resolveTerminalIdentity } from '@/lib/terminal/identity';
import { issueTerminalLease } from '@/lib/terminal/lease';
import { httpError } from '@/lib/terminal/errors';
import { terminalAudit } from '@/lib/terminal/audit';

const SESSION_ID_BYTES = 24;

function intSetting(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

/**
 * Read terminal limits from settings (DB > env > registry default).
 * Called per session create so hot-scope edits apply immediately.
 */
export async function getTerminalLimits() {
  const [
    enabled,
    maxSessionsPerIdentity,
    idleTimeoutSeconds,
    maxSessionSeconds,
    graceSeconds,
    leaseTtlSeconds,
  ] = await Promise.all([
    getSetting('terminal.enabled'),
    getSetting('terminal.maxSessionsPerIdentity'),
    getSetting('terminal.idleTimeoutSeconds'),
    getSetting('terminal.maxSessionSeconds'),
    getSetting('terminal.graceSeconds'),
    getSetting('terminal.leaseTtlSeconds'),
  ]);
  return {
    enabled: enabled === true || enabled === 'true',
    maxSessionsPerIdentity: intSetting(maxSessionsPerIdentity, 3),
    idleTimeoutSeconds: intSetting(idleTimeoutSeconds, 900),
    maxSessionSeconds: intSetting(maxSessionSeconds, 28800),
    graceSeconds: intSetting(graceSeconds, 60),
    leaseTtlSeconds: Math.max(5, Math.min(300, intSetting(leaseTtlSeconds, 30))),
  };
}

/**
 * Resolve the caller identity or throw 401.
 * @returns {{ identity: string, isAdmin: boolean }}
 */
export function requireIdentity(request) {
  const { identity } = resolveTerminalIdentity(request);
  if (!identity) {
    throw httpError(
      'Terminal identity is not configured (TERMINAL_LOCAL_IDENTITY or proxy header)',
      401,
    );
  }
  return { identity, isAdmin: isTerminalAdmin(identity) };
}

function publicHost(host) {
  return {
    id: host.id,
    slug: host.slug,
    displayName: host.displayName,
    sshUser: host.sshUser,
    enabled: host.enabled,
    hostKeyPinned: Boolean(host.hostKeySha256),
    assigned: true,
  };
}

/** List hosts the identity may reach. Admins additionally get managed hosts. */
export async function listTargets(request) {
  const limits = await getTerminalLimits();
  if (!limits.enabled) {
    throw httpError('Terminal is disabled', 403);
  }
  const auth = requireIdentity(request);
  const hosts = await prisma.terminalHost.findMany({
    orderBy: { slug: 'asc' },
  });
  const visible = filterHostsForIdentity(hosts, auth.identity, {
    isAdmin: auth.isAdmin,
  });
  return {
    identity: auth.identity,
    isAdmin: auth.isAdmin,
    hosts: visible.map(publicHost),
  };
}

/**
 * Create a session (pending) and issue the first attach lease.
 * Body: { hostSlug, cols?, rows? }
 */
export async function createSession(request) {
  const limits = await getTerminalLimits();
  if (!limits.enabled) {
    throw httpError('Terminal is disabled', 403);
  }
  const auth = requireIdentity(request);

  let body;
  try {
    body = await request.json();
  } catch {
    throw httpError('Invalid JSON body', 400);
  }
  const hostSlug = String(body?.hostSlug || '').trim();
  if (!hostSlug || hostSlug.length > 128) {
    throw httpError('hostSlug is required', 400);
  }
  const cols = clampDimensions(body?.cols, 80);
  const rows = clampDimensions(body?.rows, 24);

  const host = await prisma.terminalHost.findUnique({ where: { slug: hostSlug } });
  if (!host || host.enabled === false) {
    throw httpError('Host not found', 404);
  }
  if (!canAccessHost(auth.identity, host, { isAdmin: auth.isAdmin })) {
    terminalAudit.warn('terminal.authz.denied', {
      identity: auth.identity,
      hostSlug,
      action: 'session.create',
    });
    throw httpError('You do not have access to this host', 403);
  }
  if (!host.hostKeySha256) {
    throw httpError(
      'Host key fingerprint is not pinned yet — enroll it in Settings before connecting',
      409,
    );
  }

  const activeCount = await prisma.terminalSession.count({
    where: {
      identity: auth.identity,
      status: { in: ['pending', 'active', 'grace'] },
    },
  });
  if (activeCount >= limits.maxSessionsPerIdentity) {
    throw httpError(
      `Session limit reached (${limits.maxSessionsPerIdentity}) — close an existing session first`,
      429,
    );
  }

  const sessionId = randomBytes(SESSION_ID_BYTES).toString('base64url');
  const lease = issueTerminalLease({
    sessionId,
    identity: auth.identity,
    ttlSeconds: limits.leaseTtlSeconds,
  });

  await prisma.terminalSession.create({
    data: {
      id: sessionId,
      identity: auth.identity,
      hostId: host.id,
      status: 'pending',
      clientMeta: {
        userAgent: (request.headers.get('user-agent') || '').slice(0, 200),
        language: (request.headers.get('accept-language') || '').slice(0, 80),
      },
    },
  });

  terminalAudit.info('terminal.session.created', {
    sessionId,
    identity: auth.identity,
    hostSlug: host.slug,
    limits: {
      idleTimeoutSeconds: limits.idleTimeoutSeconds,
      maxSessionSeconds: limits.maxSessionSeconds,
      graceSeconds: limits.graceSeconds,
    },
  });

  return {
    sessionId,
    host: publicHost(host),
    lease: lease.token,
    leaseExpiresAt: lease.expiresAt,
    wsPath: lease.wsPath,
    limits: {
      idleTimeoutSeconds: limits.idleTimeoutSeconds,
      maxSessionSeconds: limits.maxSessionSeconds,
      graceSeconds: limits.graceSeconds,
    },
    initialSize: { cols, rows },
  };
}

/** Re-issue a lease for a pending/grace session the identity owns. */
export async function refreshLease(request, sessionId) {
  const limits = await getTerminalLimits();
  if (!limits.enabled) {
    throw httpError('Terminal is disabled', 403);
  }
  const auth = requireIdentity(request);

  const session = await prisma.terminalSession.findUnique({
    where: { id: sessionId },
  });
  if (!session || session.identity !== auth.identity) {
    throw httpError('Session not found', 404);
  }
  if (!['pending', 'grace'].includes(session.status)) {
    throw httpError(`Session is ${session.status}; cannot attach`, 409);
  }
  const host = await prisma.terminalHost.findUnique({
    where: { id: session.hostId },
  });
  if (!host || host.enabled === false) {
    throw httpError('Host is disabled', 409);
  }
  if (!canAccessHost(auth.identity, host, { isAdmin: auth.isAdmin })) {
    terminalAudit.warn('terminal.authz.denied', {
      identity: auth.identity,
      hostSlug: host.slug,
      action: 'session.reattach',
      sessionId,
    });
    throw httpError('You do not have access to this host', 403);
  }

  const lease = issueTerminalLease({
    sessionId,
    identity: auth.identity,
    ttlSeconds: limits.leaseTtlSeconds,
  });
  return {
    sessionId,
    lease: lease.token,
    leaseExpiresAt: lease.expiresAt,
    wsPath: lease.wsPath,
  };
}

/** User-initiated close (also used by the UI disconnect button). */
export async function closeSession(request, sessionId, reason = 'user') {
  const auth = requireIdentity(request);

  const session = await prisma.terminalSession.findUnique({
    where: { id: sessionId },
  });
  if (!session || (session.identity !== auth.identity && !auth.isAdmin)) {
    throw httpError('Session not found', 404);
  }
  if (['closed', 'failed'].includes(session.status)) {
    return { ok: true, status: session.status };
  }
  await prisma.terminalSession.update({
    where: { id: sessionId },
    data: {
      status: 'closed',
      closedAt: new Date(),
      closeReason: String(reason).slice(0, 64),
    },
  });
  terminalAudit.info('terminal.session.closed', {
    sessionId,
    identity: session.identity,
    hostId: session.hostId,
    reason,
    via: 'rest',
  });
  return { ok: true, status: 'closed' };
}

/** Recent sessions for the identity (admin: all), newest first. */
export async function listSessions(request) {
  const auth = requireIdentity(request);
  const rows = await prisma.terminalSession.findMany({
    where: auth.isAdmin ? {} : { identity: auth.identity },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const hostIds = [...new Set(rows.map((row) => row.hostId))];
  const hosts = hostIds.length
    ? await prisma.terminalHost.findMany({ where: { id: { in: hostIds } } })
    : [];
  const hostById = new Map(hosts.map((host) => [host.id, host]));
  return {
    sessions: rows.map((row) => ({
      id: row.id,
      hostSlug: hostById.get(row.hostId)?.slug,
      hostName: hostById.get(row.hostId)?.displayName,
      status: row.status,
      createdAt: row.createdAt,
      closedAt: row.closedAt,
      closeReason: row.closeReason,
    })),
  };
}

function clampDimensions(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(2, Math.min(500, Math.floor(num)));
}
