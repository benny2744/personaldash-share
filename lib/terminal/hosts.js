/**
 * lib/terminal/hosts.js — admin CRUD + validation for the terminal host
 * registry. All mutations are admin-gated (TERMINAL_ADMIN_IDENTITIES) and
 * origin-guarded at the route layer.
 */

import prisma from '@/lib/db';
import { validateCredentialRef } from '@/lib/terminal/credentials';
import { httpError } from '@/lib/terminal/errors';
import { getTerminalLeaseConfig } from '@/lib/terminal/lease';
import { isTerminalAdmin, resolveTerminalIdentity } from '@/lib/terminal/identity';
import { terminalAudit } from '@/lib/terminal/audit';
import { getTerminalLimits } from '@/lib/terminal/sessions';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
const IPV6_RE = /^[0-9a-fA-F:]{2,45}$/;
const USER_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}=?$/;
const IDENTITY_RE = /^[a-z0-9._@+-]{1,120}$/;

/**
 * Validate + normalize a host payload. Throws { status } errors.
 * @returns {{
 *   slug?: string, displayName?: string, sshHost?: string, sshPort?: number,
 *   sshUser?: string, credentialRef?: string, hostKeySha256?: string|null,
 *   allowedIdentities?: string[], enabled?: boolean,
 * }}
 */
export function validateHostPayload(body, { partial = false } = {}) {
  const out = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);

  if (!partial || has('slug')) {
    const slug = String(body.slug || '').trim().toLowerCase();
    if (!SLUG_RE.test(slug)) {
      throw Object.assign(
        new Error('slug must be lowercase letters, digits, or dashes (1–64 chars)'),
        { status: 400 },
      );
    }
    out.slug = slug;
  }
  if (!partial || has('displayName')) {
    const displayName = String(body.displayName || '').trim();
    if (!displayName || displayName.length > 120) {
      throw Object.assign(new Error('displayName is required (1–120 chars)'), {
        status: 400,
      });
    }
    out.displayName = displayName;
  }
  if (!partial || has('sshHost')) {
    const sshHost = String(body.sshHost || '').trim();
    if (!sshHost || sshHost.length > 253) {
      throw Object.assign(
        new Error('sshHost must be a hostname or IP address'),
        { status: 400 },
      );
    }
    if (sshHost.includes('@') || sshHost.includes('/')) {
      throw Object.assign(
        new Error('sshHost must be a bare hostname or IP (no user@, no path, no scheme)'),
        { status: 400 },
      );
    }
    const isIpv6 = sshHost.includes(':') && IPV6_RE.test(sshHost);
    if (!isIpv6 && !HOSTNAME_RE.test(sshHost)) {
      throw Object.assign(
        new Error('sshHost must be a hostname or IP address'),
        { status: 400 },
      );
    }
    out.sshHost = sshHost;
  }
  if (!partial || has('sshPort')) {
    const port = Number(body.sshPort ?? 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw Object.assign(new Error('sshPort must be an integer 1–65535'), {
        status: 400,
      });
    }
    out.sshPort = port;
  }
  if (!partial || has('sshUser')) {
    const sshUser = String(body.sshUser || '').trim();
    if (!USER_RE.test(sshUser)) {
      throw Object.assign(
        new Error('sshUser must be 1–64 chars: letters, digits, dots, dashes, underscores'),
        { status: 400 },
      );
    }
    out.sshUser = sshUser;
  }
  if (!partial || has('credentialRef')) {
    out.credentialRef = validateCredentialRef(body.credentialRef || 'default');
  }
  if (!partial || has('hostKeySha256')) {
    const fp = body.hostKeySha256;
    if (fp === null || fp === undefined || fp === '') {
      out.hostKeySha256 = null;
    } else {
      const normalized = String(fp).trim().replace(/^sha256:/i, 'SHA256:');
      if (!FINGERPRINT_RE.test(normalized)) {
        throw Object.assign(
          new Error('hostKeySha256 must look like SHA256:<base64> (ssh-keygen -lf format)'),
          { status: 400 },
        );
      }
      out.hostKeySha256 = normalized;
    }
  }
  if (!partial || has('allowedIdentities')) {
    const list = Array.isArray(body.allowedIdentities)
      ? body.allowedIdentities
      : String(body.allowedIdentities || '')
          .split(',')
          .map((item) => item.trim());
    const cleaned = [
      ...new Set(
        list.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean),
      ),
    ];
    if (cleaned.length > 200) {
      throw Object.assign(new Error('allowedIdentities supports at most 200 entries'), {
        status: 400,
      });
    }
    for (const identity of cleaned) {
      if (!IDENTITY_RE.test(identity)) {
        throw Object.assign(
          new Error(`Invalid identity in allowedIdentities: ${identity.slice(0, 40)}`),
          { status: 400 },
        );
      }
    }
    out.allowedIdentities = cleaned;
  }
  if (has('enabled') || !partial) {
    const enabled = body.enabled;
    out.enabled = enabled === undefined ? true : enabled === true || enabled === 'true';
  }
  return out;
}

/** Admin gate shared by host routes. Throws httpError on failure. */
export function requireHostsAdmin(request) {
  const { identity } = resolveTerminalIdentity(request);
  if (!identity) {
    throw httpError(
      'Terminal identity is not configured (TERMINAL_LOCAL_IDENTITY or proxy header)',
      401,
    );
  }
  if (!isTerminalAdmin(identity)) {
    terminalAudit.warn('terminal.authz.denied', {
      identity,
      action: 'hosts.admin',
    });
    throw httpError(
      'Terminal host administration requires an admin identity',
      403,
    );
  }
  return identity;
}

export async function listHosts() {
  const hosts = await prisma.terminalHost.findMany({ orderBy: { slug: 'asc' } });
  return {
    hosts: hosts.map((host) => ({
      id: host.id,
      slug: host.slug,
      displayName: host.displayName,
      sshHost: host.sshHost,
      sshPort: host.sshPort,
      sshUser: host.sshUser,
      credentialRef: host.credentialRef,
      hostKeySha256: host.hostKeySha256,
      allowedIdentities: host.allowedIdentities,
      enabled: host.enabled,
      createdAt: host.createdAt,
    })),
  };
}

export async function createHost(payload, { identity } = {}) {
  const data = validateHostPayload(payload);
  const exists = await prisma.terminalHost.findUnique({ where: { slug: data.slug } });
  if (exists) {
    throw Object.assign(new Error(`Host slug '${data.slug}' already exists`), {
      status: 409,
    });
  }
  const host = await prisma.terminalHost.create({ data });
  terminalAudit.info('terminal.host.created', {
    hostSlug: host.slug,
    sshHost: host.sshHost,
    sshPort: host.sshPort,
    identity,
  });
  return host;
}

export async function updateHost(id, payload, { identity } = {}) {
  const data = validateHostPayload(payload, { partial: true });
  const existing = await prisma.terminalHost.findUnique({ where: { id } });
  if (!existing) {
    throw Object.assign(new Error('Host not found'), { status: 404 });
  }
  if (data.slug && data.slug !== existing.slug) {
    const clash = await prisma.terminalHost.findUnique({ where: { slug: data.slug } });
    if (clash) {
      throw Object.assign(new Error(`Host slug '${data.slug}' already exists`), {
        status: 409,
      });
    }
  }
  const host = await prisma.terminalHost.update({ where: { id }, data });
  terminalAudit.info('terminal.host.updated', {
    hostSlug: host.slug,
    fields: Object.keys(data).join(','),
    identity,
  });
  return host;
}

export async function deleteHost(id, { identity } = {}) {
  const existing = await prisma.terminalHost.findUnique({ where: { id } });
  if (!existing) {
    throw Object.assign(new Error('Host not found'), { status: 404 });
  }
  const liveSessions = await prisma.terminalSession.count({
    where: { hostId: id, status: { in: ['pending', 'active', 'grace'] } },
  });
  if (liveSessions > 0) {
    throw Object.assign(
      new Error('Host has live sessions — close them before deleting'),
      { status: 409 },
    );
  }
  await prisma.terminalHost.delete({ where: { id } });
  terminalAudit.info('terminal.host.deleted', {
    hostSlug: existing.slug,
    identity,
  });
  return existing;
}

/**
 * Ask the sidecar to dial a host and report its key fingerprint.
 * Fails closed when TERMINAL_LEASE_SECRET or the gateway URL are missing.
 */
export async function learnFingerprint({ host, port, fetchImpl } = {}) {
  const config = getTerminalLeaseConfig();
  if (!config.configured) {
    throw httpError('TERMINAL_LEASE_SECRET is not configured', 503);
  }
  const limits = await getTerminalLimits();
  if (!limits.enabled) {
    throw httpError('Terminal is disabled', 403);
  }
  const doFetch = fetchImpl || fetch;
  let response;
  try {
    response = await doFetch(`${config.gatewayUrl}/internal/fingerprint`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        host: String(host || '').slice(0, 253),
        port: Number(port) || 22,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw httpError(`terminal-gateway is unreachable: ${error.message}`, 502);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw httpError(
      payload?.error || 'Fingerprint probe failed',
      response.status === 502 ? 502 : 400,
    );
  }
  if (!payload?.fingerprint || !FINGERPRINT_RE.test(payload.fingerprint)) {
    throw httpError('Gateway returned an invalid fingerprint', 502);
  }
  return payload;
}
