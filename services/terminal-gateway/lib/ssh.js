/**
 * services/terminal-gateway/lib/ssh.js — ssh2 transport with mandatory pinned
 * host-key verification. The factory is injectable so tests can drive the
 * session lifecycle with a fake transport.
 *
 * Host-key policy (fail closed): the SHA256 fingerprint of the key presented
 * during the handshake is constant-time-compared against the pinned
 * `SHA256:<base64>` value from terminal_hosts. Missing pin or mismatch
 * refuses the connection before authentication completes.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { resolveKeyFiles } from './credentials.js';

function fingerprintsMatch(expectedPinned, presentedKey) {
  if (!expectedPinned) return false;
  const digest = createHash('sha256').update(presentedKey).digest('base64');
  const expected = String(expectedPinned).trim();
  const computed = `SHA256:${digest}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(computed);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function computeHostFingerprint(presentedKey) {
  return `SHA256:${createHash('sha256').update(presentedKey).digest('base64')}`;
}

/**
 * Resolve the ssh2 Client constructor (CJS interop is naming-fragile).
 */
async function loadSshClient(getClient) {
  if (getClient) return getClient();
  const mod = await import('ssh2');
  return mod.Client ?? mod.default?.Client;
}

function loadPrivateKey(keyDir, credentialRef) {  const candidates = resolveKeyFiles(keyDir, credentialRef);
  for (const path of candidates) {
    try {
      const contents = fs.readFileSync(path, 'utf8');
      if (contents.includes('PRIVATE KEY')) return contents;
    } catch {
      // try next suffix
    }
  }
  throw Object.assign(
    new Error(
      `No private key found for credentialRef '${credentialRef}' in ${keyDir}`,
    ),
    { code: 'KEY_NOT_FOUND' },
  );
}

/**
 * Default ssh2-backed factory. `deps.getClient` is overridable in tests.
 */
export function defaultSshFactory(deps = {}) {
  const getClient = deps.getClient;
  return {
    /**
     * @param {object} params
     * @param {string} params.sshHost
     * @param {number} params.sshPort
     * @param {string} params.sshUser
     * @param {string} params.credentialRef
     * @param {string} params.keyDir
     * @param {string} params.hostKeySha256  pinned fingerprint (required)
     * @param {number} params.cols
     * @param {number} params.rows
     */
    async connect(params) {
      if (!params.hostKeySha256) {
        throw Object.assign(
          new Error('Host key fingerprint is not pinned; refusing to connect'),
          { code: 'HOSTKEY_UNPINNED' },
        );
      }
      let privateKey;
      try {
        privateKey = loadPrivateKey(params.keyDir, params.credentialRef);
      } catch (error) {
        throw Object.assign(error, { code: error.code || 'KEY_NOT_FOUND' });
      }

      const Client = getClient
        ? await getClient()
        : (await import('ssh2')).Client;
      const client = new Client();

      return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          try {
            client.end();
          } catch {}
          reject(error);
        };
        client
          .on('error', (error) => {
            const code =
              error?.level === 'client-authentication' || /authentication/i.test(error?.message || '')
                ? 'AUTH_FAILED'
                : 'SSH_ERROR';
            fail(Object.assign(error, { code }));
          })
          .on('close', () => {
            fail(Object.assign(new Error('SSH connection closed'), { code: 'SSH_CLOSED' }));
          })
          .on('ready', () => {
            client.shell(
              {
                term: 'xterm-256color',
                cols: params.cols,
                rows: params.rows,
              },
              (error, channel) => {
                if (error) {
                  fail(Object.assign(error, { code: 'SHELL_FAILED' }));
                  return;
                }
                if (settled) {
                  try {
                    channel.end();
                  } catch {}
                  return;
                }
                settled = true;
                channel.on('error', () => {
                  try {
                    client.end();
                  } catch {}
                });
                resolve({
                  channel,
                  end: () => {
                    try {
                      channel.end();
                    } catch {}
                    try {
                      client.end();
                    } catch {}
                  },
                  resize: (cols, rows) => {
                    try {
                      channel.setWindow(rows, cols, 0, 0);
                    } catch {}
                  },
                });
              },
            );
          })
          .connect({
            host: params.sshHost,
            port: params.sshPort,
            username: params.sshUser,
            privateKey,
            readyTimeout: 15_000,
            keepaliveInterval: 15_000,
            keepaliveCountMax: 3,
            // Mandatory pinned host-key verification. Runs BEFORE auth; a
            // mismatch aborts with HOSTKEY_MISMATCH before credentials are sent.
            hostVerifier: (key) => {
              if (!fingerprintsMatch(params.hostKeySha256, key)) {
                fail(
                  Object.assign(
                    new Error(
                      `Host key fingerprint mismatch for ${params.sshHost}:${params.sshPort}`,
                    ),
                    { code: 'HOSTKEY_MISMATCH' },
                  ),
                );
                return false;
              }
              return true;
            },
          });
      });
    },

    /**
     * Probe a host's key fingerprint WITHOUT authenticating (learn flow).
     * The handshake aborts after host-key exchange; no credentials used.
     */
    async fingerprint({ sshHost, sshPort, timeoutMs = 10_000 }) {
      const Client = await loadSshClient(getClient);
      const client = new Client();
      return new Promise((resolve, reject) => {
        let fingerprint = null;
        const done = (error) => {
          try {
            client.end();
          } catch {}
          if (fingerprint) resolve({ fingerprint });
          else
            reject(
              Object.assign(
                new Error(error?.message || 'Could not reach the host for fingerprinting'),
                { code: 'PROBE_FAILED' },
              ),
            );
        };
        const timer = setTimeout(() => done(new Error('Fingerprint probe timed out')), timeoutMs);
        client
          .on('error', (error) => {
            clearTimeout(timer);
            done(error);
          })
          .on('close', () => {
            clearTimeout(timer);
            done(fingerprint ? null : new Error('Connection closed before host key exchange'));
          })
          .connect({
            host: sshHost,
            port: sshPort,
            username: 'terminal-fingerprint-probe',
            readyTimeout: timeoutMs,
            // Capture the presented key, then reject so no auth is attempted.
            hostVerifier: (key) => {
              fingerprint = computeHostFingerprint(key);
              return false;
            },
            // Never authenticate during a probe.
            authHandler: () => null,
          });
      });
    },
  };
}
