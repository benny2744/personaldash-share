import { parseWikiLink, parseWikiLinkArray } from './wikilinks.js';

/**
 * Normalize a wikilink or path-ish string to a comparable stem.
 * @param {string} value
 * @returns {string}
 */
export function linkStem(value) {
  const target = parseWikiLink(value) || String(value || '').trim();
  if (!target) return '';
  const withoutExt = target.replace(/\.md$/i, '');
  const parts = withoutExt.split('/');
  return (parts[parts.length - 1] || '').trim();
}

/**
 * Extract Synthesized Into targets from a raw knowledge note record.
 * @param {object} item - KnowledgeNote with note.frontmatterJson
 * @returns {string[]}
 */
export function synthesizedIntoTargets(item) {
  const fm = item?.note?.frontmatterJson || {};
  const fromFm = parseWikiLinkArray(fm['Synthesized Into']);
  if (fromFm.length) return fromFm;
  return Array.isArray(item?.relatedConcepts) ? item.relatedConcepts : [];
}

/**
 * Resolve the first matching source-summary filepath for a raw dump.
 * @param {object} item
 * @param {Map<string, string>} summaryStemToPath - lowercase stem → filepath
 * @returns {string|null}
 */
export function resolveSummaryFilepath(item, summaryStemToPath) {
  for (const target of synthesizedIntoTargets(item)) {
    const stem = linkStem(target).toLowerCase();
    if (stem && summaryStemToPath.has(stem)) {
      return summaryStemToPath.get(stem);
    }
  }
  return null;
}

/**
 * Build a stem→filepath map from source-summary knowledge notes.
 * @param {Array<{ title: string, note?: { filepath?: string } }>} summaries
 * @returns {Map<string, string>}
 */
export function buildSummaryStemMap(summaries) {
  const map = new Map();
  for (const summary of summaries) {
    const filepath = summary?.note?.filepath;
    if (!filepath) continue;
    const fileStem = linkStem(filepath).toLowerCase();
    if (fileStem) map.set(fileStem, filepath);
    const titleStem = linkStem(summary.title).toLowerCase();
    if (titleStem && !map.has(titleStem)) map.set(titleStem, filepath);
  }
  return map;
}

/**
 * Extract a leading YYYY-MM-DD from a raw dump filepath or basename.
 * Validates calendar date (rejects 2026-13-40 etc.).
 * @param {string|null|undefined} filepath
 * @returns {string|null} ISO date string or null
 */
export function extractSourceFileDate(filepath) {
  if (!filepath) return null;
  const basename = String(filepath).split('/').pop() || '';
  const match = basename.match(/^(\d{4})-(\d{2})-(\d{2})(?:\b|[^\d])/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * Sort key for unread queue: filename date first, then updatedAt.
 * @param {{ sourceFileDate?: string|null, updatedAt?: string|Date|null }} item
 * @returns {string}
 */
export function unreadSortKey(item) {
  return String(item?.sourceFileDate || item?.updatedAt || '');
}

/**
 * Pull common display fields from a raw dump's frontmatter + filepath.
 * @param {object} item
 */
export function rawDisplayMeta(item) {
  const fm = item?.note?.frontmatterJson || {};
  const filepath = item?.note?.filepath || null;
  return {
    sourceType: fm['Source Type'] || null,
    sourceDate: fm['Source Date'] || null,
    sourceFileDate: extractSourceFileDate(filepath),
    canonicalUrl: fm['Canonical URL'] || fm.URL || null,
    title: fm.Title || item.title,
  };
}
