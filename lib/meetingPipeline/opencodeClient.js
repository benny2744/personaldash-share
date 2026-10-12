/** OpenCode 2.0 session adapter. Sessions remain persisted for inspection. */
import config from '@/lib/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

function baseUrl() {
  return String(config.opencodeServerUrl || '')
    .replace(/\/$/, '')
    .replace(/\/api$/, '');
}
function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  let password = config.opencodeServerPassword;
  let username = config.opencodeServerUsername || 'opencode';
  if (!password && process.env.OPENCODE_SERVER_AUTH_FILE) {
    let auth;
    try {
      auth = JSON.parse(
        readFileSync(process.env.OPENCODE_SERVER_AUTH_FILE, 'utf8'),
      );
    } catch {
      throw new Error('opencode declared auth file is unreadable or invalid');
    }
    if (
      typeof auth?.password !== 'string' ||
      !auth.password ||
      (auth.username !== undefined &&
        (typeof auth.username !== 'string' || !auth.username))
    ) {
      throw new Error('opencode declared auth file has invalid credentials');
    }
    password = auth.password;
    username = auth.username || 'opencode';
  }
  if (password) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
  return headers;
}
function toSessionModel(ref) {
  const raw = String(ref || '').trim();
  const sep = raw.indexOf('/');
  return sep > 0 && sep < raw.length - 1
    ? { providerID: raw.slice(0, sep), id: raw.slice(sep + 1) }
    : null;
}
export function waitForSignal(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
const RETRY_CODES = new Set([
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'TimeoutError',
]);
async function ocFetch(path, { method = 'GET', body, signal } = {}) {
  // Every request is bounded, including best-effort interrupt requests.
  const bounded = signal
    ? AbortSignal.any([signal, opencodeTimeoutSignal()])
    : opencodeTimeoutSignal();
  for (let attempt = 1; ; attempt++) {
    bounded.throwIfAborted();
    try {
      const response = await fetch(`${baseUrl()}/api${path}`, {
        method,
        headers: authHeaders(),
        signal: bounded,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        // Do not leak server error bodies (they can contain prompts/credentials).
        await response.text();
        throw Object.assign(
          new Error(`opencode HTTP ${response.status} for ${path}`),
          {
            retryable: response.status === 429 || response.status >= 500,
            retryAfter: response.headers.get('retry-after'),
          },
        );
      }
      const raw = await response.text();
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      if (bounded.aborted) throw bounded.reason;
      if (
        attempt >= 3 ||
        !(
          error.retryable ||
          RETRY_CODES.has(error.cause?.code || error.code || error.name)
        )
      )
        throw error;
      const seconds = Number(error.retryAfter);
      const retryMs =
        error.retryAfter && Number.isFinite(seconds)
          ? seconds * 1000
          : error.retryAfter
            ? Date.parse(error.retryAfter) - Date.now()
            : 1000 * 2 ** (attempt - 1);
      await waitForSignal(
        Math.max(0, Math.min(Number.isFinite(retryMs) ? retryMs : 1000, 15000)),
        bounded,
      );
    }
  }
}
export async function createSession(title, modelRef, directory) {
  return createPersistentSession(title, modelRef, directory);
}
async function createPersistentSession(title, modelRef, directory, signal) {
  if (!baseUrl()) throw new Error('opencode server URL not configured');
  const body = { id: `ses_${randomUUID().replaceAll('-', '')}`, title };
  const model = toSessionModel(modelRef);
  if (model) body.model = model;
  if (directory) body.location = { directory };
  const result = await ocFetch('/session', { method: 'POST', body, signal });
  if (!result?.data?.id)
    throw new Error('opencode session.create returned no id');
  return { sessionID: result.data.id };
}

/** Preserve the public v1 {info,parts} projection; retain v2 completion metadata. */
export function normalizeMessage(message) {
  if (message?.info) return message;
  const info = { ...message, role: message?.type };
  const parts =
    message?.type === 'user'
      ? [{ type: 'text', text: message.text }]
      : Array.isArray(message?.content)
        ? message.content
        : [];
  return { info, parts };
}
export function messageText(message) {
  return normalizeMessage(message)
    .parts.filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/** Only a successful idle boundary after THIS prompt makes output recoverable.
 * A completed tool step, admission response, and an earlier run cannot qualify.
 */
export function completedAssistantText(messages, promptID) {
  const list = messages.map(normalizeMessage);
  const start = list.findIndex(
    (m) => m.info.id === promptID && m.info.role === 'user',
  );
  if (start < 0) return '';
  let candidate = null;
  for (const m of list.slice(start + 1)) {
    const info = m.info;
    if (info.role === 'user') return ''; // Concurrent/reused turn: fail closed.
    if (info.role === 'assistant') candidate = m;
    if (info.role === 'idle') {
      if (info.outcome !== 'succeeded')
        throw new Error(`opencode generation ${info.outcome}`);
      if (candidate?.info.error) throw new Error('opencode assistant failed');
      return candidate?.info.finish === 'stop' && candidate.info.time?.completed
        ? messageText(candidate)
        : '';
    }
  }
  return '';
}
export async function getSessionInfo(sessionID) {
  const payload = await ocFetch(`/session/${encodeURIComponent(sessionID)}`);
  const info = payload?.data || {};
  return {
    title: String(info.title || ''),
    agent: String(info.agent || ''),
    raw: info,
  };
}
export async function listSessionMessages(sessionID, { signal } = {}) {
  const messages = [];
  const seenIDs = new Set();
  const cursors = new Set();
  let cursor;
  do {
    const query = new URLSearchParams({
      limit: '100',
      ...(cursor ? { cursor } : { order: 'asc' }),
    });
    const page = await ocFetch(
      `/session/${encodeURIComponent(sessionID)}/message?${query}`,
      { signal },
    );
    if (!Array.isArray(page?.data))
      throw new Error('Invalid opencode message envelope');
    for (const item of page.data) {
      if (!seenIDs.has(item.id)) {
        messages.push(normalizeMessage(item));
        seenIDs.add(item.id);
      }
    }
    cursor = page.cursor?.next;
    if (cursor && cursors.has(cursor))
      throw new Error('Repeated opencode pagination cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return messages;
}
export async function runAgent({
  agent,
  title,
  prompt,
  model,
  sessionID,
  signal,
}) {
  const bounded = signal
    ? AbortSignal.any([signal, opencodeTimeoutSignal()])
    : opencodeTimeoutSignal();
  bounded.throwIfAborted();
  const id =
    sessionID ||
    (await createPersistentSession(title, model, undefined, bounded)).sessionID;
  const path = `/session/${encodeURIComponent(id)}`;
  let admitted = false;
  try {
    bounded.throwIfAborted();
    if (agent)
      await ocFetch(`${path}/agent`, {
        method: 'POST',
        body: { agent },
        signal: bounded,
      });
    const selected = toSessionModel(model);
    if (selected)
      await ocFetch(`${path}/model`, {
        method: 'POST',
        body: { model: selected },
        signal: bounded,
      });
    const promptID = `msg_${randomUUID().replaceAll('-', '')}`;
    // ID is allocated once, outside retries: transport ambiguity cannot duplicate input.
    admitted = true;
    await ocFetch(`${path}/prompt`, {
      method: 'POST',
      body: { id: promptID, text: prompt, delivery: 'queue', resume: true },
      signal: bounded,
    });
    while (true) {
      bounded.throwIfAborted();
      const messages = await listSessionMessages(id, { signal: bounded });
      const text = completedAssistantText(messages, promptID);
      bounded.throwIfAborted();
      if (text) return { text, sessionID: id };
      await waitForSignal(1000, bounded);
    }
  } catch (error) {
    if (admitted) await abortSession(id);
    throw error;
  }
}
export async function abortSession(sessionID) {
  if (!sessionID) return;
  try {
    await ocFetch(
      `/session/${encodeURIComponent(sessionID)}/interrupt?resume=false`,
      { method: 'POST' },
    );
  } catch {
    console.warn('[opencode] session interrupt failed');
  }
}
// 2.0.26 exposes no session share route. Optional observability is unsupported.
export async function share() {
  return null;
}
export function opencodeTimeoutSignal() {
  return AbortSignal.timeout(config.opencodeTimeoutSec * 1000);
}
