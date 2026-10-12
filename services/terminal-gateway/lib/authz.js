/**
 * services/terminal-gateway/lib/authz.js — mirror of the app's
 * lib/terminal/authz.js. Both tiers enforce the same rule; this copy is
 * intentionally dependency-free so the sidecar never imports app code.
 */

export function canAccessHost(identity, host, options = {}) {
  if (!identity || !host) return false;
  if (options.isAdmin) return true;
  const allowed = Array.isArray(host.allowed_identities)
    ? host.allowed_identities
    : [];
  return allowed.includes(identity);
}
