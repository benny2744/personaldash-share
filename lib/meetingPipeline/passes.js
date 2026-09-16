import matter from 'gray-matter';
import config from '@/lib/config';
import { DEFAULT_MEETING_TYPE, MEETING_TYPES } from '@/lib/domain';
import { complete, completeLight } from './llm';
import { analysisAttendees, analysisProject, analysisArea } from './analysis';
import { toDateStr } from '@/lib/dates';

export { DEFAULT_MEETING_TYPE, MEETING_TYPES } from '@/lib/domain';
export const KNOWN_PEOPLE = config.meetingKnownPeople;
const MEETING_TYPE_SCHEMA = MEETING_TYPES.join('|');
const SINGLE_CALL_TRANSCRIPT_LIMIT = 2500;
const CLEAN_CHUNK_CHARS = 2500;
const MIN_CLEAN_CHUNK_CHARS = 600;
const CLEAN_CHUNK_MAX_TOKENS = 5000;
const SUMMARY_CHUNK_CHARS = 10000;
const METADATA_PREVIEW_EDGE_CHARS = 1500;

function isoDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime()))
    return toDateStr(new Date());
  return toDateStr(date);
}

function dateFromFilename(sourceName) {
  const name = String(sourceName || '');
  const candidates = [];
  const ymd = /\b(20\d{2})([-_.])(0?[1-9]|1[0-2])\2(0?[1-9]|[12]\d|3[01])\b/g;
  const mdy = /\b(0?[1-9]|1[0-2])([-_.])(0?[1-9]|[12]\d|3[01])\2(20\d{2})\b/g;

  for (const match of name.matchAll(ymd)) {
    candidates.push({
      index: match.index,
      year: match[1],
      month: match[3],
      day: match[4],
    });
  }

  for (const match of name.matchAll(mdy)) {
    candidates.push({
      index: match.index,
      year: match[4],
      month: match[1],
      day: match[3],
    });
  }

  candidates.sort((a, b) => a.index - b.index);

  for (const candidate of candidates) {
    const date = `${candidate.year}-${candidate.month.padStart(2, '0')}-${candidate.day.padStart(2, '0')}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === date &&
      parsed.getTime() <= Date.now() + 24 * 60 * 60 * 1000
    ) {
      return date;
    }
  }

  return null;
}

function stripMetaBlock(text) {
  return text.replace(/<!--\s*meeting-meta[\s\S]*?-->\s*/i, '').trim();
}

function safeMeetingTypeForFilename(type) {
  return String(type || DEFAULT_MEETING_TYPE)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeEnglishTopic(value, sourceName = 'Meeting Notes') {
  const fallback = sourceName.replace(/\.[^.]+$/, '') || 'Meeting Notes';
  const ascii = String(value || fallback)
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ascii.slice(0, 80) || 'Meeting Notes';
}

export function parsePass1Output(
  text,
  sourceName = 'Meeting Audio',
  uploadDate = new Date(),
) {
  const match = text.match(/<!--\s*meeting-meta\s*([\s\S]*?)\s*-->/i);
  let metadata = {};
  if (match) {
    try {
      metadata = JSON.parse(match[1].trim());
    } catch {
      metadata = {};
    }
  }

  const date = dateFromFilename(sourceName) || isoDate(uploadDate);
  const type = MEETING_TYPES.includes(metadata.type)
    ? metadata.type
    : DEFAULT_MEETING_TYPE;
  const topic = sanitizeEnglishTopic(metadata.topic, sourceName);
  const fileType = safeMeetingTypeForFilename(type);

  return {
    metadata: {
      date,
      type,
      topic,
      attendees: Array.isArray(metadata.attendees) ? metadata.attendees : [],
      project: typeof metadata.project === 'string' ? metadata.project : '',
      area: typeof metadata.area === 'string' ? metadata.area : '',
      tags: Array.isArray(metadata.tags) ? metadata.tags : [],
      filename: `${date} - ${fileType} - ${topic}.md`,
    },
    cleanedTranscript: stripMetaBlock(text),
  };
}

function contextList(values) {
  return values?.length ? values.join(', ') : '(none found)';
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function isRetryableCleanError(error) {
  const message = errorMessage(error);
  return (
    message.includes('reasoning only') ||
    message.includes('missing message content') ||
    message.includes('UND_ERR_HEADERS_TIMEOUT') ||
    message.includes('timed out waiting for response headers') ||
    /\bLLM HTTP (429|5\d\d)\b/.test(message) ||
    message.includes('"code":"1305"') ||
    message.toLowerCase().includes('overloaded')
  );
}

function splitText(text, maxChars) {
  const paragraphs = String(text || '').split(/\n{2,}/);
  const chunks = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }
    for (let start = 0; start < paragraph.length; start += maxChars) {
      chunks.push(paragraph.slice(start, start + maxChars));
    }
    current = '';
  }

  if (current) chunks.push(current);
  return chunks.filter((chunk) => chunk.trim());
}

function transcriptPreview(text) {
  const value = String(text || '');
  const maxPreviewChars = METADATA_PREVIEW_EDGE_CHARS * 2;
  if (value.length <= maxPreviewChars) return value;
  return `${value.slice(0, METADATA_PREVIEW_EDGE_CHARS)}\n\n[...middle omitted for metadata extraction...]\n\n${value.slice(-METADATA_PREVIEW_EDGE_CHARS)}`;
}

function metadataPrompt({
  sourceName,
  uploadDate,
  vaultContext,
  rawTranscript,
  participantsContext,
}) {
  return `Source audio filename: ${sourceName || 'unknown'}
Upload date: ${isoDate(uploadDate)}

Meetings SOP excerpt:
${vaultContext?.meetingsSop || '(SOP not mounted; use built-in meeting schema)'}

Meeting template:
${vaultContext?.meetingTemplate || '(template not mounted)'}

Existing People notes:
${contextList(vaultContext?.people)}

Existing Project notes:
${contextList(vaultContext?.projects)}

Existing Area notes:
${contextList(vaultContext?.areas)}
${participantsContext ? `\n${participantsContext}\n` : ''}
ASR transcript excerpt:

${transcriptPreview(rawTranscript)}`;
}

function metadataBlockInstructions() {
  return `Output one metadata block exactly in this form:
<!-- meeting-meta
{"type":"${MEETING_TYPE_SCHEMA}","topic":"5-8 word English topic","attendees":["existing People note name"],"project":"existing Project note name or empty","area":"existing Area note name or empty","tags":["type/meeting","domain/..."]}
-->

Metadata rules:
- Do not output a date. The system sets the date from the audio filename or upload date.
- The topic must be English, concise, filename-safe, and semantically specific.
- Attendees/project/area should use exact existing Obsidian note names from the provided vault context when relevant.
- Do not invent People/Project/Area note names. Use an empty string/array when no exact match is clear.
- This is a short extraction task; keep any internal reasoning minimal and output only the requested metadata block.`;
}

function cleanTranscriptRules() {
  return `This is a verbatim cleaning pass, not a summarization pass. Every substantive word spoken must stay in the output.
This is a mechanical formatting task; keep any internal reasoning brief and proceed directly to the cleaned transcript.

Apply only these fixes:
- Correct obvious ASR errors from context.
- Add punctuation and paragraph breaks.
- Remove only pure filler such as repeated "那个那个", "然后然后", "uh uh", "um".
- Normalize speaker labels when a speaker is identifiable.
- Put each speaker turn on its own paragraph.

Do NOT summarize, condense, paraphrase, restructure into topical sections, omit side comments, or replace speech with descriptions.`;
}

export async function extractMetadataOnly(
  rawTranscript,
  sourceName,
  { uploadDate, vaultContext, participantsContext } = {},
) {
  const system = `Extract metadata for a permanent Obsidian meeting note.

Output only the metadata block. ${metadataBlockInstructions()}`;

  try {
    return await complete({
      system,
      user: metadataPrompt({
        sourceName,
        uploadDate,
        vaultContext,
        rawTranscript,
        participantsContext,
      }),
      maxTokens: 8000,
      temperature: 0.1,
    });
  } catch (error) {
    throw new Error(`metadata extraction: ${errorMessage(error)}`);
  }
}

async function cleanTranscriptChunk(chunk, index, total) {
  const system = `You are cleaning chunk ${index + 1} of ${total} from an ASR transcript for a permanent Obsidian meeting note.

${cleanTranscriptRules()}
Do NOT output metadata. Output only the cleaned transcript chunk.`;

  try {
    return await complete({
      system,
      user: `Raw ASR transcript chunk ${index + 1}/${total}:\n\n${chunk}`,
      maxTokens: CLEAN_CHUNK_MAX_TOKENS,
      temperature: 0.1,
    });
  } catch (error) {
    throw new Error(`chunk ${index + 1}/${total}: ${errorMessage(error)}`);
  }
}

async function cleanTranscriptChunkAdaptive(
  chunk,
  label,
  { onProgress, depth = 0 } = {},
) {
  try {
    return await cleanTranscriptChunk(chunk, label.index, label.total);
  } catch (error) {
    if (!isRetryableCleanError(error)) throw error;

    if (chunk.length <= MIN_CLEAN_CHUNK_CHARS) {
      // A raw ASR fragment is better than failing the whole meeting note after repeated provider pathologies.
      return chunk.trim();
    }

    const subchunks = splitText(chunk, Math.ceil(chunk.length / 2));
    if (subchunks.length <= 1) throw error;

    const cleanedSubchunks = [];
    for (let subIndex = 0; subIndex < subchunks.length; subIndex += 1) {
      await onProgress?.(
        `clean_chunk_${label.index + 1}_of_${label.total}_retry_${depth + 1}_${subIndex + 1}_of_${subchunks.length}`,
      );
      cleanedSubchunks.push(
        await cleanTranscriptChunkAdaptive(
          subchunks[subIndex],
          {
            index: subIndex,
            total: subchunks.length,
          },
          {
            onProgress,
            depth: depth + 1,
          },
        ),
      );
    }
    return cleanedSubchunks.join('\n\n');
  }
}

export async function runPass1Clean(
  rawTranscript,
  sourceName,
  { uploadDate, vaultContext, onProgress, participantsContext } = {},
) {
  if (rawTranscript.length > SINGLE_CALL_TRANSCRIPT_LIMIT) {
    await onProgress?.('clean_metadata');
    const metadata = await extractMetadataOnly(rawTranscript, sourceName, {
      uploadDate,
      vaultContext,
      participantsContext,
    });
    const chunks = splitText(rawTranscript, CLEAN_CHUNK_CHARS);
    const cleanedChunks = [];
    for (let index = 0; index < chunks.length; index += 1) {
      await onProgress?.(`clean_chunk_${index + 1}_of_${chunks.length}`);
      cleanedChunks.push(
        await cleanTranscriptChunkAdaptive(
          chunks[index],
          {
            index,
            total: chunks.length,
          },
          { onProgress },
        ),
      );
    }
    return parsePass1Output(
      `${metadata}\n\n${cleanedChunks.join('\n\n')}`,
      sourceName,
      uploadDate,
    );
  }

  const system = `You are cleaning an ASR transcript for a permanent Obsidian meeting note.

${cleanTranscriptRules()}

At the very top, ${metadataBlockInstructions()}
Then output the full cleaned transcript.
`;

  const user = metadataPrompt({
    sourceName,
    uploadDate,
    vaultContext,
    rawTranscript,
    participantsContext,
  });

  const output = await complete({
    system,
    user,
    maxTokens: 24000,
    temperature: 0.1,
  });
  return parsePass1Output(output, sourceName, uploadDate);
}

export async function runPass2Zh(
  cleanedTranscript,
  { supplementaryContext, onProgress } = {},
) {
  const fullText = supplementaryContext
    ? `${cleanedTranscript}\n\n--- Supplementary Materials ---\n${supplementaryContext}`
    : cleanedTranscript;

  if (fullText.length > SUMMARY_CHUNK_CHARS) {
    const chunks = splitText(fullText, SUMMARY_CHUNK_CHARS);
    const partials = [];
    for (let index = 0; index < chunks.length; index += 1) {
      await onProgress?.(`summary_zh_chunk_${index + 1}_of_${chunks.length}`);
      partials.push(
        await complete({
          system: `Write a detailed Chinese partial summary for transcript chunk ${index + 1} of ${chunks.length}. Preserve concrete names, numbers, decisions, action items, risks, and unresolved questions. Do not invent anything.`,
          user: `Cleaned transcript chunk ${index + 1}/${chunks.length}:\n\n${chunks[index]}`,
          maxTokens: 6000,
          temperature: 0.2,
        }),
      );
    }
    await onProgress?.('summary_zh_synthesize');
    return complete({
      system: `Synthesize these Chinese partial meeting summaries into one comprehensive Chinese-language meeting summary.

Mandatory sections:
- 会议背景与目的
- 核心讨论要点（按主题分段）
- 主要决定
- 行动项目与负责人
- 待跟进事项

Deduplicate repeated points, but do not omit concrete decisions, action items, names, numbers, or risks.`,
      user: `Partial summaries:\n\n${partials.map((partial, index) => `## Part ${index + 1}\n${partial}`).join('\n\n')}`,
      maxTokens: 10000,
      temperature: 0.2,
    });
  }

  const system = `Write a comprehensive Chinese-language summary of a meeting from a cleaned transcript.

Mandatory sections:
- 会议背景与目的
- 核心讨论要点（按主题分段）
- 主要决定
- 行动项目与负责人
- 待跟进事项

Length should match the depth of the meeting. Do not truncate. This must be standalone and readable for someone who was not present.`;

  return complete({
    system,
    user: `Cleaned transcript:\n\n${fullText}`,
    maxTokens: 10000,
    temperature: 0.2,
  });
}

/**
 * Translate the canonical English summary into the Chinese 中文总结 on the
 * light model tier. The strong analysis stage owns semantics; this is a pure
 * rendering transform. Failures degrade to an empty string (the note keeps
 * its English summary) rather than failing the meeting.
 */
export async function runPassTranslateZh(summaryEn) {
  const text = String(summaryEn || '').trim();
  if (!text) return '';
  try {
    const translated = await completeLight({
      system: `Translate this English meeting summary into Simplified Chinese for a permanent note.

Rules:
- Preserve all markdown structure exactly (## / ### headings, bullets, tables, task checkboxes).
- Preserve names, numbers, dates, and [[wikilinks]] verbatim.
- Translate faithfully — do not add, omit, or reinterpret content.
- Return only the Chinese markdown.`,
      user: text,
      maxTokens: 12000,
      temperature: 0.2,
    });
    return translated.trim();
  } catch (error) {
    console.error(
      '[meeting-pipeline] ZH translation failed; note keeps English summary only',
      error,
    );
    return '';
  }
}

export async function runPass3En(
  cleanedTranscript,
  { supplementaryContext, participantsContext, onProgress } = {},
) {
  const contextBlocks = [
    supplementaryContext
      ? `--- Supplementary Materials ---\n${supplementaryContext}`
      : '',
    participantsContext
      ? `--- Organizer-provided Participants Hints ---\n${participantsContext}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const fullText = contextBlocks
    ? `${cleanedTranscript}\n\n${contextBlocks}`
    : cleanedTranscript;

  if (fullText.length > SUMMARY_CHUNK_CHARS) {
    const chunks = splitText(fullText, SUMMARY_CHUNK_CHARS);
    const partials = [];
    for (let index = 0; index < chunks.length; index += 1) {
      await onProgress?.(`summary_en_chunk_${index + 1}_of_${chunks.length}`);
      partials.push(
        await complete({
          system: `Write a detailed English partial summary for transcript chunk ${index + 1} of ${chunks.length}. Preserve concrete names, numbers, decisions, action items, risks, and unresolved questions. Do not invent anything.`,
          user: `Cleaned transcript chunk ${index + 1}/${chunks.length}:\n\n${chunks[index]}`,
          maxTokens: 7000,
          temperature: 0.2,
        }),
      );
    }
    await onProgress?.('summary_en_synthesize');
    return complete({
      system: `Synthesize these English partial meeting summaries into one comprehensive English-language meeting summary.

Use these exact mandatory sections:

## Meeting Context & Purpose
[2-3 sentences on why this meeting happened]

## Key Discussion Themes
[One ### subsection per major topic. Each subsection must include specific details from the transcript, not just a one-liner.]

## Decisions
[Bulleted list of concrete decisions made]

## Action Items
- [ ] Task (@owner, due date if known)
[Every action item from the meeting. Do not omit any.]

## Open Questions & Risks
[Unresolved issues, blockers, and open questions]

Deduplicate repeated points, but do not omit concrete decisions, action items, names, numbers, or risks.`,
      user: `Partial summaries:\n\n${partials.map((partial, index) => `## Part ${index + 1}\n${partial}`).join('\n\n')}`,
      maxTokens: 12000,
      temperature: 0.2,
    });
  }

  const system = `Write a comprehensive English-language summary of a meeting from a cleaned transcript.

Use these exact mandatory sections:

## Meeting Context & Purpose
[2-3 sentences on why this meeting happened]

## Key Discussion Themes
[One ### subsection per major topic. Each subsection must include specific details from the transcript, not just a one-liner.]

## Decisions
[Bulleted list of concrete decisions made]

## Action Items
- [ ] Task (@owner, due date if known)
[Every action item from the meeting. Do not omit any.]

## Open Questions & Risks
[Unresolved issues, blockers, and open questions]

The summary must capture names, numbers, proposals, decisions, and action items.`;

  return complete({
    system,
    user: `Cleaned transcript:\n\n${fullText}`,
    maxTokens: 12000,
    temperature: 0.2,
  });
}

function extractSection(markdown, heading) {
  const lines = markdown.split('\n');
  const headingPattern = new RegExp(
    `^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
    'i',
  );
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start === -1) return '';

  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    section.push(line);
  }
  return section.join('\n').trim();
}

function bulletLines(section) {
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^-\s+\[[ x]\]/i.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '- '));
}

export function normalizeActionItemText(item) {
  return String(item || '')
    .replace(/^-\s+\[[ x]\]\s*/i, '')
    .replace(/^-\s+/, '')
    .trim();
}

export function parseActionItems(summaryEn) {
  return bulletLines(extractSection(summaryEn, 'Action Items'));
}

function exactMatches(candidates, names) {
  const available = new Map(
    (names || []).map((name) => [name.toLowerCase(), name]),
  );
  return [
    ...new Set(
      (candidates || [])
        .map((item) => available.get(String(item).toLowerCase()))
        .filter(Boolean),
    ),
  ];
}

function escapeRegex(value) {
  return String(value)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
}

function inferAttendees(cleanedTranscript, metadata, vaultContext) {
  const attendees = new Set();
  // Exact-name + alias matches: a person is inferred if the transcript mentions
  // their canonical name or any alias declared in their note's frontmatter.
  const aliasMap = vaultContext?.peopleAliases || {};
  const knownPeople = [...KNOWN_PEOPLE, ...(vaultContext?.people || [])];
  for (const person of knownPeople) {
    const terms = [person];
    for (const [aliasLower, canonical] of Object.entries(aliasMap)) {
      if (canonical === person && aliasLower !== person.toLowerCase())
        terms.push(aliasLower);
    }
    const pattern = terms.map((term) => `\\b${escapeRegex(term)}\\b`).join('|');
    if (pattern && new RegExp(pattern, 'i').test(cleanedTranscript)) {
      attendees.add(person);
    }
  }
  for (const person of exactMatches(metadata.attendees, vaultContext?.people)) {
    attendees.add(person);
  }
  return [...attendees];
}

function wiki(name) {
  return name ? `[[${name}]]` : '';
}

function toFrontmatterArray(values) {
  return values.filter(Boolean).map(wiki);
}

function findExistingName(preferred, names, text, aliasMap) {
  const exact = exactMatches([preferred], names)[0];
  if (exact) return exact;
  // Honor aliases: if `preferred` (or the text) matches a known alias, resolve
  // to that alias's canonical note name.
  if (aliasMap && preferred) {
    const canonical = aliasMap[String(preferred).toLowerCase()];
    if (canonical && (names || []).includes(canonical)) return canonical;
  }
  const list = names || [];
  const direct = list.find((name) =>
    new RegExp(escapeRegex(name), 'i').test(text),
  );
  if (direct) return direct;
  if (aliasMap) {
    for (const [aliasLower, canonical] of Object.entries(aliasMap)) {
      if (
        list.includes(canonical) &&
        new RegExp(`\\b${escapeRegex(aliasLower)}\\b`, 'i').test(text)
      ) {
        return canonical;
      }
    }
  }
  return '';
}

/**
 * Resolve meeting attendees/project/area. Precedence rule: the persisted
 * whole-transcript analysis is authoritative; the preview-based metadata pass
 * and deterministic transcript inference are provisional/fallback.
 *  - authoritative populated → wins over provisional
 *  - authoritative missing + provisional populated → provisional fills
 *  - authoritative populated + provisional null → authoritative preserved
 */
export function buildMeetingContext({
  metadata,
  cleanedTranscript,
  summaryEn,
  vaultContext,
  analysis,
}) {
  const authoritativeAttendees = analysisAttendees(analysis);
  const attendees = authoritativeAttendees.length
    ? authoritativeAttendees
    : inferAttendees(cleanedTranscript, metadata, vaultContext);
  const project =
    analysisProject(analysis) ||
    findExistingName(
      metadata.project,
      vaultContext?.projects,
      `${cleanedTranscript}\n${summaryEn}`,
      vaultContext?.projectsAliases,
    );
  const area =
    analysisArea(analysis) ||
    findExistingName(
      metadata.area,
      vaultContext?.areas,
      `${cleanedTranscript}\n${summaryEn}`,
      vaultContext?.areasAliases,
    );
  const title = `${metadata.date} - ${metadata.type} - ${metadata.topic}`;
  return { attendees, project, area, title };
}

function actionItemLinks(taskLinks) {
  return (taskLinks || [])
    .map((task) => task?.basename && `[[${task.basename}]]`)
    .filter(Boolean);
}

function actionItemBodyLines(actionItems, taskLinks) {
  const links = taskLinks || [];
  if (links.length) {
    return links
      .map((task) => {
        const owner = task.displayOwner ? ` (${task.displayOwner})` : '';
        return task.basename ? `- [ ] [[${task.basename}]]${owner}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return actionItems.length
    ? actionItems.join('\n')
    : '- [ ] No explicit action items captured.';
}

/**
 * Normalize action items from the opencode agent contract into a stable shape.
 * Accepts strings or {title, owner, due} objects.
 * @param {Array} items
 * @returns {Array<{title:string, owner:string, due:string|null}>}
 */
export function normalizeContractActionItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === 'string') {
        const text = normalizeActionItemText(item);
        return text ? { title: text, owner: '', due: null } : null;
      }
      if (item && typeof item === 'object') {
        const title = normalizeActionItemText(
          item.title || item.task || item.action,
        );
        if (!title) return null;
        const owner = String(item.owner || item.assignee || '').trim();
        const due =
          item.due && /^\d{4}-\d{2}-\d{2}$/.test(String(item.due))
            ? String(item.due)
            : null;
        return { title, owner, due };
      }
      return null;
    })
    .filter(Boolean);
}

const RESERVED_FRONTMATTER_KEYS = new Set([
  'base',
  'Date',
  'Type',
  'Attendees',
  'Project',
  'Area',
  'Action Items',
  'Decisions',
  'Notes',
  'people',
  'projects',
  'tags',
]);

/**
 * Convert contract action items into task-creation inputs (resolves owners
 * against existing Person notes so Task People links stay exact).
 * @param {Array<{title:string, owner:string, due:string|null}>} items
 * @param {Object} vaultContext
 * @returns {Array<{title:string, actionItem:string, people:string[], when:string|null, displayOwner:string}>}
 */
export function contractActionItemsToTaskInputs(items, vaultContext) {
  const people = new Map(
    (vaultContext?.people || []).map((name) => [name.toLowerCase(), name]),
  );
  return items.map((item) => {
    const resolved = item.owner
      ? item.owner
          .split(/[,/]&?|\band\b/i)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => people.get(s.toLowerCase()))
          .filter(Boolean)
      : [];
    return {
      title: item.title,
      actionItem: item.title,
      people: resolved,
      when: item.due,
      displayOwner: resolved.length ? resolved.join(', ') : item.owner,
    };
  });
}

/** True if the markdown body already contains a given top-level section. */
function hasTopSection(markdown, heading) {
  const pattern = new RegExp(
    `^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
    'im',
  );
  return pattern.test(markdown);
}

/**
 * Assemble the final meeting note Markdown.
 *
 * Two input modes:
 *  - code path: pass `summaryZh` + `summaryEn` (markdown). Sections are parsed
 *    from summaryEn to drive frontmatter + the fixed body layout.
 *  - opencode path: pass a `contract` ({summary_en, summary_zh, action_items,
 *    decisions, frontmatter_extra}). The contract's summary_en becomes the
 *    type-specific body; action_items/decisions drive frontmatter + Task notes.
 *
 * In both cases the frontmatter scaffold, Attendees resolution, the 中文总结
 * block, and the verbatim `## Transcript` are produced deterministically here.
 */
export function runPass4Assemble({
  metadata,
  cleanedTranscript,
  summaryZh,
  summaryEn,
  vaultContext,
  taskLinks,
  contract,
  analysis,
}) {
  const useContract = contract && typeof contract === 'object';
  const bodySummaryEn = useContract
    ? String(contract.summary_en || '')
    : summaryEn;
  const summaryZhText = useContract
    ? String(contract.summary_zh || '') || String(summaryZh || '')
    : summaryZh;

  const { attendees, project, area, title } = buildMeetingContext({
    metadata,
    cleanedTranscript,
    summaryEn: bodySummaryEn,
    vaultContext,
    analysis,
  });

  let decisions;
  let actionItems;
  let notes;
  if (useContract) {
    decisions = (
      Array.isArray(contract.decisions) ? contract.decisions : []
    ).map((item) => normalizeActionItemText(item));
    actionItems = normalizeContractActionItems(contract.action_items).map(
      (item) => item.title,
    );
    notes = '';
  } else {
    decisions = bulletLines(extractSection(summaryEn, 'Decisions'));
    actionItems = parseActionItems(summaryEn);
    notes = extractSection(summaryEn, 'Open Questions & Risks');
  }

  const linkedActionItems = actionItemLinks(taskLinks);
  const attendeesBlock = attendees.length
    ? attendees.map((name) => `- ${wiki(name)}`).join('\n')
    : '- TBD';

  const frontmatter = {
    Type: 'meeting',
    Subtype: metadata.type,
    Date: metadata.date,
    Attendees: toFrontmatterArray(attendees),
    Project: project ? wiki(project) : '',
    Area: area ? wiki(area) : '',
    'Action Items': linkedActionItems.length
      ? linkedActionItems
      : actionItems.map(normalizeActionItemText).filter(Boolean),
    Decisions: decisions.map((item) => item.replace(/^-\s+/, '')).join('; '),
    Notes: notes.split('\n').slice(0, 5).join(' ').trim(),
    people: toFrontmatterArray(attendees),
    projects: project ? [wiki(project)] : [],
    tags: [
      ...new Set([
        'type/meeting',
        ...(metadata.tags || []).filter(
          (tag) => typeof tag === 'string' && tag !== 'type/meeting',
        ),
      ]),
    ],
  };

  // Merge type-specific extras from the agent, never overriding the scaffold.
  if (
    useContract &&
    contract.frontmatter_extra &&
    typeof contract.frontmatter_extra === 'object'
  ) {
    for (const [key, value] of Object.entries(contract.frontmatter_extra)) {
      if (
        !RESERVED_FRONTMATTER_KEYS.has(key) &&
        value !== undefined &&
        value !== null
      ) {
        frontmatter[key] = value;
      }
    }
  }

  let body;
  if (useContract) {
    const summaryEnBody = bodySummaryEn.trim() || '_(No summary generated.)_';
    const zhSection =
      summaryZhText.trim() && !hasTopSection(summaryEnBody, '中文总结')
        ? `\n\n## 中文总结\n${summaryZhText.trim()}\n`
        : '';
    body = `# ${title}

${summaryEnBody}${zhSection}

## Attendees
${attendeesBlock}

## Transcript
<!-- verbatim cleaned transcript — full word-for-word record of the meeting -->
${cleanedTranscript.trim()}
`;
  } else {
    const meetingContextPurpose = extractSection(
      summaryEn,
      'Meeting Context & Purpose',
    );
    body = `# ${title}

## Meeting Context & Purpose
${meetingContextPurpose || 'No meeting context captured.'}

## Attendees
${attendeesBlock}

## Agenda
${extractSection(summaryEn, 'Key Discussion Themes') || '- Review transcript and summaries.'}

## Decisions
${decisions.length ? decisions.join('\n') : '- No explicit decisions captured.'}

## Action Items
${actionItemBodyLines(actionItems, taskLinks)}

## Notes
${notes || 'No open questions or blockers captured.'}

## 中文总结
${summaryZh.trim()}

## Transcript
<!-- verbatim cleaned transcript — full word-for-word record of the meeting -->
${cleanedTranscript.trim()}
`;
  }

  return matter.stringify(body, frontmatter);
}
