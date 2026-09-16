/**
 * Hermes implementation of the PersonalDash agent-runtime contract.
 *
 * The ONLY module in PersonalDash that should name Hermes RPC methods.
 * Composes the existing Hermes building blocks rather than absorbing them:
 * transport (gatewayClient.js), REST (api.js), reconnect diagnostics
 * (reconnect.js). Owns bootstrap/token resolution and the gateway client
 * instance.
 *
 * Profiles/Bots select a runtime, not a session option:
 *
 *   const builder = createHermesRuntime({ profile: 'builder' });
 *   await builder.connect();
 *   await builder.sessions.create();
 */

import {
  clearHermesBootstrapCache,
  deleteSession,
  fetchHermesBootstrap,
  getLatestDescendant,
  getSession,
  getSessionMessages,
  listManagedFiles,
  listSessions,
  managedFileDownloadUrl,
  readManagedFile,
  renameSession,
  searchSessions,
} from '@/lib/hermes/api';
import { HermesGatewayClient } from '@/lib/hermes/gatewayClient';
import { formatCloseDiagnostic } from '@/lib/hermes/reconnect';

/**
 * Normalize a `profiles.list` / `/api/profiles` payload to the picker shape.
 * Accepts either `{ profiles: [...] }` or a bare array.
 * @param {any} payload
 */
export function normalizeProfileRows(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.profiles)
      ? payload.profiles
      : [];
  return rows.map((row) => ({
    name: row.name ?? '',
    displayName: row.display_name || row.name || '',
    isDefault: Boolean(row.is_default),
    model: row.model ?? '',
    provider: row.provider ?? '',
    description: row.description ?? '',
  }));
}

/**
 * @param {{
 *   profile?: string,
 *   basePath?: string,
 *   bootstrapProvider?: { fetch: Function, clear?: Function },
 *   gatewayFactory?: () => object,
 * }} [options]
 */
export function createHermesRuntime({
  profile = '',
  basePath = '',
  bootstrapProvider = {
    fetch: fetchHermesBootstrap,
    clear: clearHermesBootstrapCache,
  },
  gatewayFactory = () => new HermesGatewayClient(),
} = {}) {
  const descriptor = {
    id: profile ? `hermes:${profile}` : 'hermes',
    provider: 'hermes',
    ...(profile ? { profile } : {}),
    ...(basePath ? { endpoint: basePath } : {}),
  };

  let client = null;

  // descriptor.profile is the single source of truth for which Hermes profile
  // this runtime addresses. It is injected into every WS/REST call so the
  // public contract never carries a caller-supplied profile (one runtime =
  // one profile). Empty string means the default profile → param omitted.
  function profileParams() {
    return descriptor.profile ? { profile: descriptor.profile } : {};
  }

  function ensureClient() {
    if (!client) client = gatewayFactory();
    return client;
  }

  async function connect() {
    const gateway = ensureClient();
    if (gateway.connectionState === 'open') return gateway;

    // Always re-resolve credentials before (re)connecting so a rotated
    // dashboard token is picked up without a page reload.
    bootstrapProvider.clear?.();
    const bootstrap = await bootstrapProvider.fetch({ force: true });

    if (gateway.connectionState !== 'open') {
      await gateway.connectWithToken({
        token: bootstrap.token,
        basePath: basePath || bootstrap.basePath,
      });
    }
    return gateway;
  }

  function disconnect() {
    client?.close();
  }

  const runtime = {
    descriptor,

    connect,
    disconnect,

    get connectionState() {
      return client?.connectionState ?? 'idle';
    },

    onConnectionState(handler) {
      return ensureClient().onState(handler);
    },

    onEvent(handler) {
      return ensureClient().onAny(handler);
    },

    /** @returns {string} formatted close code/reason for diagnostics */
    lastCloseDiagnostic() {
      return formatCloseDiagnostic(client?.lastCloseInfo);
    },

    sessions: {
      /**
       * @param {{ source?: string, model?: string, provider?: string }} [opts]
       *   `model`/`provider` pin a per-session override at creation (used to
       *   apply a pending composer model once the first session lands).
       * @returns {Promise<{ session_id: string, stored_session_id?: string, info?: object }>}
       */
      async create(opts = {}) {
        const { source, model, provider } = opts;
        return ensureClient().request('session.create', {
          source: source ?? 'personaldash',
          ...(model ? { model } : {}),
          ...(model && provider ? { provider } : {}),
          ...profileParams(),
        });
      },

      /**
       * Bind a live session over WS. The RPC history projection lacks DB ids,
       * so callers reconcile via sessions.getMessages().
       */
      resume(sessionId) {
        return ensureClient().request('session.resume', {
          session_id: sessionId,
          ...profileParams(),
        });
      },

      interrupt(sessionId) {
        return ensureClient().request('session.interrupt', {
          session_id: sessionId,
          ...profileParams(),
        });
      },

      /** Steer the active turn without interrupting it. */
      steer(sessionId, text) {
        return ensureClient().request('session.steer', {
          session_id: sessionId,
          text,
          ...profileParams(),
        });
      },

      list(opts) {
        return listSessions({ ...opts, ...profileParams() });
      },

      search(query) {
        return searchSessions(query, profileParams());
      },

      get(sessionId) {
        return getSession(sessionId, profileParams());
      },

      /** Compression continuations branch the session id; resolve the tip. */
      getLatestDescendant(sessionId) {
        return getLatestDescendant(sessionId, profileParams());
      },

      getMessages(sessionId, opts) {
        return getSessionMessages(sessionId, { ...opts, ...profileParams() });
      },

      rename(sessionId, title) {
        return renameSession(sessionId, { title }, profileParams());
      },

      delete(sessionId) {
        return deleteSession(sessionId, profileParams());
      },
    },

    prompt: {
      submit(sessionId, text) {
        return ensureClient().request('prompt.submit', {
          session_id: sessionId,
          text,
        });
      },

      /**
       * @param {string} sessionId
       * @param {{ content_base64: string, filename: string }} image
       */
      attachImage(sessionId, { content_base64, filename }) {
        return ensureClient().request('image.attach_bytes', {
          session_id: sessionId,
          content_base64,
          filename,
        });
      },

      respondApproval(sessionId, choice) {
        return ensureClient().request('approval.respond', {
          session_id: sessionId,
          choice,
        });
      },

      /**
       * Answer a clarify prompt. Batch (multi-question) clarify resolves one
       * question per call — pass `questionId` so the gateway locks that
       * answer in-place until every question is answered.
       * @param {string} sessionId
       * @param {string} requestId
       * @param {string} answer
       * @param {string} [questionId] batch clarify question id (qid)
       */
      respondClarify(sessionId, requestId, answer, questionId) {
        return ensureClient().request('clarify.respond', {
          session_id: sessionId,
          request_id: requestId,
          answer,
          ...(questionId ? { question_id: questionId } : {}),
        });
      },

      /**
       * @param {'sudo'|'secret'} kind
       */
      respondSecret(sessionId, kind, requestId, value) {
        const gateway = ensureClient();
        if (kind === 'sudo') {
          return gateway.request('sudo.respond', {
            session_id: sessionId,
            request_id: requestId,
            password: value,
          });
        }
        return gateway.request('secret.respond', {
          session_id: sessionId,
          request_id: requestId,
          value,
        });
      },
    },

    commands: {
      /** Full slash-command catalog for autocomplete. */
      catalog() {
        return ensureClient().request('commands.catalog', {});
      },

      /** Parse/validate a command string without executing it. */
      resolve(command) {
        return ensureClient().request('command.resolve', { command });
      },

      /**
       * Execute a slash command in a session and mirror its side effects on the
       * live agent, e.g. exec({ sessionId, command: '/model claude-sonnet-4' }).
       * This is the path `/model` (and other side-effecting slashes) take: the
       * gateway runs it and re-emits `session.info`, so the client's canonical
       * model reflects the change. Model switching is a command in Hermes, not a
       * dedicated RPC.
       */
      exec({ sessionId, command }) {
        return ensureClient().request('slash.exec', {
          session_id: sessionId,
          command,
        });
      },

      /**
       * Dispatch a quick/plugin/bundle/skill command by name+arg.
       * (Side-effecting built-ins like `/model` go through exec(), not this.)
       */
      dispatch({ sessionId, command }) {
        return ensureClient().request('command.dispatch', {
          session_id: sessionId,
          command,
        });
      },
    },

    models: {
      /** Available models for the picker (profile-scoped on the server). */
      options(opts = {}) {
        return ensureClient().request('model.options', {
          refresh: Boolean(opts.refresh),
          ...profileParams(),
        });
      },
    },

    profiles: {
      /**
       * Enumerate Hermes profiles this deployment exposes. Returns the launch
       * "default" profile even when no named profiles exist.
       * @returns {Promise<Array<{
       *   name: string, displayName: string, isDefault: boolean,
       *   model: string, provider: string, description: string,
       * }>>}
       */
      async list() {
        const result = await ensureClient().request('profiles.list', {});
        return normalizeProfileRows(result);
      },
    },

    files: {
      list(path) {
        return listManagedFiles(path);
      },

      read(path) {
        return readManagedFile(path);
      },

      downloadUrl(path) {
        return managedFileDownloadUrl(path);
      },
    },
  };

  return runtime;
}
