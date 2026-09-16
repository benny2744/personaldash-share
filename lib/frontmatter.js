/**
 * lib/frontmatter.js — Parse, extract, and patch YAML frontmatter for vault notes.
 *
 * Handles the actual Obsidian frontmatter schema: Status, Priority Level, When,
 * Project (wiki-link), People (wiki-link array), Domain, Courses, etc.
 * Uses gray-matter for parsing and stringify for write-back patching.
 */

import matter from 'gray-matter';
import {
  parseWikiLink,
  parseWikiLinkArray,
  toWikiLink,
  toWikiLinkArray,
} from './wikilinks.js';

/**
 * Parse a raw Markdown string into frontmatter data and body content.
 * @param {string} raw - Full Markdown file content
 * @returns {{ data: Object, content: string, raw: string }}
 */
export function parseFrontmatter(raw) {
  const parsed = matter(raw);
  return {
    data: parsed.data || {},
    content: parsed.content || '',
    raw,
  };
}

/**
 * Extract a display title from a note.
 * Priority: first H1 heading in body > filename stem > 'Untitled'
 * @param {Object} _frontmatter - Parsed frontmatter data (unused — title is not in FM)
 * @param {string} body - Markdown body content
 * @param {string} filepath - Relative filepath for fallback
 * @returns {string}
 */
export function extractTitle(_frontmatter, body, filepath) {
  // Look for first H1 heading
  const h1Match = body.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();

  // Fallback to filename without extension
  if (filepath) {
    const basename = filepath.split('/').pop() || '';
    return basename.replace(/\.md$/i, '') || 'Untitled';
  }

  return 'Untitled';
}

/**
 * Extract task-specific fields from frontmatter, resolving wiki-links.
 * @param {Object} fm - Raw frontmatter data
 * @returns {Object} Normalized task fields
 */
export function extractTaskFields(fm) {
  return {
    status: fm.Status || 'Todo',
    whenDate: parseDate(fm.When),
    priority: fm['Priority Level'] || 'Medium',
    project: parseWikiLink(fm.Project),
    domain: fm.Domain || null,
    courses: parseWikiLinkArray(fm.Courses ?? fm['📕 Courses']),
    people: parseWikiLinkArray(fm.People),
    notesSummary: fm.Notes || null,
    tags: parseStringArray(fm.tags),
  };
}

/**
 * Extract project-specific fields from frontmatter.
 * @param {Object} fm - Raw frontmatter data
 * @returns {Object} Normalized project fields
 */
export function extractProjectFields(fm) {
  return {
    status: fm.Status || 'Active',
    targetDate: parseDate(fm.Target),
    area: parseWikiLink(fm.Area),
    domain: fm.Domain || null,
    linkedTasks: parseWikiLinkArray(fm.Tasks ?? fm['☑️ Tasks']),
    people: parseWikiLinkArray(fm.People),
    notesSummary: fm.Notes || null,
    tags: parseStringArray(fm.tags),
  };
}

/**
 * Extract idea-specific fields from frontmatter.
 * @param {Object} fm - Raw frontmatter data
 * @returns {Object} Normalized idea fields
 */
export function extractIdeaFields(fm) {
  return {
    status: fm.Status || 'Backburner',
    domain: fm.Domain || null,
    impact: fm.Impact || null,
    effort: fm.Effort || null,
    ideaCreated: parseDate(fm.Created),
    notesSummary: fm.Notes || null,
    tags: parseStringArray(fm.tags),
  };
}

/**
 * Extract meeting-specific fields from frontmatter.
 * @param {Object} fm - Raw frontmatter data
 * @returns {Object} Normalized meeting fields
 */
export function extractMeetingFields(fm) {
  return {
    meetingDate: parseDate(fm.Date),
    meetingType: fm.Subtype || fm.Type || null,
    attendees: parseWikiLinkArray(fm.Attendees),
    project: parseWikiLink(fm.Project),
    area: parseWikiLink(fm.Area),
    actionItems: parseWikiLinkArray(fm['Action Items']),
    decisions: parseStringValue(fm.Decisions),
    notesSummary: fm.Notes || null,
    tags: parseStringArray(fm.tags),
  };
}

/**
 * Patch specific frontmatter fields in a raw Markdown string.
 * Only modifies the specified fields — preserves body content and other FM fields.
 *
 * @param {string} raw - Full Markdown file content
 * @param {Object} updates - Map of frontmatter keys to new values
 *   Use actual YAML key names: 'Status', 'Priority Level', 'When', 'Project', 'Domain'
 * @returns {string} Updated Markdown file content
 */
export function patchFrontmatterFields(raw, updates) {
  const parsed = matter(raw);
  const data = { ...parsed.data };

  for (const [key, value] of Object.entries(updates)) {
    data[key] = value;
  }

  return matter.stringify(parsed.content, data);
}

/**
 * Build the frontmatter updates object for write-back from API field names.
 * Translates API field names (camelCase) to actual YAML key names.
 * Re-wraps project names as wiki-links for vault compatibility.
 *
 * @param {Object} apiFields - API-style field updates
 * @returns {Object} YAML-key field updates ready for patchFrontmatterFields
 */
export function buildWriteBackUpdates(apiFields) {
  const updates = {};

  if (apiFields.status !== undefined) {
    updates.Status = apiFields.status;
  }
  if (apiFields.when !== undefined) {
    updates.When = apiFields.when || '';
  }
  if (apiFields.priority !== undefined) {
    updates['Priority Level'] = apiFields.priority;
  }
  if (apiFields.project !== undefined) {
    updates.Project = apiFields.project ? toWikiLink(apiFields.project) : '';
  }
  if (apiFields.domain !== undefined) {
    updates.Domain = apiFields.domain || '';
  }
  if (apiFields.people !== undefined) {
    updates.People = toWikiLinkArray(apiFields.people);
  }
  if (apiFields.courses !== undefined) {
    updates.Courses = toWikiLinkArray(apiFields.courses);
  }

  return updates;
}

/**
 * Build frontmatter updates for Idea notes from API field names.
 * @param {Object} apiFields - API-style field updates
 * @returns {Object} YAML-key field updates ready for patchFrontmatterFields
 */
export function buildIdeaWriteBackUpdates(apiFields) {
  const updates = {};

  if (apiFields.status !== undefined) {
    updates.Status = apiFields.status;
  }
  if (apiFields.domain !== undefined) {
    updates.Domain = apiFields.domain || '';
  }
  if (apiFields.impact !== undefined) {
    updates.Impact = apiFields.impact || '';
  }
  if (apiFields.effort !== undefined) {
    updates.Effort = apiFields.effort || '';
  }

  return updates;
}

/**
 * Build frontmatter updates for Meeting notes from API field names.
 * @param {Object} apiFields - API-style field updates
 * @returns {Object} YAML-key field updates ready for patchFrontmatterFields
 */
export function buildMeetingWriteBackUpdates(apiFields) {
  const updates = {};

  if (apiFields.meetingType !== undefined) {
    updates.Type = apiFields.meetingType || '';
  }
  if (apiFields.meetingDate !== undefined) {
    updates.Date = apiFields.meetingDate || '';
  }
  if (apiFields.attendees !== undefined) {
    updates.Attendees = toWikiLinkArray(apiFields.attendees);
  }
  if (apiFields.project !== undefined) {
    updates.Project = apiFields.project ? toWikiLink(apiFields.project) : '';
  }
  if (apiFields.area !== undefined) {
    updates.Area = apiFields.area ? toWikiLink(apiFields.area) : '';
  }
  if (apiFields.actionItems !== undefined) {
    updates['Action Items'] = toWikiLinkArray(apiFields.actionItems);
  }
  if (apiFields.decisions !== undefined) {
    updates.Decisions = apiFields.decisions || '';
  }

  return updates;
}

/**

/**
 * Build frontmatter updates for Project notes from API field names.
 * @param {Object} apiFields - API-style field updates
 * @returns {Object} YAML-key field updates ready for patchFrontmatterFields
 */
export function buildProjectWriteBackUpdates(apiFields) {
  const updates = {};

  if (apiFields.status !== undefined) {
    updates.Status = apiFields.status || '';
  }
  if (apiFields.targetDate !== undefined) {
    updates.Target = apiFields.targetDate || null;
  }
  if (apiFields.area !== undefined) {
    updates.Area = apiFields.area ? toWikiLink(apiFields.area) : null;
  }
  if (apiFields.domain !== undefined) {
    updates.Domain = apiFields.domain || '';
  }
  if (apiFields.people !== undefined) {
    updates.People = toWikiLinkArray(apiFields.people);
  }

  return updates;
}

/**
 * Parse a date value from frontmatter (string or Date object).
 * @param {string|Date|null|undefined} value
 * @returns {Date|null}
 */
function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function parseStringArray(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((item) => item !== null && item !== undefined)
    .map((item) => String(item).trim())
    .filter(Boolean);
}

function parseStringValue(value) {
  const values = parseStringArray(value);
  return values.length ? values.join('; ') : null;
}
