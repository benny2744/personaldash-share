/**
 * lib/terminal/credentials.js — SSH credential resolution for the terminal.
 *
 * V1 policy (docs/terminal-architecture.md §4): credentials are key files in a
 * directory mounted READ-ONLY into the terminal-gateway sidecar. Host rows
 * reference them by `credentialRef` alias; key material never enters the app
 * container, database, or browser. The provider interface leaves room for a
 * future SSH-CA provider.
 */

const REF_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUPPORTED_KEY_SUFFIXES = ['ed25519', 'rsa', 'ecdsa'];

/**
 * Validate a credentialRef alias. Throws on anything that could escape the
 * key directory (traversal, separators, hidden files).
 * @param {string} ref
 * @returns {string} the validated ref
 */
export function validateCredentialRef(ref) {
  const value = String(ref || '').trim();
  if (!REF_RE.test(value)) {
    throw Object.assign(
      new Error(
        'credentialRef must match ^[a-z0-9][a-z0-9-]{0,63}$ (no dots, slashes, or underscores)',
      ),
      { status: 400 },
    );
  }
  return value;
}

/**
 * FileKeyProvider: resolve a credentialRef to candidate key file paths.
 * Exported for the sidecar; the app only uses validateCredentialRef.
 */
export function resolveKeyFiles(keyDir, ref) {
  validateCredentialRef(ref);
  const dir = String(keyDir || '').replace(/\/+$/, '');
  if (!dir) {
    throw new Error('TERMINAL_KEY_DIR is not configured');
  }
  return SUPPORTED_KEY_SUFFIXES.map(
    (suffix) => `${dir}/${ref}_${suffix}`,
  );
}
