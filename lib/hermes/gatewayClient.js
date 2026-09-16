/**
 * Browser WebSocket client for Hermes tui_gateway JSON-RPC.
 *
 * Ported from hermes-agent apps/shared/src/json-rpc-gateway.ts so PersonalDash
 * can speak the same protocol without importing the Hermes monorepo package.
 */

const ANY = '*';
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * @param {{ path: string, basePath?: string, authParam?: readonly [string, string], params?: Record<string, string>, protocol?: string, host?: string }} options
 */
export function buildHermesWebSocketUrl(options) {
  const loc =
    typeof window !== 'undefined'
      ? { host: window.location.host, protocol: window.location.protocol }
      : { host: '', protocol: 'http:' };
  const protocol = options.protocol ?? loc.protocol;
  const host = options.host ?? loc.host;
  const wsScheme =
    protocol === 'https:' || protocol === 'wss:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams(options.params ?? {});
  if (options.authParam) {
    const [name, value] = options.authParam;
    qs.set(name, value);
  }
  const query = qs.toString();
  const suffix = query ? `?${query}` : '';
  const basePath = options.basePath
    ? (options.basePath.startsWith('/')
        ? options.basePath
        : `/${options.basePath}`
      ).replace(/\/+$/, '')
    : '';
  const path = options.path.startsWith('/') ? options.path : `/${options.path}`;
  return `${wsScheme}//${host}${basePath}${path}${suffix}`;
}

export class JsonRpcGatewayClient {
  /**
   * @param {{
   *   closedErrorMessage?: string,
   *   connectErrorMessage?: string,
   *   connectTimeoutMs?: number,
   *   createRequestId?: (nextId: number) => string | number,
   *   requestIdPrefix?: string,
   *   requestTimeoutMs?: number,
   *   socketFactory?: (url: string) => WebSocket,
   *   notConnectedErrorMessage?: string,
   * }} [options]
   */
  constructor(options = {}) {
    this.nextId = 0;
    this.pending = new Map();
    this.socket = null;
    this.state = 'idle';
    /** @type {{ code: number | null, reason: string } | null} */
    this.lastClose = null;
    this.eventHandlers = new Map();
    this.stateHandlers = new Set();
    this.options = {
      closedErrorMessage: options.closedErrorMessage ?? 'WebSocket closed',
      connectErrorMessage:
        options.connectErrorMessage ?? 'WebSocket connection failed',
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      createRequestId:
        options.createRequestId ??
        ((nextId) => `${options.requestIdPrefix ?? 'r'}${nextId}`),
      notConnectedErrorMessage:
        options.notConnectedErrorMessage ?? 'gateway not connected',
      requestIdPrefix: options.requestIdPrefix ?? 'r',
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      socketFactory: options.socketFactory,
    };
  }

  get connectionState() {
    return this.state;
  }

  get lastCloseInfo() {
    return this.lastClose;
  }

  disposeSocket(socket, { code = null, reason = '' } = {}) {
    if (!socket) return;
    if (this.socket === socket) {
      this.socket = null;
    }
    if (code != null || reason) {
      this.lastClose = { code, reason: reason || '' };
    }
    try {
      if (
        socket.readyState === WebSocket.CONNECTING ||
        socket.readyState === WebSocket.OPEN
      ) {
        socket.close();
      }
    } catch {
      // ignore dispose races
    }
  }

  /**
   * @param {string} wsUrl
   */
  async connect(wsUrl) {
    if (typeof wsUrl !== 'string') {
      throw new Error(
        `gateway connect() requires a ws:// or wss:// URL string, got type "${typeof wsUrl}"`,
      );
    }

    let url;
    try {
      url = new URL(wsUrl);
    } catch {
      throw new Error(
        `gateway connect() requires a ws:// or wss:// URL string, got ${JSON.stringify(wsUrl)}`,
      );
    }

    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error(
        `gateway connect() requires a ws:// or wss:// URL string, got ${JSON.stringify(wsUrl)}`,
      );
    }

    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.state === 'connecting'
    ) {
      return;
    }

    // Drop any half-open/failed socket so the next handshake starts clean.
    if (this.socket) {
      this.disposeSocket(this.socket);
    }

    this.lastClose = null;
    this.setState('connecting');
    const socket = this.options.socketFactory?.(wsUrl) ?? new WebSocket(wsUrl);
    this.socket = socket;

    socket.addEventListener('message', (message) => {
      if (this.socket !== socket) return;
      this.handleMessage(message.data);
    });

    socket.addEventListener('close', (event) => {
      if (this.socket !== socket && this.socket !== null) return;
      const code = typeof event?.code === 'number' ? event.code : null;
      const reason = typeof event?.reason === 'string' ? event.reason : '';
      // Preserve a more specific diagnostic if dispose() later emits a bare close.
      if (code != null || reason || !this.lastClose) {
        this.lastClose = { code, reason };
      }
      this.socket = null;
      this.setState('closed');
      const detail =
        this.lastClose?.code != null
          ? `${this.options.closedErrorMessage} (${this.lastClose.code}${this.lastClose.reason ? `: ${this.lastClose.reason}` : ''})`
          : this.options.closedErrorMessage;
      this.rejectAllPending(new Error(detail));
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      let timer;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
      };

      const failConnect = (message) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.disposeSocket(socket);
        this.setState('error');
        reject(new Error(message));
      };

      const onOpen = () => {
        if (settled || this.socket !== socket) return;
        settled = true;
        cleanup();
        this.setState('open');
        resolve();
      };

      const onError = () => {
        const close = this.lastClose;
        const detail =
          close?.code != null
            ? `${this.options.connectErrorMessage} (${close.code}${close.reason ? `: ${close.reason}` : ''})`
            : this.options.connectErrorMessage;
        failConnect(detail);
      };

      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });

      if (this.options.connectTimeoutMs > 0) {
        timer = setTimeout(() => {
          failConnect(this.options.connectErrorMessage);
        }, this.options.connectTimeoutMs);
      }
    });
  }

  close() {
    const socket = this.socket;
    if (!socket) return;
    this.disposeSocket(socket);
    this.setState('closed');
    this.rejectAllPending(new Error(this.options.closedErrorMessage));
  }

  /**
   * @param {string} type
   * @param {(event: object) => void} handler
   */
  on(type, handler) {
    let handlers = this.eventHandlers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(type, handlers);
    }
    handlers.add(handler);
    return () => handlers?.delete(handler);
  }

  onAny(handler) {
    return this.on(ANY, handler);
  }

  onState(handler) {
    this.stateHandlers.add(handler);
    handler(this.state);
    return () => this.stateHandlers.delete(handler);
  }

  /**
   * @template T
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {number} [timeoutMs]
   * @param {AbortSignal} [signal]
   * @returns {Promise<T>}
   */
  request(
    method,
    params = {},
    timeoutMs = this.options.requestTimeoutMs,
    signal,
  ) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(this.options.notConnectedErrorMessage));
    }
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    const id = this.options.createRequestId(++this.nextId);

    return new Promise((resolve, reject) => {
      let onAbort;

      const detach = () => {
        if (onAbort && signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      const pending = {
        resolve: (value) => {
          detach();
          resolve(value);
        },
        reject: (error) => {
          detach();
          reject(error);
        },
      };

      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            detach();
            const seconds = Math.round(timeoutMs / 1000);
            reject(
              new Error(`request timed out after ${seconds}s: ${method}`),
            );
          }
        }, timeoutMs);
      }

      if (signal) {
        onAbort = () => {
          const call = this.pending.get(id);
          if (call?.timer) clearTimeout(call.timer);
          this.pending.delete(id);
          detach();
          reject(new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(id, pending);

      try {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            method,
            params,
          }),
        );
      } catch (error) {
        this.clearPending(id);
        detach();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  handleMessage(raw) {
    const text = typeof raw === 'string' ? raw : String(raw);
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }

    if (frame.id !== undefined && frame.id !== null) {
      const call = this.pending.get(frame.id);
      if (!call) return;
      this.clearPending(frame.id);
      if (frame.error) {
        call.reject(new Error(frame.error.message || 'Hermes RPC failed'));
      } else {
        call.resolve(frame.result);
      }
      return;
    }

    if (frame.method === 'event' && frame.params?.type) {
      this.dispatchEvent(frame.params);
    }
  }

  clearPending(id) {
    const call = this.pending.get(id);
    if (call?.timer) clearTimeout(call.timer);
    this.pending.delete(id);
  }

  dispatchEvent(event) {
    for (const handler of this.eventHandlers.get(event.type) ?? []) {
      handler(event);
    }
    for (const handler of this.eventHandlers.get(ANY) ?? []) {
      handler(event);
    }
  }

  rejectAllPending(error) {
    for (const [id, call] of this.pending) {
      if (call.timer) clearTimeout(call.timer);
      call.reject(error);
      this.pending.delete(id);
    }
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }
}

export class HermesGatewayClient extends JsonRpcGatewayClient {
  constructor() {
    super({
      closedErrorMessage: 'WebSocket closed',
      connectErrorMessage: 'WebSocket connection failed',
      notConnectedErrorMessage: 'gateway not connected',
      requestIdPrefix: 'pd',
    });
  }

  /**
   * @param {{ token: string, basePath?: string }} auth
   */
  async connectWithToken(auth) {
    if (!auth?.token) {
      throw new Error('Session token not available');
    }
    await this.connect(
      buildHermesWebSocketUrl({
        authParam: ['token', auth.token],
        basePath: auth.basePath || '/hermes',
        path: '/api/ws',
      }),
    );
  }
}
