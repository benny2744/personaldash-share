/**
 * Normalize Markdown / chat reply text into speakable prose for TTS.
 */

export const TTS_MAX_CHARS = 4_000;
/** @deprecated Use TTS_MAX_CHARS */
export const MIMO_TTS_MAX_CHARS = TTS_MAX_CHARS;

/**
 * Strip code fences, inline code, raw URLs, and most Markdown chrome.
 * @param {string} markdown
 */
export function markdownToSpeechText(markdown) {
  let text = String(markdown || '');

  // Drop fenced code blocks entirely (including language tags).
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/~~~[\s\S]*?~~~/g, ' ');

  // Drop inline code.
  text = text.replace(/`[^`\n]+`/g, ' ');

  // Images → alt text; links → label only.
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Strip raw URLs.
  text = text.replace(/https?:\/\/\S+/gi, ' ');
  text = text.replace(/\bwww\.\S+/gi, ' ');

  // Headings / quotes / list markers / emphasis.
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^>\s?/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  text = text.replace(/~~(.*?)~~/g, '$1');

  // Collapse whitespace.
  text = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return text;
}

/**
 * Validate and clamp speakable text for the speak API.
 * @param {unknown} raw
 */
export function prepareSpeechText(raw) {
  const spoken = markdownToSpeechText(String(raw || ''));
  if (!spoken) {
    return { ok: false, status: 400, error: 'Nothing speakable in reply text' };
  }
  if (spoken.length > TTS_MAX_CHARS) {
    return {
      ok: false,
      status: 413,
      error: `Text exceeds ${TTS_MAX_CHARS} character speak limit`,
    };
  }
  return { ok: true, text: spoken };
}
