/**
 * services/terminal-gateway/lib/credentials.js — mirror of the app's
 * lib/terminal/credentials.js validation; resolves credentialRef aliases to
 * candidate key file paths inside the read-only key directory.
 */

const REF_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUPPORTED_KEY_SUFFIXES = ['ed25519', 'rsa', 'ecdsa'];

export function validateCredentialRef(ref) {
  const value = String(ref || '').trim();
  if (!REF_RE.test(value)) {
    throw Object.assign(
      new Error(
        'credentialRef must match ^[a-z0-9][a-z0-9-]{0,63}$ (no dots, slashes, or underscores)',
      ),
      { code: 'INVALID_CREDENTIAL_REF' },
    );
  }
  return value;
}

export function resolveKeyFiles(keyDir, ref) {
  validateCredentialRef(ref);
  const dir = String(keyDir || '').replace(/\/+$/, '');
  if (!dir) {
    throw new Error('TERMINAL_KEY_DIR is not configured');
  }
  return SUPPORTED_KEY_SUFFIXES.map((suffix) => `${dir}/${ref}_${suffix}`);
}
