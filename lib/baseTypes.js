/**
 * lib/baseTypes.js — Detect note types in the vault.
 *
 * Notes identify their type via lowercase `Type:` frontmatter + folder-prefix
 * inference. This module maps vault notes to the canonical type strings used
 * throughout the app (database baseType, API responses, UI routing).
 */

/** Map of vault `Type:` frontmatter values to canonical app type slugs. */
const FRONTMATTER_TYPE_MAP = {
  task: 'task',
  project: 'project',
  area: 'area',
  idea: 'idea',
  meeting: 'meeting',
  journal: 'journal',
  course: 'course',
  resource: 'resource',
  transaction: 'transaction',
  person: 'person',
  atom: 'knowledge',
  concept: 'knowledge',
  source: 'knowledge',
  decision: 'knowledge',
  'log-entry': 'knowledge',
  'current-state': 'knowledge',
  digest: 'knowledge',
  runbook: 'knowledge',
  writing: 'knowledge',
  analysis: 'knowledge',
  knowledge: 'knowledge',
};

/** Folder-prefix → canonical app type slug (gbrain brain layout). */
const PATH_TYPE_MAP = [
  ['tasks/', 'task'],
  ['projects/', 'project'],
  ['areas/', 'area'],
  ['ideas/', 'idea'],
  ['meetings/', 'meeting'],
  ['journal/', 'journal'],
  ['courses/', 'course'],
  ['resources/', 'resource'],
  ['people/', 'person'],
  ['atoms/', 'knowledge'],
  ['concepts/', 'knowledge'],
  ['sources/', 'knowledge'],
  ['decisions/', 'knowledge'],
  ['log-entries/', 'knowledge'],
  ['current-state/', 'knowledge'],
  ['digests/', 'knowledge'],
  ['runbooks/', 'knowledge'],
  ['writing/', 'knowledge'],
];

/** Types that get indexed into the database. */
const INDEXABLE_TYPES = new Set([
  'task',
  'project',
  'idea',
  'area',
  'meeting',
  'transaction',
  'journal',
  'knowledge',
  'dashboard',
]);

/** Types that have their own typed Prisma models. */
const TYPED_MODEL_TYPES = new Set([
  'task',
  'project',
  'idea',
  'meeting',
]);

/**
 * Extract the canonical type slug from frontmatter + path.
 * Priority: lowercase `Type:` frontmatter → path-prefix inference → legacy
 * `base` field (pre-migration files) → "unknown".
 * @param {Object} fm - Parsed frontmatter data
 * @param {string} [filepath] - Vault-relative path
 * @returns {string}
 */
export function detectNoteType(fm = {}, filepath = '') {
  const typeField = fm.Type;
  if (typeof typeField === 'string' && typeField.trim()) {
    const mapped = FRONTMATTER_TYPE_MAP[typeField.trim().toLowerCase()];
    if (mapped) return mapped;
  }
  return inferBaseTypeFromPath(filepath);
}

/**
 * Infer a canonical type from brain-relative path when frontmatter Type is
 * missing or unmapped.
 * @param {string} filepath
 * @returns {string}
 */
export function inferBaseTypeFromPath(filepath) {
  if (!filepath) return 'unknown';
  if (filepath === 'Dashboard.md') return 'dashboard';
  for (const [prefix, type] of PATH_TYPE_MAP) {
    if (filepath.startsWith(prefix)) return type;
  }
  return 'unknown';
}

/**
 * Check if a note type should be indexed into the database.
 * @param {string} baseType - Canonical type slug from detectNoteType()
 * @returns {boolean}
 */
export function isIndexableType(baseType) {
  return INDEXABLE_TYPES.has(baseType);
}

/**
 * Check if a note type has a dedicated typed Prisma model (Task, Project, Idea, Meeting).
 * @param {string} baseType - Canonical type slug from detectNoteType()
 * @returns {boolean}
 */
export function hasTypedModel(baseType) {
  return TYPED_MODEL_TYPES.has(baseType);
}
