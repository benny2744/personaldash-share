/**
 * Managed-file preview helpers for the workspace sidecar viewer.
 *
 * The gateway `/api/files/read` endpoint returns `{ data_url }` — a base64
 * data URL (or bare base64/text). `atob()` alone mangles multi-byte UTF-8
 * (CJK notes, em dashes), so decoding must route through TextDecoder.
 */

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);

const TEXT_EXTENSIONS = new Set([
  'txt',
  'text',
  'log',
  'json',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'css',
  'scss',
  'html',
  'htm',
  'xml',
  'svg',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'sh',
  'bash',
  'zsh',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sql',
  'csv',
  'tsv',
]);

/** Last path segment's lowercase extension ('' when none). */
export function fileExtension(path) {
  const name =
    String(path ?? '')
      .split(/[\\/]/)
      .pop() || '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function isMarkdownPath(path) {
  return MARKDOWN_EXTENSIONS.has(fileExtension(path));
}

/**
 * Heuristic: render as text/markdown rather than raw base64 noise.
 * Extensionless files (Dockerfile, Makefile, scratch notes) are treated as
 * text — the worst case is odd characters in a monospace pane.
 */
export function isTextPath(path) {
  const extension = fileExtension(path);
  if (!extension) return true;
  return TEXT_EXTENSIONS.has(extension);
}

export function isImageMime(mimeType) {
  return String(mimeType ?? '').startsWith('image/');
}

/** Server-advertised text-ish MIME types (checked before path guessing). */
export function isTextMime(mimeType) {
  const mime = String(mimeType ?? '').toLowerCase();
  if (mime.startsWith('text/')) return true;
  return /json|xml|javascript|yaml|csv|markdown|x-sh/.test(mime);
}

/**
 * Decode a base64 data URL (or bare base64) to a UTF-8 string.
 * @param {string} dataUrl data URL, bare base64, or already-plain text
 * @returns {string}
 */
export function dataUrlToText(dataUrl) {
  const raw = String(dataUrl ?? '');
  const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}
