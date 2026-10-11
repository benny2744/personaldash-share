/**
 * lib/meetingPipeline/analysis.js — the authoritative whole-transcript meeting
 * analysis (meeting_analysis_v1): parsing support, validation, entity
 * resolution, evidence locating, stable-ID assignment, and the reuse invariant.
 *
 * Pipeline order (locked design):
 *   raw model output → parse/schema check → entity validation → evidence
 *   locating → stable-ID assignment → persist. Only the validated object is
 *   persisted; raw model text stays in meeting_jobs.opencode_raw_output.
 *
 * Identity model:
 *   analysis_id       — minted per analysis generation (uuid)
 *   analysis_input_hash — sha256 of the cleaned transcript; reuse requires
 *                       schema support + matching input hash. Model/prompt
 *                       version changes NEVER invalidate (provenance only).
 *   entity_update_id  — persisted per update ("eu_01…"), stable across retries
 *   effect identity   — downstream: sha256(analysis_id + entity_update_id)
 *   fact dedupe       — secondary, meeting-scoped, soft-check only (never the
 *                       effect identity, never cross-meeting)
 *
 * Entity identity = vault-relative filepath ("people/Sarah Chen.md").
 * Resolution statuses: resolved | unresolved | proposed_new. A claimed
 * resolution that fails vault validation is downgraded to unresolved;
 * proposed_new never implies the note has been created.
 *
 * Evidence: the model emits a short verbatim quote; locating (exact →
 * whitespace/punctuation-tolerant regex → located:false) is deterministic code.
 * The quote is preserved even when not located. Offsets reference the
 * persisted cleaned transcript.
 */
import crypto from 'node:crypto';

export const ANALYSIS_SCHEMA_VERSION = 'meeting_analysis_v1';
/**
 * Bump when the formatter-agent prompt contract changes. Provenance only —
 * persisted analyses are keyed off analysis_input_hash, never this value.
 */
export const ANALYSIS_PROMPT_VERSION = '2';

const KIND_TO_DIR = { person: 'people', project: 'projects', area: 'areas' };
const LOG_CATEGORIES = new Set([
  'decision',
  'commitment',
  'status_change',
  'milestone',
  'risk',
  'blocker',
]);
const PROFILE_CATEGORIES = new Set([
  'role_change',
  'preference',
  'background_fact',
]);
const UPDATE_CATEGORIES = new Set([...LOG_CATEGORIES, ...PROFILE_CATEGORIES]);
/** Below this confidence an update is treated as weak inference and dropped. */
const MIN_UPDATE_CONFIDENCE = 0.5;
/** Safety cap on evidence quote length before locating (model is told ≤30 words). */
const MAX_QUOTE_CHARS = 600;

export function sha256Hex(text) {
  return crypto
    .createHash('sha256')
    .update(String(text ?? ''), 'utf8')
    .digest('hex');
}

export function analysisInputHash(cleanedTranscript) {
  return `sha256:${sha256Hex(cleanedTranscript)}`;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ---------- entity resolution ----------

function namesForKind(vaultContext, kind) {
  if (kind === 'person') return vaultContext?.people || [];
  if (kind === 'project') return vaultContext?.projects || [];
  if (kind === 'area') return vaultContext?.areas || [];
  return [];
}

function aliasesForKind(vaultContext, kind) {
  if (kind === 'person') return vaultContext?.peopleAliases || {};
  if (kind === 'project') return vaultContext?.projectsAliases || {};
  if (kind === 'area') return vaultContext?.areasAliases || {};
  return {};
}

function normalizeKind(kind) {
  const value = String(kind || '').toLowerCase();
  return KIND_TO_DIR[value] ? value : null;
}

/**
 * Resolve an observed/claimed name to a canonical vault note name for the
 * given kind (exact case-insensitive match, then the frontmatter alias map).
 * Returns null when no authoritative match exists — never invents one.
 */
export function resolveEntityName(name, kind, vaultContext) {
  const wanted = String(name || '')
    .trim()
    .toLowerCase();
  if (!wanted || !kind) return null;
  const names = namesForKind(vaultContext, kind);
  const direct = names.find((n) => n.toLowerCase() === wanted);
  if (direct) return direct;
  const canonical = aliasesForKind(vaultContext, kind)[wanted];
  if (canonical && names.includes(canonical)) return canonical;
  return null;
}

export function entityIdFor(kind, canonicalName) {
  return canonicalName && KIND_TO_DIR[kind]
    ? `${KIND_TO_DIR[kind]}/${canonicalName}.md`
    : null;
}

// ---------- evidence locating ----------

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Locate a quote inside the cleaned transcript.
 * Tier 1: exact substring. Tier 2: regex with flexible whitespace runs, case
 * insensitivity, and quote/apostrophe/dash variants. Otherwise located:false
 * with the quote preserved. Offsets always reference the original transcript.
 */
export function locateEvidence(quote, transcript) {
  const q = String(quote || '')
    .trim()
    .slice(0, MAX_QUOTE_CHARS);
  const notLocated = {
    quote: q,
    char_start: null,
    char_end: null,
    located: false,
  };
  if (!q || !transcript) return notLocated;

  const direct = transcript.indexOf(q);
  if (direct >= 0) {
    return {
      quote: q,
      char_start: direct,
      char_end: direct + q.length,
      located: true,
    };
  }

  const source = q
    .split(/\s+/)
    .map((token) =>
      escapeRegExp(token)
        .replace(/['‘’]/g, "['‘’]")
        .replace(/["“”]/g, '["“”]')
        .replace(/[-–—]/g, '[-–—]'),
    )
    .join('\\s+');
  try {
    const match = new RegExp(source, 'i').exec(transcript);
    if (match) {
      return {
        quote: q,
        char_start: match.index,
        char_end: match.index + match[0].length,
        located: true,
      };
    }
  } catch {
    // Pathological quote regex — fall through to not-located.
  }
  return notLocated;
}

// ---------- field normalizers ----------

function normalizeRole(role) {
  const value = String(role || '').toLowerCase();
  return value === 'attendee' ? 'attendee' : 'mentioned';
}

function normalizeDue(due) {
  return isNonEmptyString(due) && /^\d{4}-\d{2}-\d{2}$/.test(due.trim())
    ? due.trim()
    : null;
}

function validPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

// ---------- validation (raw model JSON → authoritative analysis) ----------

function validateEntities(jsonEntities, vaultContext) {
  const seen = new Set();
  return (Array.isArray(jsonEntities) ? jsonEntities : [])
    .map((entry) => {
      const observed = String(entry?.observed_name ?? entry?.name ?? '').trim();
      const kind = normalizeKind(entry?.kind);
      if (!observed || !kind) return null;
      const claimed = String(entry?.canonical_name ?? '').trim();
      // Prefer an exact vault match on the observed name; otherwise validate
      // the model's claimed canonical name. A failed claim downgrades to
      // unresolved — the model's word alone never establishes identity.
      const resolved =
        resolveEntityName(observed, kind, vaultContext) ||
        (claimed ? resolveEntityName(claimed, kind, vaultContext) : null);
      let status = ['resolved', 'unresolved', 'proposed_new'].includes(
        entry?.resolution_status,
      )
        ? entry.resolution_status
        : null;
      if (resolved) status = 'resolved';
      else if (status === 'resolved' || !status) status = 'unresolved';
      const dedupeKey = resolved
        ? `id:${kind}:${resolved}`
        : `obs:${kind}:${observed.toLowerCase()}:${status}`;
      if (seen.has(dedupeKey)) return null;
      seen.add(dedupeKey);
      return {
        entity_id: entityIdFor(kind, resolved),
        canonical_name: resolved,
        observed_name: observed,
        kind,
        role: normalizeRole(entry?.role),
        resolution_status: status,
      };
    })
    .filter(Boolean);
}

function validateDecisions(jsonDecisions, cleanedTranscript) {
  let seq = 0;
  return (Array.isArray(jsonDecisions) ? jsonDecisions : [])
    .map((d) => {
      const text = isNonEmptyString(d)
        ? d.trim()
        : String(d?.text || '').trim();
      if (!text) return null;
      seq += 1;
      return {
        decision_id: `dec_${pad2(seq)}`,
        text,
        evidence: locateEvidence(
          isNonEmptyString(d) ? '' : d?.quote,
          cleanedTranscript,
        ),
      };
    })
    .filter(Boolean);
}

function validateActionItems(jsonItems, vaultContext, cleanedTranscript) {
  let seq = 0;
  return (Array.isArray(jsonItems) ? jsonItems : [])
    .map((item) => {
      const action = isNonEmptyString(item)
        ? item.trim()
        : String(item?.action || item?.title || item?.task || '').trim();
      if (!action) return null;
      const ownerRaw = isNonEmptyString(item)
        ? ''
        : String(
            item?.owner_name ?? item?.owner ?? item?.assignee ?? '',
          ).trim();
      const ownerCanonical = ownerRaw
        ? resolveEntityName(ownerRaw, 'person', vaultContext)
        : null;
      seq += 1;
      return {
        action_item_id: `act_${pad2(seq)}`,
        action,
        owner_entity_id: entityIdFor('person', ownerCanonical),
        owner_name: ownerCanonical || ownerRaw,
        due: isNonEmptyString(item) ? null : normalizeDue(item?.due),
        due_text:
          !isNonEmptyString(item) && isNonEmptyString(item?.due_text)
            ? item.due_text.trim()
            : null,
        evidence: locateEvidence(
          isNonEmptyString(item) ? '' : item?.quote,
          cleanedTranscript,
        ),
      };
    })
    .filter(Boolean);
}

function validateEntityUpdates(jsonUpdates, vaultContext, cleanedTranscript) {
  let seq = 0;
  const dropped = [];
  const updates = (Array.isArray(jsonUpdates) ? jsonUpdates : [])
    .map((u) => {
      const kind = normalizeKind(u?.kind);
      const fact = String(u?.fact || '').trim();
      if (!kind || !fact) return null;
      const confidence = Number.isFinite(Number(u?.confidence))
        ? Number(u.confidence)
        : null;
      if (confidence != null && confidence < MIN_UPDATE_CONFIDENCE) {
        dropped.push({ fact, reason: 'low_confidence' });
        return null;
      }
      const observed = String(u?.entity_name ?? u?.canonical_name ?? '').trim();
      if (!observed) return null;
      const resolved = resolveEntityName(observed, kind, vaultContext);
      const category = UPDATE_CATEGORIES.has(u?.category)
        ? u.category
        : 'background_fact';
      const updateType =
        u?.update_type === 'log' || u?.update_type === 'profile'
          ? u.update_type
          : LOG_CATEGORIES.has(category)
            ? 'log'
            : 'profile';
      seq += 1;
      return {
        entity_update_id: `eu_${pad2(seq)}`,
        entity_id: entityIdFor(kind, resolved),
        observed_name: observed,
        kind,
        update_type: updateType,
        category,
        fact,
        confidence,
        resolution_status: resolved ? 'resolved' : 'unresolved',
        evidence: locateEvidence(u?.quote, cleanedTranscript),
      };
    })
    .filter(Boolean);
  return { updates, dropped };
}

function analysisShell(ctx, promptVersion) {
  const { metadata, cleanedTranscript, model, rawTranscript } = ctx;
  return {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    analysis_id: crypto.randomUUID(),
    analysis_input_hash: analysisInputHash(cleanedTranscript),
    raw_transcript_hash: rawTranscript
      ? analysisInputHash(rawTranscript)
      : null,
    model: model || null,
    prompt_version: promptVersion,
    created_at: new Date().toISOString(),
    meeting: {
      date: metadata?.date || null,
      type: metadata?.type || null,
      topic: metadata?.topic || null,
      project: null,
      area: null,
    },
  };
}

/**
 * Validate raw v1 model JSON into the authoritative analysis. Throws when the
 * output is unusable (not an object / missing summary_en) so callers can fall
 * back; otherwise downgrades and drops are recorded inside the result.
 */
export function validateAnalysis(json, ctx) {
  if (!validPlainObject(json)) {
    throw new Error('analysis contract is not a JSON object');
  }
  if (!isNonEmptyString(json.summary_en)) {
    throw new Error('analysis contract missing summary_en');
  }
  const { vaultContext, cleanedTranscript } = ctx;
  const analysis = analysisShell(ctx, ANALYSIS_PROMPT_VERSION);
  analysis.meeting.project =
    resolveEntityName(json.meeting?.project, 'project', vaultContext) || null;
  analysis.meeting.area =
    resolveEntityName(json.meeting?.area, 'area', vaultContext) || null;
  analysis.entities = validateEntities(json.entities, vaultContext);
  analysis.decisions = validateDecisions(json.decisions, cleanedTranscript);
  analysis.action_items = validateActionItems(
    json.action_items,
    vaultContext,
    cleanedTranscript,
  );
  const { updates, dropped } = validateEntityUpdates(
    json.entity_updates,
    vaultContext,
    cleanedTranscript,
  );
  analysis.entity_updates = updates;
  if (dropped.length) {
    analysis.dropped_updates = dropped;
  }
  analysis.summary_en = String(json.summary_en).trim();
  analysis.frontmatter_extra = validPlainObject(json.frontmatter_extra)
    ? json.frontmatter_extra
    : {};
  return analysis;
}

/**
 * Up-convert a legacy v0 format contract ({summary_en, summary_zh,
 * action_items, decisions, frontmatter_extra}) into the v1 analysis shape so
 * every downstream consumer sees one interface. Entities/updates stay empty —
 * v0 never had transcript-wide semantic output.
 */
export function upconvertV0Contract(contract, ctx) {
  const analysis = analysisShell(ctx, '0-upconvert');
  analysis.entities = [];
  analysis.decisions = (
    Array.isArray(contract?.decisions) ? contract.decisions : []
  )
    .filter(isNonEmptyString)
    .map((text, i) => ({
      decision_id: `dec_${pad2(i + 1)}`,
      text: text.trim(),
      evidence: locateEvidence('', ctx.cleanedTranscript),
    }));
  analysis.action_items = (
    Array.isArray(contract?.action_items) ? contract.action_items : []
  )
    .map((item, i) => {
      const action = String(item?.title || '').trim();
      if (!action) return null;
      const ownerRaw = String(item?.owner || '').trim();
      const ownerCanonical = ownerRaw
        ? resolveEntityName(ownerRaw, 'person', ctx.vaultContext)
        : null;
      return {
        action_item_id: `act_${pad2(i + 1)}`,
        action,
        owner_entity_id: entityIdFor('person', ownerCanonical),
        owner_name: ownerCanonical || ownerRaw,
        due: normalizeDue(item?.due),
        due_text: null,
        evidence: locateEvidence('', ctx.cleanedTranscript),
      };
    })
    .filter(Boolean);
  analysis.entity_updates = [];
  analysis.summary_en = String(contract?.summary_en || '').trim();
  analysis.frontmatter_extra = validPlainObject(contract?.frontmatter_extra)
    ? contract.frontmatter_extra
    : {};
  return analysis;
}

/**
 * Derive the legacy contract shape from an authoritative analysis so existing
 * assembly/task code keeps working unchanged.
 */
export function contractFromAnalysis(analysis, { summaryZh } = {}) {
  return {
    summary_en: analysis.summary_en,
    summary_zh: summaryZh || '',
    action_items: (analysis.action_items || []).map((a) => ({
      title: a.action,
      owner: a.owner_name || '',
      due: a.due || null,
    })),
    decisions: (analysis.decisions || []).map((d) => d.text),
    frontmatter_extra: analysis.frontmatter_extra || {},
  };
}

/**
 * The reuse invariant: an existing analysis is authoritative iff the schema is
 * supported AND the cleaned transcript it analyzed is unchanged. Model/prompt
 * drift never invalidates; regeneration is a deliberate new generation.
 */
export function loadReusableAnalysis(analysisJson, cleanedTranscript) {
  if (!analysisJson) return null;
  let parsed;
  try {
    parsed = JSON.parse(analysisJson);
  } catch {
    return null;
  }
  if (parsed?.schema_version !== ANALYSIS_SCHEMA_VERSION) return null;
  if (parsed.analysis_input_hash !== analysisInputHash(cleanedTranscript)) {
    return null;
  }
  return parsed;
}

// ---------- precedence helpers (analysis authoritative over provisional metadata) ----------

/** Resolved attendee canonical names from the analysis (empty when none). */
export function analysisAttendees(analysis) {
  return [
    ...new Set(
      (analysis?.entities || [])
        .filter(
          (e) =>
            e.kind === 'person' && e.role === 'attendee' && e.canonical_name,
        )
        .map((e) => e.canonical_name),
    ),
  ];
}

export function analysisProject(analysis) {
  return analysis?.meeting?.project || '';
}

export function analysisArea(analysis) {
  return analysis?.meeting?.area || '';
}

/** sha256(analysis_id + entity_update_id) — the identity of one applied effect. */
export function effectIdFor(analysisId, entityUpdateId) {
  return sha256Hex(`${analysisId}:${entityUpdateId}`);
}

/** Meeting-scoped normalized-fact hash — secondary duplicate defense only. */
export function factHashFor(entityId, fact) {
  const normalized = String(fact || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return sha256Hex(`${entityId || ''}|${normalized}`);
}
