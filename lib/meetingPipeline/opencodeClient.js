/**
 * lib/meetingPipeline/opencodeClient.js — Thin fetch wrapper around the opencode
 * HTTP server for the meeting-note format + linker agents.
 *
 * Sessions are PERSISTED (never deleted): each pipeline run creates a real,
 * titled server session visible in `opencode attach` / `opencode web` for
 * inspection. The returned sessionID is stored on the meeting job row.
 *
 * Mirrors the retry/timeout style of requestLlmJson in ./llm.js: basic auth,
 * bounded attempts, retryable transport errors, per-call timeout.
 */

import config from '@/lib/config';

const OC_FETCH_ATTEMPTS = 3;
const OC_FETCH_RETRY_BASE_MS = 1000;
const OC_FETCH_MAX_RETRY_MS = 15000;
const RETRYABLE_FETCH_CODES = new Set([
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function baseUrl() {
  return String(config.opencodeServerUrl || '').replace(/\/$/, '');
}

/**
 * Parse a "providerID/modelID" config string into the object shape the opencode
 * /session/{id}/message endpoint expects for its `model` body field. Returns
 * null when the ref is empty or malformed so callers can omit the field.
 *
 * Mirrors the proven call shape in ~/.hermes/bin/opencode_dispatch.sh:
 *   model: { providerID: "xiaomi-token-plan-cn", modelID: "mimo-v2.5-pro" }
 */
function parseModelRef(ref) {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  const sep = raw.indexOf('/');
  if (sep <= 0 || sep === raw.length - 1) return null;
  const providerID = raw.slice(0, sep);
  const modelID = raw.slice(sep + 1);
  return { providerID, modelID };
}

/**
 * Shape the same config string for the POST /session `model` body field, which
 * uses `{ id, providerID }` (vs the message endpoint's `{ providerID, modelID }`).
 */
function toSessionModel(ref) {
  const parsed = parseModelRef(ref);
  return parsed ? { id: parsed.modelID, providerID: parsed.providerID } : null;
}

function authHeaders() {
  const password = config.opencodeServerPassword;
  const headers = { 'Content-Type': 'application/json' };
  if (password) {
    const username = config.opencodeServerUsername || 'opencode';
    const token = Buffer.from(`${username}:${password}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
  }
  return headers;
}

function fetchErrorCode(error) {
  return error?.cause?.code || error?.code || error?.name || '';
}

function describeFetchError(error) {
  const cause = error?.cause;
  if (cause?.code) return `${error?.message || error}: ${cause.code}`;
  return error instanceof Error ? error.message : String(error);
}

function isRetryableFetchError(error) {
  if (error?.retryableHttp === true) return true;
  const code = fetchErrorCode(error);
  return RETRYABLE_FETCH_CODES.has(code) || code === 'TimeoutError';
}

function retryAfterMs(value) {
  if (!value) return null;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function retryDelayMs(error, attempt) {
  return Math.min(
    retryAfterMs(error?.retryAfter) ??
      OC_FETCH_RETRY_BASE_MS * 2 ** (attempt - 1),
    OC_FETCH_MAX_RETRY_MS,
  );
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitForSignal(ms, signal) {
  if (!signal) return wait(ms);
  if (signal.aborted)
    return Promise.reject(signal.reason || new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function parseResponse(response) {
  const raw = await response.text();
  let payload = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
  }
  if (!response.ok) {
    throw Object.assign(
      new Error(
        `opencode HTTP ${response.status}: ${(raw || '').slice(0, 800)}`,
      ),
      {
        retryableHttp: response.status === 429 || response.status >= 500,
        retryAfter: response.headers.get('retry-after'),
        status: response.status,
      },
    );
  }
  return payload;
}

/**
 * Fetch with retry/timeout against the opencode server.
 * @param {string} path
 * @param {Object} options - fetch options (method, body, signal)
 * @returns {Promise<Object|null>} parsed JSON response
 */
async function ocFetch(path, { method = 'GET', body, signal } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= OC_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl()}${path}`, {
        method,
        headers: authHeaders(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
      return await parseResponse(response);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      if (!isRetryableFetchError(error) || attempt === OC_FETCH_ATTEMPTS) break;
      const delayMs = retryDelayMs(error, attempt);
      console.warn(
        `[opencode] fetch attempt ${attempt}/${OC_FETCH_ATTEMPTS} failed; retrying in ${Math.round(delayMs)}ms: ${describeFetchError(error)}`,
      );
      await wait(delayMs);
    }
  }
  throw new Error(
    `opencode fetch failed for ${path}: ${describeFetchError(lastError)}`,
  );
}

/**
 * Create a persistent, titled session.
 * @param {string} title - Human-readable session title for the opencode UI.
 * @param {string} [modelRef] - "providerID/modelID" config string.
 * @param {string} [directory] - Workspace directory for the session. When set
 *   (e.g. the vault root for the linker agent), that directory becomes the
 *   opencode workspace so file access inside it is not gated as
 *   `external_directory`. Mirrors ~/.hermes/bin/opencode_dispatch.sh.
 * @returns {Promise<{ sessionID: string }>}
 */
export async function createSession(title, modelRef, directory) {
  if (!baseUrl()) throw new Error('opencode server URL not configured');
  const body = { title };
  const sessionModel = toSessionModel(modelRef);
  if (sessionModel) body.model = sessionModel;
  const path =
    '/session' +
    (directory ? `?directory=${encodeURIComponent(directory)}` : '');
  const session = await ocFetch(path, {
    method: 'POST',
    body,
  });
  const sessionID = session?.id || session?.sessionID || session?.sessionId;
  if (!sessionID) {
    throw new Error(
      `opencode /session did not return an id: ${JSON.stringify(session).slice(0, 400)}`,
    );
  }
  return { sessionID };
}

/** Extract assistant text from an opencode message response, robust to shape. */
function extractAssistantText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message.trim();
  // opencode messages carry a `parts` array; assistant text lives in {type:'text'}.
  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
  }
  return String(message.text || message.content || '').trim();
}

function latestAssistantText(messages) {
  const list = Array.isArray(messages) ? messages : [messages].filter(Boolean);
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.info?.role && message.info.role !== 'assistant') continue;
    const text = extractAssistantText(message);
    if (text) return text;
  }
  return '';
}

/**
 * Fetch a session's info (title, agent, model) by id.
 * @returns {Promise<{title:string, agent:string, raw:Object}>}
 */
export async function getSessionInfo(sessionID) {
  const payload = await ocFetch(`/session/${sessionID}`);
  const info = payload?.info ?? payload ?? {};
  return {
    title: String(info.title || ''),
    agent: String(info.agent || ''),
    raw: info,
  };
}

/**
 * Fetch all messages of a session (newest last).
 * @returns {Promise<Array<{info:Object, parts:Array}>>}
 */
export async function listSessionMessages(sessionID, { signal } = {}) {
  const messages = await ocFetch(`/session/${sessionID}/message`, { signal });
  return Array.isArray(messages) ? messages : [];
}

async function waitForAssistantText(sessionID, { signal } = {}) {
  const deadline = Date.now() + config.opencodeTimeoutSec * 1000;
  while (Date.now() < deadline) {
    const messages = await listSessionMessages(sessionID, { signal });
    const text = latestAssistantText(messages);
    if (text) return text;
    await waitForSignal(1000, signal);
  }
  throw new Error(
    `opencode session ${sessionID} did not produce assistant text before timeout`,
  );
}

/**
 * Run an opencode agent in a (new or existing) session and return its text.
 *
 * @param {Object} params
 * @param {string} params.agent - Agent name (e.g. 'meeting-leadership').
 * @param {string} params.title - Descriptive session title.
 * @param {string} params.prompt - User prompt text.
 * @param {string} [params.model] - Model name to pin for this agent run.
 * @param {string} [params.sessionID] - Reuse an existing session; create otherwise.
 * @param {AbortSignal} [params.signal] - AbortSignal for cancellation.
 * @returns {Promise<{ text: string, sessionID: string }>}
 */
export async function runAgent({
  agent,
  title,
  prompt,
  model,
  sessionID,
  signal,
}) {
  const id = sessionID || (await createSession(title, model)).sessionID;
  const body = { agent, parts: [{ type: 'text', text: prompt }] };
  const messageModel = parseModelRef(model);
  if (messageModel) {
    body.model = messageModel;
    body.variant = 'default';
  }
  const message = await ocFetch(`/session/${id}/message`, {
    method: 'POST',
    body,
    signal,
  });
  let text = extractAssistantText(message);
  if (!text) {
    // Tool-using agents can return an intermediate assistant step first
    // (finish=tool-calls) and append the final text message shortly after.
    text = await waitForAssistantText(id, { signal });
  }
  if (!text) {
    throw new Error(
      `opencode agent "${agent}" returned no assistant text in session ${id}`,
    );
  }
  return { text, sessionID: id };
}

/**
 * Abort the currently-running generation in a session (cancellation).
 * Best-effort: never throws into the cancellation path.
 */
export async function abortSession(sessionID) {
  if (!sessionID) return;
  try {
    await ocFetch(`/session/${sessionID}/abort`, { method: 'POST' });
  } catch (error) {
    console.warn(
      `[opencode] abortSession(${sessionID}) failed: ${describeFetchError(error)}`,
    );
  }
}

/**
 * Mint a shareable URL for a session (optional observability).
 * @returns {Promise<string|null>}
 */
export async function share(sessionID) {
  if (!sessionID) return null;
  try {
    const result = await ocFetch(`/session/${sessionID}/share`, {
      method: 'POST',
    });
    return (
      result?.url ||
      result?.shareUrl ||
      result?.share?.url ||
      result?.share?.shareUrl ||
      result?.info?.share?.url ||
      null
    );
  } catch (error) {
    console.warn(
      `[opencode] share(${sessionID}) failed: ${describeFetchError(error)}`,
    );
    return null;
  }
}

/** Build a per-call AbortSignal that times out after opencodeTimeoutSec. */
export function opencodeTimeoutSignal() {
  return AbortSignal.timeout(config.opencodeTimeoutSec * 1000);
}
