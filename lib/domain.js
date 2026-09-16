export const TASK_STATUSES = ['Proposed', 'Todo', 'Doing', 'Done', 'Archived'];
export const TASK_PRIORITIES = ['High', 'Medium', 'Low'];
export const PROJECT_STATUSES = ['Active', 'Idea', 'Done'];
export const IDEA_STATUSES = ['Backburner', 'Exploring', 'In Progress', 'Done', 'Abandoned'];
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
  { value: 'backburner', label: 'Backburner', color: 'var(--status-backburner)' },
  { value: 'exploring', label: 'Exploring', color: 'var(--status-exploring)' },
  { value: 'inprogress', label: 'In Progress', color: 'var(--status-doing)' },
  { value: 'done', label: 'Done', color: 'var(--status-done)' },
  { value: 'abandoned', label: 'Abandoned', color: 'var(--status-abandoned)' },
];

export const IDEA_STATUS_LABELS = Object.fromEntries(
  IDEA_BOARD_STATUSES.map((status) => [status.value, status.label]),
);
