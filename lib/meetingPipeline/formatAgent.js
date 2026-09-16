/**
 * lib/meetingPipeline/formatAgent.js — Routes the summarize/format stage to a
 * per-type opencode agent over HTTP and validates the returned JSON contract.
 *
 * The agent's system prompt (an editable .md file on the opencode host) carries
 * the type-specific format + the shared output contract. This module only builds
 * the user prompt (cleaned transcript + vault context) and validates the result;
 * on any failure it throws so job.js can fall back to the deterministic code path.
 */

import config from '@/lib/config';
import { repairAndParseJson } from './jsonExtract';
import {
  runAgent,
  createSession,
  abortSession,
  opencodeTimeoutSignal,
} from './opencodeClient';
import { normalizeContractActionItems } from './passes';
import {
  ANALYSIS_SCHEMA_VERSION,
  validateAnalysis,
  upconvertV0Contract,
  contractFromAnalysis,
} from './analysis';

/**
 * Resolve the opencode agent name for a meeting type.
 * Honors config.opencodeAgentByType overrides (env JSON map), else falls
 * back to the generic `meeting-default` agent — define custom per-type
 * agents on the opencode host and map them via OPENCODE_AGENT_BY_TYPE.
 */
export function agentForType(type) {
  const override = config.opencodeAgentByType?.[type];
  if (override) return override;
  return 'meeting-default';
}

function contextList(values) {
  return values?.length ? values.join(', ') : '(none found)';
}

/**
 * Candidate list for one entity kind, with aliases inline so the agent can
 * match observed names to canonical notes: "Name (aliases: a, b), …".
 */
function candidateList(names, aliases) {
  if (!names?.length) return '(none found)';
  return names
    .map((name) => {
      const aliasList = Object.entries(aliases || {})
        .filter(([, canonical]) => canonical === name)
        .map(([alias]) => alias)
        .filter((alias) => alias !== name.toLowerCase());
      return aliasList.length
        ? `${name} (aliases: ${aliasList.join(', ')})`
        : name;
    })
    .join(', ');
}

function buildPrompt({
  metadata,
  cleanedTranscript,
  vaultContext,
  supplementaryContext,
  participantsContext,
}) {
  return `Meeting date: ${metadata.date}
Meeting type: ${metadata.type}
Topic: ${metadata.topic}

Existing People notes (use exact names when linking):
${candidateList(vaultContext?.people, vaultContext?.peopleAliases)}

Existing Project notes (use exact names when linking):
${candidateList(vaultContext?.projects, vaultContext?.projectsAliases)}

Existing Area notes (use exact names when linking):
${candidateList(vaultContext?.areas, vaultContext?.areasAliases)}
${participantsContext ? `\n${participantsContext}\n` : ''}${supplementaryContext ? `\nSupplementary materials:\n${supplementaryContext}\n` : ''}
Cleaned transcript:

${cleanedTranscript}`;
}

function parseFormatJson(text) {
  return repairAndParseJson(text, { array: false });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate the agent contract shape. Returns a normalized contract or throws.
 * @param {string} text
 * @returns {{summary_en:string, summary_zh:string, action_items:Array, decisions:Array, frontmatter_extra:Object}}
 */
export function parseFormatContract(text) {
  const json = parseFormatJson(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('opencode agent contract is not a JSON object');
  }
  if (!isNonEmptyString(json.summary_en)) {
    throw new Error('opencode agent contract missing summary_en');
  }
  return {
    summary_en: String(json.summary_en).trim(),
    summary_zh: isNonEmptyString(json.summary_zh)
      ? String(json.summary_zh).trim()
      : '',
    action_items: normalizeContractActionItems(json.action_items),
    decisions: Array.isArray(json.decisions)
      ? json.decisions.filter((d) => isNonEmptyString(d))
      : [],
    frontmatter_extra:
      json.frontmatter_extra &&
      typeof json.frontmatter_extra === 'object' &&
      !Array.isArray(json.frontmatter_extra)
        ? json.frontmatter_extra
        : {},
  };
}

/** Cheap parseability probe for recovery loops (no validation side effects). */
export function isParseableContract(text) {
  try {
    const json = parseFormatJson(text);
    return (
      json &&
      typeof json === 'object' &&
      !Array.isArray(json) &&
      isNonEmptyString(json.summary_en)
    );
  } catch {
    return false;
  }
}

/**
 * Parse agent output into the authoritative meeting_analysis_v1 plus the
 * legacy contract derived from it. v0 outputs (no entities/entity_updates
 * arrays) are up-converted so downstream consumers see one interface.
 *
 * @param {string} text - raw agent output
 * @param {Object} ctx - { vaultContext, cleanedTranscript, metadata, model, rawTranscript }
 * @returns {{ analysis:Object, contract:Object }}
 */
export function parseAnalysisContract(text, ctx) {
  const json = parseFormatJson(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('opencode agent contract is not a JSON object');
  }
  const looksV1 =
    json.schema_version === ANALYSIS_SCHEMA_VERSION ||
    Array.isArray(json.entities) ||
    Array.isArray(json.entity_updates);
  if (looksV1) {
    const analysis = validateAnalysis(json, ctx);
    return { analysis, contract: contractFromAnalysis(analysis) };
  }
  const contract = parseFormatContract(text);
  return { analysis: upconvertV0Contract(contract, ctx), contract };
}

/** Human-readable opencode session title for a meeting. */
export function formatSessionTitle(pass1) {
  const { metadata } = pass1;
  return `Meeting: ${metadata.date} - ${metadata.type} - ${metadata.topic}`;
}

/**
 * Run the per-type format agent for a meeting.
 *
 * @param {Object} params
 * @param {Object} params.pass1 - Output of runPass1Clean ({metadata, cleanedTranscript}).
 * @param {Object} params.vaultContext
 * @param {string} [params.rawTranscript] - raw ASR text (provenance hash only).
 * @param {string} [params.sessionID] - Existing opencode session to reuse.
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ contract:Object, analysis:Object, sessionID:string }>}
 */
export async function runFormatAgent({
  pass1,
  vaultContext,
  sessionID,
  signal,
  model,
  supplementaryContext,
  participantsContext,
  rawTranscript,
}) {
  const { metadata, cleanedTranscript } = pass1;
  const agent = agentForType(metadata.type);
  const title = formatSessionTitle(pass1);
  const usedModel = model || config.opencodeFormatterModel;

  const { text, sessionID: resolvedSessionID } = await runAgent({
    agent,
    model: usedModel,
    title,
    prompt: buildPrompt({
      metadata,
      cleanedTranscript,
      vaultContext,
      supplementaryContext,
      participantsContext,
    }),
    sessionID,
    signal,
  });

  const { analysis, contract } = parseAnalysisContract(text, {
    vaultContext,
    cleanedTranscript,
    metadata,
    model: usedModel,
    rawTranscript,
  });
  return { contract, analysis, sessionID: resolvedSessionID };
}

export { createSession, abortSession, opencodeTimeoutSignal };
