/**
 * lib/wikilinks.js — Parse and resolve Obsidian [[wiki-link]] syntax.
 *
 * Handles: [[Name]], [[Name|Alias]], bare strings, and arrays of wiki-links.
 * Used by the indexer and frontmatter modules to extract plain-text values
 * from frontmatter fields that store wiki-link references.
 */

/**
 * Extract the target name from a single wiki-link string.
 * "[[Project Name]]"     → "Project Name"
 * "[[Project Name|Alias]]" → "Project Name"
 * "Plain string"         → "Plain string"
 * ""                     → null
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function parseWikiLink(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
  if (match) return match[1].trim();

  return trimmed;
}

/**
 * Check whether a string is in wiki-link format.
 * @param {string} value
 * @returns {boolean}
 */
export function isWikiLink(value) {
  if (!value || typeof value !== 'string') return false;
  return /^\[\[.+\]\]$/.test(value.trim());
}

/**
 * Parse an array of wiki-links into plain string values.
 * ["[[Alice]]", "[[Bob]]"] → ["Alice", "Bob"]
 * Handles mixed arrays (some wiki-links, some plain strings).
 * Filters out null/empty results.
 * @param {Array<string>|string|null|undefined} arr
 * @returns {string[]}
 */
export function parseWikiLinkArray(arr) {
  if (!arr) return [];
  if (typeof arr === 'string') {
    const parsed = parseWikiLink(arr);
    return parsed ? [parsed] : [];
  }
  if (!Array.isArray(arr)) return [];

  return arr
    .map((item) => parseWikiLink(item))
    .filter((item) => item !== null);
}

/**
 * Wrap a plain string back into wiki-link format for write-back.
 * "Project Name" → "[[Project Name]]"
 * @param {string|null|undefined} name
 * @returns {string}
 */
export function toWikiLink(name) {
  if (!name || typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (isWikiLink(trimmed)) return trimmed;
  return `[[${trimmed}]]`;
}

/**
 * Wrap an array of plain strings back into wiki-link format.
 * ["Alice", "Bob"] → ["[[Alice]]", "[[Bob]]"]
 * @param {string[]} names
 * @returns {string[]}
 */
export function toWikiLinkArray(names) {
  if (!Array.isArray(names)) return [];
  return names.map(toWikiLink).filter(Boolean);
}
