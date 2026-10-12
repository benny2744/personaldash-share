/**
 * lib/terminal/authz.js — the single host-authorization primitive for the
 * web terminal. Used by the app (REST session create, host admin API) AND
 * re-enforced inside the terminal-gateway sidecar at WS attach.
 */

/**
 * @param {string|null} identity
 * @param {{ allowedIdentities?: string[] }} host
 * @param {{ isAdmin?: boolean }} [options]
 * @returns {boolean}
 */
export function canAccessHost(identity, host, options = {}) {
  if (!identity || !host) return false;
  if (options.isAdmin) return true;
  const allowed = Array.isArray(host.allowedIdentities)
    ? host.allowedIdentities
    : [];
  return allowed.includes(identity);
}

/**
 * Filter a host list down to what the identity may see.
 * Admins see everything (including disabled hosts); users see only hosts
 * they are assigned to, and only enabled ones.
 */
export function filterHostsForIdentity(hosts, identity, options = {}) {
  if (!identity) return [];
  return hosts.filter(
    (host) =>
      (options.isAdmin || host.enabled !== false) &&
      canAccessHost(identity, host, options),
  );
}
