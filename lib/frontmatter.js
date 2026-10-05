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
import {
  IDEA_LEGACY_STATUS_MAP,
  IDEA_STATUSES,
} from './domain.js';

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
    context: normalizeTaskContext(fm.Context),
    project: parseWikiLink(fm.Project),
    area: parseWikiLink(fm.Area),
    domain: fm.Domain || null,
    courses: parseWikiLinkArray(fm.Courses ?? fm['📕 Courses']),
    people: parseWikiLinkArray(fm.People),
    notesSummary: fm.Notes || null,
    tags: parseStringArray(fm.tags ?? fm.Tags),
  };
}

export function normalizeTaskContext(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return (
    { work: 'Work', personal: 'Personal', 'side projects': 'Side Projects' }[
      normalized
    ] || null
  );
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
 * Read path is tolerant: legacy statuses (Backburner/In Progress/Done) and
 * t-shirt effort sizes (Small/Large) map onto the canonical enum; unknown
 * statuses are preserved as-is. Writes stay strict (validated in the API).
 * @param {Object} fm - Raw frontmatter data
 * @returns {Object} Normalized idea fields
 */
export function extractIdeaFields(fm) {
  return {
    status: normalizeIdeaStatus(fm.Status) || fm.Status || 'Captured',
    domain: fm.Domain || null,
    context: normalizeTaskContext(fm.Context),
    impact: normalizeIdeaScore(fm.Impact),
    confidence: normalizeIdeaScore(fm.Confidence),
    effort: normalizeIdeaScore(fm.Effort),
    project: parseWikiLink(fm.Project),
    ideaCreated: parseDate(fm.Created),
    reviewedAt: parseDate(fm.Reviewed),
    notesSummary: fm.Notes || null,
    tags: parseStringArray(fm.tags ?? fm.Tags),
  };
}

/**
 * Normalize an idea status: canonical values pass through, legacy values map
 * onto the funnel taxonomy, anything else returns null.
 * @param {string} value
 * @returns {string|null}
 */
export function normalizeIdeaStatus(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (IDEA_LEGACY_STATUS_MAP[trimmed]) return IDEA_LEGACY_STATUS_MAP[trimmed];
  return (
    IDEA_STATUSES.find(
      (status) => status.toLowerCase() === trimmed.toLowerCase(),
    ) || null
  );
}

/**
 * Normalize an idea score (Impact/Confidence/Effort): canonical High/Medium/
 * Low pass through; legacy t-shirt sizes map onto the scale; junk returns null.
 * @param {string} value
 * @returns {string|null}
 */
export function normalizeIdeaScore(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  const canonical = { high: 'High', medium: 'Medium', low: 'Low' };
  if (canonical[normalized]) return canonical[normalized];
  const tShirt = {
    xs: 'Low',
    tiny: 'Low',
    small: 'Low',
    s: 'Low',
    m: 'Medium',
    large: 'High',
    l: 'High',
    xl: 'High',
    huge: 'High',
  };
  return tShirt[normalized] || null;
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
  // Normalize legacy task `Tags` to GBrain's canonical lowercase `tags` when
  // the web editor updates tags, avoiding two competing frontmatter values.
  if (Object.hasOwn(updates, 'tags')) delete data.Tags;

  return matter.stringify(parsed.content, data);
}

/**
 * Rewrite the body `## Attendees` section of a meeting note with one
 * `- [[Name]]` bullet per attendee. gbrain extracts backlinks from BODY
 * wikilinks (not frontmatter), so hand-entered attendees only become
 * person→meeting backlinks once they exist here.
 *
 * - Existing section: bullets between the `## Attendees` heading and the next
 *   `## ` heading are replaced.
 * - Missing section: inserted before `## Transcript` when present, else before
 *   the first `## ` heading, else appended at the end.
 * - Empty list renders `- TBD` (matches the meeting pipeline's scaffold).
 *
 * @param {string} raw - Full Markdown file content
 * @param {string[]} names - Canonical attendee names (already resolved)
 * @returns {string} Updated Markdown file content
 */
export function patchAttendeesSection(raw, names) {
  const bullets = (names || []).length
    ? (names || []).map((name) => `- ${toWikiLink(name)}`).join('\n')
    : '- TBD';
  const section = `## Attendees\n\n${bullets}\n`;

  const lines = raw.split('\n');
  const headingIdx = lines.findIndex((line) =>
    /^##\s+Attendees\s*$/.test(line),
  );
  if (headingIdx !== -1) {
    let endIdx = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) {
        endIdx = i;
        break;
      }
    }
    return [
      ...lines.slice(0, headingIdx),
      ...section.split('\n'),
      ...lines.slice(endIdx),
    ].join('\n');
  }

  // Section missing — find an insertion point.
  const transcriptIdx = lines.findIndex((line) =>
    /^##\s+Transcript\s*$/.test(line),
  );
  const anyHeadingIdx = lines.findIndex(
    (line, idx) => idx > 0 && /^##\s+/.test(line),
  );
  const insertIdx =
    transcriptIdx !== -1
      ? transcriptIdx
      : anyHeadingIdx !== -1
        ? anyHeadingIdx
        : null;
  if (insertIdx === null) {
    const trimmed = raw.replace(/\n+$/, '');
    return `${trimmed}\n\n${section}`;
  }
  return [
    ...lines.slice(0, insertIdx),
    ...section.split('\n'),
    ...lines.slice(insertIdx),
  ].join('\n');
}

/** Keep task relationship wikilinks in the body for GBrain graph extraction. */
export function patchTaskRelatedSection(raw, fields) {
  const relationFields = {
    Project: fields.project,
    Area: fields.area,
    Person: fields.people,
    Course: fields.courses,
  };
  const replacements = new Map(
    Object.entries(relationFields)
      .filter(([, value]) => value !== undefined)
      .map(([label, value]) => [
        label,
        (Array.isArray(value) ? value : [value])
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .map((item) => `- ${label}: ${toWikiLink(item)}`),
      ]),
  );
  if (replacements.size === 0) return raw;

  const lines = raw.split('\n');
  const headingIdx = lines.findIndex((line) => /^##\s+Related\s*$/.test(line));
  if (headingIdx !== -1) {
    let endIdx = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) {
        endIdx = i;
        break;
      }
    }
    const existing = lines.slice(headingIdx + 1, endIdx);
    const retained = existing.filter((line) => {
      const match = line.match(/^\s*[-*]\s+(Project|Area|Person|Course):/);
      return !match || !replacements.has(match[1]);
    });
    const newLinks = [...replacements.values()].flat();
    const related = [...retained, ...newLinks];
    return [
      ...lines.slice(0, headingIdx + 1),
      ...related,
      ...lines.slice(endIdx),
    ].join('\n');
  }

  const related = ['## Related', ...[...replacements.values()].flat(), ''];
  const notesIdx = lines.findIndex((line) => /^##\s+Notes\s*$/.test(line));
  const insertIdx = notesIdx === -1 ? lines.length : notesIdx;
  return [
    ...lines.slice(0, insertIdx),
    ...related,
    ...lines.slice(insertIdx),
  ].join('\n');
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
  if (apiFields.context !== undefined) {
    updates.Context = apiFields.context || '';
  }
  if (apiFields.project !== undefined) {
    updates.Project = apiFields.project ? toWikiLink(apiFields.project) : '';
  }
  if (apiFields.area !== undefined) {
    updates.Area = apiFields.area ? toWikiLink(apiFields.area) : '';
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
  if (apiFields.tags !== undefined) {
    updates.tags = parseStringArray(apiFields.tags);
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
  if (apiFields.context !== undefined) {
    updates.Context = apiFields.context || '';
  }
  if (apiFields.impact !== undefined) {
    updates.Impact = apiFields.impact || '';
  }
  if (apiFields.confidence !== undefined) {
    updates.Confidence = apiFields.confidence || '';
  }
  if (apiFields.effort !== undefined) {
    updates.Effort = apiFields.effort || '';
  }
  if (apiFields.project !== undefined) {
    updates.Project = apiFields.project ? toWikiLink(apiFields.project) : '';
  }
  if (apiFields.ideaCreated !== undefined) {
    updates.Created = apiFields.ideaCreated || '';
  }
  if (apiFields.reviewedAt !== undefined) {
    updates.Reviewed = apiFields.reviewedAt || '';
  }
  if (apiFields.notesSummary !== undefined) {
    updates.Notes = apiFields.notesSummary || '';
  }
  if (apiFields.tags !== undefined) {
    updates.tags = parseStringArray(apiFields.tags);
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
