/**
 * lib/readLaterTtsClean.js — Cheap-model transcript cleaning for Read Later
 * read-aloud. The deterministic markdown→prose pass (lib/hermes/speechText)
 * removes code/URLs/markup, but Read Later sources (research reports, wiki
 * pages, digests) still carry citation markers, reference/methods/source
 * sections, wiki-context chrome, and tables that break the flow when spoken.
 *
 * This module runs the speakable text through the cheap tier (completeLight,
 * MEETING_LLM_LIGHT_* — on this estate the local LiteLLM qwen3.7-flash) to
 * rewrite it into flowing spoken prose before TTS chunking. Cleaning is
 * unconditional; on ANY failure it falls back to the raw text so TTS never
 * dies on the cleaner (READ_LATER_TTS_CLEANER=off disables it entirely).
 */

import { completeLight } from '@/lib/meetingPipeline/llm.js';

export const CLEANER_SEGMENT_CHARS = 6_000;

export const CLEANER_SYSTEM = `You convert text into clean prose for text-to-speech. Rewrite the user's text as flowing spoken prose in the SAME language as the source.

Remove completely:
- Inline citations and footnote markers: [1], [2][3], (Author, 2020), (Smith et al., 2021), [^note], superscript reference numbers.
- Any References / Bibliography / Sources / Citations / Further reading sections, and appendix-style Methods / Methodology / Materials / Data sources sections that exist only to document provenance.
- Wiki-style context chrome: sections or lines like "Wiki context", "Context", "Related pages", "See also", "Incoming links", "Tags", "Aliases", "Backlinks", and any "context missing" / "wiki context missing" notices.
- Raw URLs and markdown link syntax (keep the link's label text if it carries meaning).
- Markdown tables — if a table carries key content, express it as one or two sentences; otherwise drop it.

Keep, in order:
- The author's actual argument, narrative, examples, and conclusions — do NOT summarize or compress; keep substantially all substantive content.
- Numbers, names, dates, and quoted speech that matter to the content.
- Headings only if they genuinely help a listener (fold them into the prose, e.g. "Next: …"); drop them when the flow works without.

Output rules:
- Plain paragraphs separated by a single blank line.
- No markdown, no bullets, no headings, no HTML, no commentary, no preamble like "Here is" or "Cleaned text:".
- Preserve the source language (Chinese stays Chinese, English stays English).`;

export function isCleanerEnabled() {
  return process.env.READ_LATER_TTS_CLEANER !== 'off';
}

/**
 * Pack paragraphs into segments of at most `maxChars` on blank-line boundaries.
 * Oversized single paragraphs split on sentence punctuation, then hard-sliced.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string[]}
 */
export function segmentSpeechText(text, maxChars = CLEANER_SEGMENT_CHARS) {
  const source = String(text || '').trim();
  if (!source) return [];
  const paragraphs = source
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const sentences = (paragraph) =>
    paragraph.split(/(?<=[.!?。！？])\s+/).flatMap((sentence) => {
      if (sentence.length <= maxChars) return [sentence];
      const parts = [];
      for (let i = 0; i < sentence.length; i += maxChars) {
        parts.push(sentence.slice(i, i + maxChars));
      }
      return parts;
    });

  const segments = [];
  let current = '';
  const push = () => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = '';
  };
  const append = (piece) => {
    if (!current) {
      current = piece;
      return;
    }
    if (current.length + 2 + piece.length <= maxChars) {
      current = `${current}\n\n${piece}`;
      return;
    }
    push();
    current = piece;
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      append(paragraph);
      continue;
    }
    for (const sentence of sentences(paragraph)) append(sentence);
  }
  push();
  return segments;
}

/**
 * Clean one segment through the cheap tier. Returns the cleaned prose, or null
 * when the model failed or produced nothing usable (caller falls back to raw).
 * @param {string} segment
 * @param {(args: object) => Promise<string>} callLlm
 * @returns {Promise<string|null>}
 */
export async function cleanSpeechSegment(segment, callLlm) {
  const raw = String(segment || '').trim();
  if (!raw) return '';
  const cleaned = await callLlm({
    system: CLEANER_SYSTEM,
    user: raw,
    maxTokens: 8_000,
    temperature: 0.1,
  });
  const text = String(cleaned ?? '').trim();
  return text || null;
}

/**
 * Clean speakable text for TTS. Never throws: any LLM failure, empty output,
 * or pathological shrink (< 5% of input) returns the raw text with
 * `cleaned: false` so the caller can still synthesize.
 * @param {string} text
 * @param {{ callLlm?: (args: object) => Promise<string> }} [options]
 * @returns {Promise<{ ok: true, text: string, cleaned: boolean } | { ok: false, error: string }>}
 */
export async function cleanForSpeech(text, { callLlm = completeLight } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: 'Nothing to clean' };
  const { getSetting } = await import('@/lib/settings/resolve');
  if (!(await getSetting('readLater.ttsCleaner')))
    return { ok: true, text: raw, cleaned: false };

  const segments = segmentSpeechText(raw);
  if (!segments.length) return { ok: true, text: raw, cleaned: false };

  const parts = [];
  for (const segment of segments) {
    try {
      const cleaned = await cleanSpeechSegment(segment, callLlm);
      if (cleaned === null) {
        console.warn(
          `[read-later-tts-clean] segment cleaning failed; falling back to raw text (${raw.length} chars)`,
        );
        return { ok: true, text: raw, cleaned: false };
      }
      parts.push(cleaned);
    } catch (error) {
      console.warn(
        '[read-later-tts-clean] cleaner error; falling back to raw text:',
        error?.message || error,
      );
      return { ok: true, text: raw, cleaned: false };
    }
  }

  const joined = parts
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!joined || joined.length < raw.length * 0.05) {
    return { ok: true, text: raw, cleaned: false };
  }
  return { ok: true, text: joined, cleaned: true };
}
