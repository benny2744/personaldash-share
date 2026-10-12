/**
 * services/terminal-gateway/server.js — lease-verified WebSocket → SSH bridge.
 *
 * Browser path : Caddy /api/terminal/ws → this server (WS upgrade)
 *   query: ?session=<id>&lease=<token>&cols=&rows=
 * Internal API : Bearer TERMINAL_LEASE_SECRET
 *   GET  /healthz            (no auth; liveness only)
 *   POST /internal/fingerprint
 *   GET  /internal/stats
 *
 * No SSH credentials exist outside this container (read-only key mount).
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { getConfig } from './lib/config.js';
import { createDbPool, getLimits } from './lib/db.js';
import { defaultSshFactory } from './lib/ssh.js';
import { createSessionManager } from './lib/sessionManager.js';

const config = getConfig();

if (!config.leaseSecret) {
  console.error(
    JSON.stringify({
      event: 'terminal-gateway.fatal',
      error: 'TERMINAL_LEASE_SECRET is required; refusing to start',
    }),
  );
  process.exit(1);
}
if (!config.databaseUrl) {
  console.error(
    JSON.stringify({
      event: 'terminal-gateway.fatal',
      error: 'DATABASE_URL is required; refusing to start',
    }),
  );
  process.exit(1);
}

let pool;
try {
  pool = await createDbPool(config.databaseUrl);
} catch (error) {
  console.error(
    JSON.stringify({ event: 'terminal-gateway.fatal', error: error.message }),
  );
  process.exit(1);
}

const sshFactory = defaultSshFactory();
const limitsCache = { rows: null, at: 0, ttlMs: config.settingsCacheMs };
const limitsReader = () => getLimits(pool, config.defaults, limitsCache);
const manager = createSessionManager({ pool, sshFactory, config, getLimits: limitsReader });

function bearerOk(request) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || token.length !== config.leaseSecret.length) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(config.leaseSecret);
  return timingSafeEqual(a, b);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const path = url.pathname;

  if (request.method === 'GET' && path === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }

  if (path.startsWith('/internal/')) {
    if (!bearerOk(request)) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    if (request.method === 'GET' && path === '/internal/stats') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(manager.stats()));
      return;
    }
    if (request.method === 'POST' && path === '/internal/fingerprint') {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 4096) {
          response.writeHead(413, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'Body too large' }));
          return;
        }
      }
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      const host = String(parsed.host || '').trim();
      const port = Number(parsed.port) || 22;
      if (!host || host.length > 253 || !Number.isInteger(port) || port < 1 || port > 65535) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'host and port are required' }));
        return;
      }
      try {
        const result = await manager.fingerprint({ host, port });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(502, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
  }

  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'Not found' }));
});

// ── WebSocket upgrades: /api/terminal/ws?session=&lease=&cols=&rows= ────────
const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxFrameBytes });

server.on('upgrade', async (request, socket, head) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname !== '/api/terminal/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const sessionId = (url.searchParams.get('session') || '').slice(0, 128);
  const lease = url.searchParams.get('lease') || '';
  const cols = clampDimension(url.searchParams.get('cols'), 80);
  const rows = clampDimension(url.searchParams.get('rows'), 24);
  if (!sessionId || !lease) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, async (ws) => {
    const result = await manager
      .attach({ sessionId, lease, ws, cols, rows })
      .catch((error) => ({
        ok: false,
        status: 500,
        error: error.message,
      }));
    if (!result.ok) {
      try {
        ws.send(
          JSON.stringify({ type: 'error', message: result.error || 'Attach failed' }),
        );
        ws.close(result.status === 409 ? 1013 : 1008, 'attach-rejected');
      } catch {}
      return;
    }
    // Protocol-level keepalive: detect dead sockets within ~90 s.
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
  });
});

const keepalive = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch {}
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 30_000);
keepalive.unref();

function clampDimension(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(2, Math.min(500, Math.floor(num)));
}

async function shutdown(signal) {
  console.log(
    JSON.stringify({ event: 'terminal-gateway.shutdown', signal }),
  );
  clearInterval(keepalive);
  try {
    await manager.shutdown();
  } catch {}
  try {
    await pool.end();
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      event: 'terminal-gateway.listening',
      host: config.host,
      port: config.port,
    }),
  );
});
