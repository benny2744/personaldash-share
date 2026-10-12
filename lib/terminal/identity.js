/**
 * lib/terminal/identity.js — resolve the requesting user's identity from the
 * deployment proxy. WorkDash has no built-in auth (see
 * docs/terminal-architecture.md §3): identity arrives via a trusted header
 * (Cloudflare Access by default) or the configured local fallback.
 */

const IDENTITY_RE = /^[a-zA-Z0-9._@+-]{1,120}$/;

function stripEnvQuotes(value) {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function getTerminalIdentityConfig() {
  const header = stripEnvQuotes(
    process.env.TERMINAL_IDENTITY_HEADER ||
      'Cf-Access-Authenticated-User-Email',
  );
  const localIdentity = stripEnvQuotes(
    process.env.TERMINAL_LOCAL_IDENTITY || '',
  ).toLowerCase();
  const admins = stripEnvQuotes(process.env.TERMINAL_ADMIN_IDENTITIES || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return { header, localIdentity, admins };
}

function normalizeIdentity(value) {
  const trimmed = String(value || '').trim().toLowerCase();
  if (!trimmed || !IDENTITY_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Resolve the caller identity for a request.
 * @param {Request} request
 * @returns {{ identity: string|null, source: 'header'|'local'|'none' }}
 */
export function resolveTerminalIdentity(request) {
  const { header, localIdentity } = getTerminalIdentityConfig();
  const headerValue = request.headers.get(header);
  if (headerValue) {
    const identity = normalizeIdentity(headerValue);
    if (identity) return { identity, source: 'header' };
  }
  if (localIdentity) return { identity: localIdentity, source: 'local' };
  return { identity: null, source: 'none' };
}

/**
 * Identity for non-HTTP contexts (internal jobs); header cannot apply.
 * @returns {{ identity: string|null, source: 'local'|'none' }}
 */
export function resolveLocalIdentity() {
  const { localIdentity } = getTerminalIdentityConfig();
  if (localIdentity) return { identity: localIdentity, source: 'local' };
  return { identity: null, source: 'none' };
}

export function isTerminalAdmin(identity) {
  if (!identity) return false;
  const normalized = String(identity).trim().toLowerCase();
  return getTerminalIdentityConfig().admins.includes(normalized);
}
