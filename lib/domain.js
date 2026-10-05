export const TASK_STATUSES = ['Proposed', 'Todo', 'Doing', 'Done', 'Archived'];
export const TASK_PRIORITIES = ['High', 'Medium', 'Low'];
export const TASK_CONTEXTS = ['Work', 'Personal', 'Side Projects'];
export const PROJECT_STATUSES = ['Active', 'Idea', 'Done'];
export const IDEA_STATUSES = [
  'Captured',
  'Incubating',
  'Exploring',
  'Graduated',
  'Shipped',
  'Retired',
  'Abandoned',
];
export const IDEA_FUNNEL_STATUSES = ['Captured', 'Incubating', 'Exploring'];
export const IDEA_CLOSED_STATUSES = [
  'Graduated',
  'Shipped',
  'Retired',
  'Abandoned',
];
export const IDEA_SCORES = ['High', 'Medium', 'Low'];
/**
 * Meeting types are user-specific: override via env (comma-separated), e.g.
 *   MEETING_TYPES="Standup,1:1,Client,Review" DEFAULT_MEETING_TYPE="Standup"
 * The defaults below are intentionally generic.
 */
export const MEETING_TYPES = (
  process.env.MEETING_TYPES ||
  'General, 1:1, Team, Client, Interview, Review, Other'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
export const DEFAULT_MEETING_TYPE =
  process.env.DEFAULT_MEETING_TYPE || MEETING_TYPES[0];

export const TASK_BOARD_STATUSES = [
  { value: 'proposed', label: 'Proposed' },
  { value: 'todo', label: 'To Do' },
  { value: 'doing', label: 'Doing' },
  { value: 'done', label: 'Done' },
];

export const IDEA_BOARD_STATUSES = [
  { value: 'captured', label: 'Captured', color: 'var(--idea-captured)' },
  {
    value: 'incubating',
    label: 'Incubating',
    color: 'var(--idea-incubating)',
  },
  { value: 'exploring', label: 'Exploring', color: 'var(--idea-exploring)' },
  {
    value: 'graduated',
    label: 'Graduated',
    color: 'var(--idea-graduated)',
  },
  { value: 'shipped', label: 'Shipped', color: 'var(--idea-shipped)' },
  { value: 'retired', label: 'Retired', color: 'var(--idea-retired)' },
  {
    value: 'abandoned',
    label: 'Abandoned',
    color: 'var(--idea-abandoned)',
  },
];

export const IDEA_STATUS_LABELS = Object.fromEntries(
  IDEA_BOARD_STATUSES.map((status) => [status.value, status.label]),
);

// Legacy statuses from before the funnel redesign, mapped to their canonical
// replacements. Used by the indexer normalization and the backfill script.
export const IDEA_LEGACY_STATUS_MAP = {
  Backburner: 'Incubating',
  'In Progress': 'Exploring',
  Done: 'Shipped',
};

// Badge variant per canonical idea status; shared by the card and drawer.
export const IDEA_STATUS_VARIANTS = {
  Captured: 'idea-captured',
  Incubating: 'idea-incubating',
  Exploring: 'idea-exploring',
  Graduated: 'idea-graduated',
  Shipped: 'idea-shipped',
  Retired: 'idea-retired',
  Abandoned: 'idea-abandoned',
};
