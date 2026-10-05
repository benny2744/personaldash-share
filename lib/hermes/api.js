/**
 * Browser REST helpers for Hermes dashboard endpoints under /hermes.
 */

/**
 * @typedef {{
 *   token: string,
 *   basePath: string,
 *   wsPath: string,
 *   authRequired: boolean,
 * }} HermesBootstrap
 */

/** @type {HermesBootstrap | null} */
let cachedBootstrap = null;

export async function fetchHermesBootstrap({ force = false } = {}) {
  if (cachedBootstrap && !force) return cachedBootstrap;
  const res = await fetch('/api/hermes/bootstrap', {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Hermes bootstrap failed (${res.status}): ${text}`);
  }
  cachedBootstrap = await res.json();
  return cachedBootstrap;
}

export function clearHermesBootstrapCache() {
  cachedBootstrap = null;
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @param {HermesBootstrap} [bootstrap]
 */
export async function hermesFetch(path, init = {}, bootstrap) {
  const auth = bootstrap || (await fetchHermesBootstrap());
  const base = auth.basePath.replace(/\/+$/, '');
  const url = path.startsWith('http')
    ? path
    : `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers(init.headers || {});
  if (auth.token) {
    headers.set('X-Hermes-Session-Token', auth.token);
  }
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  const res = await fetch(url, {
    ...init,
    headers,
    credentials: 'include',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res;
}

/**
 * Append a `profile` query param when a non-default profile is targeted.
 * The runtime injects its own descriptor.profile into these transport calls;
 * higher-level callers never pass it (one runtime = one profile).
 * @param {URLSearchParams} qs
 * @param {string} [profile]
 */
function withProfile(qs, profile) {
  if (profile) qs.set('profile', profile);
  return qs;
}

function profileQuery(profile) {
  const qs = new URLSearchParams();
  withProfile(qs, profile);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export async function listSessions({
  limit = 40,
  offset = 0,
  order = 'recent',
  profile,
} = {}) {
  const qs = withProfile(
    new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      order,
    }),
    profile,
  );
  return hermesFetch(`/api/sessions?${qs}`);
}

export async function searchSessions(query, { profile } = {}) {
  const qs = withProfile(new URLSearchParams({ q: query }), profile);
  return hermesFetch(`/api/sessions/search?${qs}`);
}

export async function getSession(sessionId, { profile } = {}) {
  return hermesFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}${profileQuery(profile)}`,
  );
}

export async function getLatestDescendant(sessionId, { profile } = {}) {
  return hermesFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/latest-descendant${profileQuery(profile)}`,
  );
}

export async function getSessionMessages(
  sessionId,
  { limit, offset = 0, profile } = {},
) {
  const qs = withProfile(
    new URLSearchParams({ offset: String(offset) }),
    profile,
  );
  if (limit != null) qs.set('limit', String(limit));
  return hermesFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages?${qs}`,
  );
}

/**
 * Fetch a single message at a given offset to verify a cached boundary.
 * @param {string} sessionId
 * @param {number} offset
 * @param {{ profile?: string }} [opts]
 */
export async function getSessionMessagesProbe(sessionId, offset, opts = {}) {
  return getSessionMessages(sessionId, { offset, limit: 1, ...opts });
}

/**
 * Fetch one page of the tail of a transcript starting at the given offset.
 * @param {string} sessionId
 * @param {number} startOffset
 * @param {number} [limit]
 * @param {{ profile?: string }} [opts]
 */
export async function getSessionMessagesTail(
  sessionId,
  startOffset,
  limit = 500,
  opts = {},
) {
  return getSessionMessages(sessionId, { offset: startOffset, limit, ...opts });
}

export async function renameSession(sessionId, patch, { profile } = {}) {
  return hermesFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}${profileQuery(profile)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  );
}

export async function deleteSession(sessionId, { profile } = {}) {
  return hermesFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}${profileQuery(profile)}`,
    { method: 'DELETE' },
  );
}

/**
 * Enumerate Hermes profiles via the dashboard REST (WS `profiles.list` twin).
 * @param {{ profile?: string }} [opts]
 */
export async function listProfiles(_opts = {}) {
  return hermesFetch('/api/profiles');
}

/**
 * The LLM tier registry (cheap / fast / balanced / …), each { tier, model,
 * baseUrl, source }. Drives the chat model picker.
 * @returns {Promise<Array<{ tier: string, model: string, baseUrl: string|null }>>}
 */
export async function fetchLlmTiers() {
  const res = await fetch('/api/llm-tiers', {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`tier list failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data?.tiers) ? data.tiers : [];
}

export async function getHermesStatus() {
  return hermesFetch('/api/status');
}

export async function listManagedFiles(path) {
  const qs = new URLSearchParams();
  if (path) qs.set('path', path);
  const suffix = qs.toString() ? `?${qs}` : '';
  return hermesFetch(`/api/files${suffix}`);
}

export async function readManagedFile(path) {
  const qs = new URLSearchParams({ path });
  return hermesFetch(`/api/files/read?${qs}`);
}

/**
 * Read a UTF-8 text file from the host filesystem via the dashboard spot
 * editor endpoint (`/api/fs/read-text`). Resolves null when the file does
 * not exist yet, so first-run callers can start with an empty document.
 * @param {string} path absolute host path
 * @returns {Promise<{text: string, binary: boolean, truncated: boolean}|null>}
 */
export async function fsReadText(path) {
  const qs = new URLSearchParams({ path });
  try {
    return await hermesFetch(`/api/fs/read-text?${qs}`);
  } catch (err) {
    if (String(err?.message || err).startsWith('404')) return null;
    throw err;
  }
}

/**
 * Overwrite (or create) a UTF-8 text file on the host filesystem via the
 * dashboard spot editor endpoint (`/api/fs/write-text`). The write is atomic
 * on the host (staged temp file + rename); the parent directory must already
 * exist.
 * @param {string} path absolute host path
 * @param {string} content
 * @param {{keepalive?: boolean}} [opts] `keepalive` lets an unload-flush
 *   write survive page teardown
 * @returns {Promise<{ok: boolean, path: string, byteSize: number}>}
 */
export function fsWriteText(path, content, opts = {}) {
  return hermesFetch('/api/fs/write-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
    keepalive: Boolean(opts.keepalive),
  });
}

/**
 * Build an authenticated download URL for managed files.
 * @param {string} path
 * @param {HermesBootstrap} [bootstrap]
 */
export async function managedFileDownloadUrl(path, bootstrap) {
  const auth = bootstrap || (await fetchHermesBootstrap());
  const base = auth.basePath.replace(/\/+$/, '');
  const qs = new URLSearchParams({
    path,
    token: auth.token,
  });
  return `${base}/api/files/download?${qs}`;
}
