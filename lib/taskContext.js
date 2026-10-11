/**
 * lib/taskContext.js — Classify auto-created tasks into a Task Context
 * (Work | Personal | Side Projects) and inherit Area from linked projects.
 *
 * Used by the automated task-creation surfaces (meeting pipeline proposed
 * tasks, DingTalk attention tasks) so new tasks do not all land in the
 * Kanban "Unclassified" context bucket. Classification is best-effort:
 * failures never block task creation, they just leave the context unset.
 */

import matter from 'gray-matter';
import { readNote } from '@/lib/vault';
import { normalizeTaskContext } from '@/lib/frontmatter';
import { parseWikiLink } from '@/lib/wikilinks';
import { completeLight } from '@/lib/meetingPipeline/llm';

const CONTEXT_SYSTEM_PROMPT = `Classify tasks into exactly one Task Context, or null when uncertain.

Allowed values (case-sensitive): "Work", "Personal", "Side Projects", null.

Rules:
- Work: duties of the user's job — school operations, teaching, curriculum, hiring, admissions, parent communication, admin, vendor/partner coordination.
- Personal: private life — family, health, household, errands, travel not tied to a business venture.
- Side Projects: self-directed ventures and hobbies the user may grow — content channels, indie apps, club experiments outside job duties.
- Return null when the task could plausibly belong to more than one context and the input gives no decisive signal.

Return only JSON in this exact shape (one entry per input task, same order):
["Work", null, "Side Projects"]`;

/**
 * Classify a batch of tasks into task contexts via one light-tier LLM call.
 * @param {Array<{title: string, actionItem?: string}>} tasks
 * @param {Object} [hint] - Provenance that disambiguates borderline cases.
 * @param {string} [hint.meetingTitle]
 * @param {string} [hint.meetingType]
 * @param {string[]} [hint.attendees]
 * @param {string} [hint.summary]
 * @param {string} [hint.whyRelevant]
 * @param {Function} [callLlm] - Test seam; defaults to completeLight.
 * @returns {Promise<Array<(string|null)>>} One normalized context per task,
 *   null when unknown. Same length as the input array (empty input → []).
 */
export async function classifyTaskContexts(tasks, hint = {}, callLlm = completeLight) {
  const list = Array.isArray(tasks) ? tasks : [];
  const fallback = () => list.map(() => null);
  if (!list.length) return [];

  const taskLines = list
    .map((task, index) => {
      const detail = task?.actionItem ? ` — ${task.actionItem}` : '';
      return `${index + 1}. ${task?.title || 'Untitled task'}${detail}`;
    })
    .join('\n');

  const hintLines = [
    hint.meetingTitle && `Provenance: meeting "${hint.meetingTitle}"`,
    hint.meetingType && `Meeting type: ${hint.meetingType}`,
    hint.attendees?.length && `Attendees: ${hint.attendees.join(', ')}`,
    hint.summary && `Summary: ${hint.summary}`,
    hint.whyRelevant && `Why relevant: ${hint.whyRelevant}`,
  ].filter(Boolean);

  try {
    const text = await callLlm({
      system: CONTEXT_SYSTEM_PROMPT,
      user: `${hintLines.join('\n') || 'Provenance: (none)'}\n\nTasks:\n${taskLines}`,
      // Reasoning-tier light models spend output budget on thinking before the
      // JSON array; 900 keeps batched classifications from hitting
      // finish_reason=length (500 truncated 20-item backfill batches).
      maxTokens: 900,
      temperature: 0,
    });
    return mapClassifiedContexts(text, list.length);
  } catch (error) {
    console.error('[task-context] classification failed; leaving contexts unset', error);
    return fallback();
  }
}

/**
 * Parse and validate an LLM classification response against a task count.
 * Exported for tests; the production path is classifyTaskContexts.
 * @param {string} text - Raw LLM output (expected: JSON array of strings/null)
 * @param {number} expectedCount
 * @returns {Array<(string|null)>}
 */
export function mapClassifiedContexts(text, expectedCount) {
  let rawValues;
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    rawValues = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.contexts)
        ? parsed.contexts
        : [];
  } catch {
    rawValues = [];
  }
  const contexts = [];
  for (let index = 0; index < expectedCount; index += 1) {
    contexts.push(normalizeTaskContext(rawValues[index]) || null);
  }
  return contexts;
}

function stripCodeFence(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/**
 * Read the Area frontmatter from a project note so task-creation surfaces can
 * inherit it when they have a project link but no resolved area.
 * @param {string} projectName - Bare project note name (no wiki brackets)
 * @returns {Promise<string|null>} The linked area name, or null on any failure.
 */
export async function inheritAreaFromProject(projectName) {
  const name = String(projectName || '')
    .replace(/^\[\[/, '')
    .replace(/\]\]$/, '')
    .trim();
  if (!name) return null;
  try {
    const raw = await readNote(`projects/${name}.md`);
    const { data } = matter(raw);
    return parseWikiLink(data.Area) || null;
  } catch {
    return null;
  }
}
