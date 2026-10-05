/**
 * Markdown link rewriting for chat-rendered content.
 *
 * Hermes answers link vault notes by their vault-relative path
 * (e.g. `/resources/Foo.md`), but the dashboard serves no such route — those
 * links 404. Vault Markdown paths must open the vault viewer at
 * `/vault?path=…` instead. Everything else (external URLs, app routes,
 * Hermes API paths, in-page anchors) passes through unchanged.
 */

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

// Dashboard-owned prefixes that already work or must never be treated as
// vault paths.
const KEPT_PREFIXES = ['/api/', '/hermes', '/_next/'];

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Map a markdown link destination to the URL the dashboard should open.
 * @param {string | undefined} href Raw destination as written in the markdown
 * @returns {string | undefined} Destination for the rendered <a>
 */
export function vaultViewerHref(href) {
  if (typeof href !== 'string' || href === '') return href;
  if (
    href.startsWith('#') ||
    href.startsWith('//') ||
    SCHEME_RE.test(href) ||
    KEPT_PREFIXES.some((prefix) => href.startsWith(prefix))
  ) {
    return href;
  }

  const pathPart = safeDecode(href.split('#')[0].split('?')[0]);
  if (!/\.md$/i.test(pathPart)) return href;

  const normalized = pathPart.replace(/^\.?\//, '');
  if (!normalized || normalized === '.md' || normalized.endsWith('/.md')) {
    return href;
  }
  return `/vault?path=${encodeURIComponent(normalized)}`;
}
