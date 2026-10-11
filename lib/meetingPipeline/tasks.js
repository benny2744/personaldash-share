import path from 'path';
import matter from 'gray-matter';
import {
  ensureUniqueFilename,
  listMarkdownFiles,
  readNote,
  writeNote,
} from '@/lib/vault';
import { triggerGbrainSync } from '@/lib/gbrainSync';
import { MEETING_TYPES } from '@/lib/domain';
import { classifyTaskContexts, inheritAreaFromProject } from '@/lib/taskContext';
import { completeLight } from './llm';
import { repairAndParseJson } from './jsonExtract';

function stripCodeFence(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractJson(text) {
  return repairAndParseJson(text, { array: true });
}

function normalizeActionItem(item) {
  return String(item || '')
    .replace(/^[-*]\s+/, '')
    .replace(/^\[[ x]\]\s*/i, '')
    .trim();
}

function isRealActionItem(item) {
  const normalized = normalizeActionItem(item);
  return (
    normalized &&
    !/^no explicit action items?\b/i.test(normalized) &&
    !/^\[?none\]?$/i.test(normalized)
  );
}

function fallbackTitle(item) {
  const normalized = normalizeActionItem(item)
    .replace(/\s+\([^)]*\)\s*$/, '')
    .replace(/\s+[\u2014-]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.slice(0, 90) || 'Follow up on meeting action item';
}

function trailingParenthetical(item) {
  const match = normalizeActionItem(item).match(/\(([^)]*)\)\s*$/);
  return match?.[1]?.trim() || '';
}

function withoutWiki(value) {
  return String(value || '')
    .replace(/^\[\[/, '')
    .replace(/\]\]$/, '')
    .trim();
}

function wiki(name) {
  const value = withoutWiki(name);
  return value ? `[[${value}]]` : '';
}

function exactMatches(candidates, names) {
  const available = new Map(
    (names || []).map((name) => [String(name).toLowerCase(), name]),
  );
  return [
    ...new Set(
      (candidates || [])
        .map((item) => available.get(String(item || '').toLowerCase()))
        .filter(Boolean),
    ),
  ];
}

function normalizeGeneratedTask(task, actionItem, vaultContext) {
  const people = Array.isArray(task?.people)
    ? exactMatches(task.people, vaultContext?.people)
    : [];
  const when = /^\d{4}-\d{2}-\d{2}$/.test(String(task?.when || ''))
    ? task.when
    : null;
  const title =
    String(task?.title || fallbackTitle(actionItem))
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90) || fallbackTitle(actionItem);

  return {
    title,
    actionItem: normalizeActionItem(actionItem),
    people,
    when,
    displayOwner: people.length
      ? people.join(', ')
      : trailingParenthetical(actionItem),
  };
}

function fallbackTasks(actionItems, vaultContext) {
  return actionItems
    .filter(isRealActionItem)
    .map((actionItem) => normalizeGeneratedTask({}, actionItem, vaultContext));
}

function parseGeneratedTasks(text) {
  const json = extractJson(text);
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.tasks)) return json.tasks;
  throw new Error('LLM JSON did not contain a tasks array');
}

export async function generateProposedTasks({
  actionItems,
  meetingTitle,
  meetingDate,
  attendees,
  vaultContext,
}) {
  const realActionItems = (actionItems || []).filter(isRealActionItem);
  if (!realActionItems.length) return [];

  const system = `Convert meeting action items into Obsidian task note metadata.

Return only JSON in this exact shape:
[
  {"title":"Short imperative task title","people":["Exact existing Person note name"],"when":"YYYY-MM-DD or null"}
]

Rules:
- Preserve one output object per input action item, in the same order.
- title should be a clean imperative phrase without checkbox syntax, owner annotations, or due-date parentheticals.
- people must use exact names from Existing People or be [].
- when must be an absolute YYYY-MM-DD date when a deadline is explicit or resolvable from the meeting date; otherwise null.
- Do not invent tasks, people, or dates.`;

  const user = `Meeting: ${meetingTitle || 'Untitled meeting'}
Meeting date: ${meetingDate || '(unknown)'}
Attendees: ${(attendees || []).join(', ') || '(none identified)'}
Existing People: ${(vaultContext?.people || []).join(', ') || '(none found)'}

Action items:
${realActionItems.map((item, index) => `${index + 1}. ${normalizeActionItem(item)}`).join('\n')}`;

  try {
    const text = await completeLight({
      system,
      user,
      maxTokens: 2000,
      temperature: 0.1,
    });
    const generated = parseGeneratedTasks(text);
    return realActionItems.map((actionItem, index) =>
      normalizeGeneratedTask(generated[index], actionItem, vaultContext),
    );
  } catch (error) {
    console.error('[meeting-pipeline] task metadata generation failed', error);
    return fallbackTasks(realActionItems, vaultContext);
  }
}

export function buildTaskMarkdown({ task, meetingBasename, project, area, context }) {
  const projectLink = wiki(project);
  const areaLink = wiki(area);
  const frontmatter = {
    Type: 'task',
    Status: 'Proposed',
    'Priority Level': 'Medium',
    When: task.when || null,
    Project: projectLink,
    Context: context || null,
    Area: areaLink || null,
    People: task.people.map(wiki),
    Meetings: [wiki(meetingBasename)],
    Domain: null,
    Notes: 'Proposed from meeting action item',
    tags: ['type/task'],
  };

  const body = `# ${task.title}

## Why
Proposed action item captured from [[${meetingBasename}]].

## Checklist
- [ ] ${task.actionItem}

## Related
${[
  project && `- Project: ${wiki(project)}`,
  area && `- Area: ${wiki(area)}`,
  ...task.people.map((person) => `- Person: ${wiki(person)}`),
  `- Meeting: ${wiki(meetingBasename)}`,
]
  .filter(Boolean)
  .join('\n')}

## Notes
Source meeting: [[${meetingBasename}]]
`;

  return matter.stringify(body, frontmatter);
}

/**
 * Duplicate guard: retries of the same meeting must not re-create the same
 * proposed task. A task counts as existing when a task note's normalized
 * filename prefix matches the normalized title prefix (filenames truncate
 * long titles) AND its frontmatter links back to this meeting.
 */
async function findExistingTaskFor(title, meetingBasename) {
  const normalize = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  const titlePrefix = normalize(title).slice(0, 40);
  if (!titlePrefix) return null;
  let files;
  try {
    files = await listMarkdownFiles('tasks');
  } catch {
    return null;
  }
  const candidates = files.filter((file) => {
    const base = normalize(
      String(file)
        .replace(/^tasks\//, '')
        .replace(/\.md$/i, ''),
    );
    return base.startsWith(titlePrefix) || titlePrefix.startsWith(base);
  });
  for (const candidate of candidates.slice(0, 5)) {
    try {
      const raw = await readNote(candidate);
      const { data } = matter(raw);
      const meetings = Array.isArray(data.Meetings)
        ? data.Meetings
        : [data.Meetings].filter(Boolean);
      if (meetings.some((link) => String(link).includes(meetingBasename))) {
        return path.basename(candidate, '.md');
      }
    } catch {
      /* unreadable candidate — keep looking */
    }
  }
  return null;
}

/**
 * Deterministic floor: a recognized meeting type is by definition a work
 * gathering, so any task the LLM could not classify defaults to Work.
 * Exported for tests.
 */
export function applyMeetingTypeFloor(contexts, meetingType) {
  if (!MEETING_TYPES.includes(meetingType)) return contexts;
  return contexts.map((context) => context || 'Work');
}

export async function createProposedTaskNotes({
  tasks,
  meetingBasename,
  project,
  area,
  meetingType,
  attendees,
}) {
  const links = [];
  const taskList = Array.isArray(tasks) ? tasks : [];
  if (!taskList.length) return links;

  let contexts = await classifyTaskContexts(taskList, {
    meetingTitle: meetingBasename,
    meetingType,
    attendees,
  });
  contexts = applyMeetingTypeFloor(contexts, meetingType);

  let inheritedArea = area;
  if (!inheritedArea && project) {
    inheritedArea = await inheritAreaFromProject(project);
  }

  for (let taskIndex = 0; taskIndex < taskList.length; taskIndex += 1) {
    const task = taskList[taskIndex];
    try {
      const existing = await findExistingTaskFor(task.title, meetingBasename);
      if (existing) {
        console.log(
          '[meeting-pipeline] proposed task already exists for this meeting; skipping duplicate',
          { title: task.title, existing },
        );
        links.push({
          title: task.title,
          basename: existing,
          displayOwner: task.displayOwner || '',
        });
        continue;
      }
      const taskPath = await ensureUniqueFilename('tasks', `${task.title}.md`);
      await writeNote(
        taskPath,
        buildTaskMarkdown({
          task,
          meetingBasename,
          project,
          area: inheritedArea,
          context: contexts[taskIndex] || null,
        }),
      );
      triggerGbrainSync('proposed-task');
      const basename = path.basename(taskPath, '.md');
      links.push({
        title: task.title,
        basename,
        displayOwner: task.displayOwner || '',
      });
    } catch (error) {
      console.error(
        '[meeting-pipeline] failed to create proposed task note',
        task?.title,
        error,
      );
    }
  }
  return links;
}
