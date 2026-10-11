/**
 * lib/gbrain/search.js — read-only semantic + FTS search over the gbrain
 * corpus (public.pages × public.content_chunks).
 *
 * Semantic mode embeds the query via the LiteLLM gateway (same model gbrain
 * indexes with) and runs cosine distance against content_chunks.embedding.
 * FTS mode uses pages.search_vector with a trigram title fallback. All access
 * is SELECT-only via lib/gbrain/db.js — retrieval-only per the GBrain
 * Integration Contract.
 */

import config from '@/lib/config';
import { gbrainQuery, isGbrainSearchConfigured } from '@/lib/gbrain/db';

const MAX_QUERY_CHARS = 512;
const SNIPPET_CHARS = 280;
const EMBED_TIMEOUT_MS = 20_000;

/** Build the pgvector literal '[1,2,3]' for a query embedding. */
export function buildVectorLiteral(vector) {
  return `[${vector.map((n) => Number(n)).join(',')}]`;
}

/** Extract the embedding array from a LiteLLM /embeddings response. */
export function parseEmbeddingResponse(payload) {
  const vector = payload?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Embedding response contained no vector');
  }
  return vector;
}

/** Collapse whitespace and clamp a note body to a displayable snippet. */
export function toSnippet(text, query = '') {
  const flat = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  if (query) {
    const tokens = String(query)
      .split(/\s+/)
      .filter((t) => t.length > 1)
      .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ''));
    for (const token of tokens) {
      const idx = flat.toLowerCase().indexOf(token.toLowerCase());
      if (idx > 0) {
        const start = Math.max(0, idx - 80);
        const end = start + SNIPPET_CHARS;
        const slice = flat.slice(start, end);
        return (start > 0 ? '…' : '') + slice + (end < flat.length ? '…' : '');
      }
    }
  }
  return flat.length > SNIPPET_CHARS
    ? `${flat.slice(0, SNIPPET_CHARS)}…`
    : flat;
}

const RESULT_COLUMNS = `p.id, p.slug, p.title, p.type, p.source_path,
  p.updated_at`;

/**
 * Map a gbrain page to a vault-relative file path. gbrain slugs omit the
 * .md extension and source_path may be NULL; vault lookups (/api/vault/note)
 * need the real filename.
 */
export function toVaultPath(row) {
  const raw = row.source_path || row.slug || '';
  if (!raw || /\.(md|markdown)$/i.test(raw)) return raw;
  return `${raw}.md`;
}

function normalizeRows(rows, query = '') {
  return rows.map((row) => ({
    slug: row.slug,
    title: row.title,
    type: row.type,
    path: toVaultPath(row),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    score: Number(row.score) || 0,
    snippet: toSnippet(row.chunk_text || row.snippet_text, query),
  }));
}

// DISTINCT ON (p.id) must see EVERY eligible page: the inner query is not
// allowed a LIMIT, or it truncates to the lowest page IDs before ranking.
// Similarity ordering + LIMIT happen once in the outer query.
const SEMANTIC_SQL = `SELECT DISTINCT ON (p.id) ${RESULT_COLUMNS},
  c.chunk_text,
  1 - (c.embedding <=> $1::vector) AS score
FROM content_chunks c
JOIN pages p ON p.id = c.page_id
WHERE p.deleted_at IS NULL
  AND p.page_kind = 'markdown'
  AND c.embedding IS NOT NULL
ORDER BY p.id, c.embedding <=> $1::vector`;

// Wrapped to rank pages (not chunks) by similarity after DISTINCT ON picks
// the best chunk per page. `id` breaks score ties deterministically.
// Exported for SQL-shape regression tests.
export const SEMANTIC_RANKED_SQL = `SELECT id, slug, title, type, source_path,
  updated_at, chunk_text, score
FROM (${SEMANTIC_SQL}) best
ORDER BY score DESC, id
LIMIT $2`;

const FTS_SQL = `SELECT ${RESULT_COLUMNS},
  ts_rank(p.search_vector, websearch_to_tsquery($1)) AS score,
  NULL::text AS chunk_text,
  left(regexp_replace(p.compiled_truth, E'[\\\\n\\\\r\\\\t]+', ' ', 'g'), 400) AS snippet_text
FROM pages p
WHERE p.deleted_at IS NULL
  AND p.page_kind = 'markdown'
  AND p.search_vector @@ websearch_to_tsquery($1)
ORDER BY score DESC, p.updated_at DESC
LIMIT $2`;

// Trigram/substring title match — catches partial words the FTS query misses.
const TITLE_SQL = `SELECT ${RESULT_COLUMNS},
  GREATEST(similarity(p.title, $1), CASE WHEN p.title ILIKE '%' || $1 || '%' THEN 0.5 ELSE 0 END) AS score,
  NULL::text AS chunk_text,
  left(regexp_replace(p.compiled_truth, E'[\\\\n\\\\r\\\\t]+', ' ', 'g'), 400) AS snippet_text
FROM pages p
WHERE p.deleted_at IS NULL
  AND p.page_kind = 'markdown'
  AND (p.title % $1 OR p.title ILIKE '%' || $1 || '%')
ORDER BY score DESC, p.updated_at DESC
LIMIT $2`;

async function embedQuery(query) {
  const response = await fetch(`${config.gbrainEmbedBaseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.gbrainEmbedApiKey}`,
    },
    body: JSON.stringify({ model: config.gbrainEmbedModel, input: query }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Embedding request failed: ${response.status}`);
  }
  return parseEmbeddingResponse(await response.json());
}

/**
 * Semantic (embedding) search. Throws when embeddings or the DB fail —
 * callers use searchVault() for automatic fallback.
 */
export async function semanticSearch(query, { limit = 12 } = {}) {
  const cleanQuery = String(query).slice(0, MAX_QUERY_CHARS).trim();
  if (!cleanQuery) return [];
  const vector = await embedQuery(cleanQuery);
  const { rows } = await gbrainQuery(SEMANTIC_RANKED_SQL, [
    buildVectorLiteral(vector),
    limit,
  ]);
  return rows;
}

/**
 * Full-text search with trigram title fallback. Throws on DB failure.
 */
export async function ftsSearch(query, { limit = 12 } = {}) {
  const cleanQuery = String(query).slice(0, MAX_QUERY_CHARS).trim();
  if (!cleanQuery) return [];
  const fts = await gbrainQuery(FTS_SQL, [cleanQuery, limit]);
  if (fts.rows.length > 0) return fts.rows;
  const title = await gbrainQuery(TITLE_SQL, [cleanQuery, limit]);
  return title.rows;
}

/**
 * Unified vault search.
 * @param {string} query
 * @param {{mode?: 'auto'|'semantic'|'fts', limit?: number, deps?: object}} [options]
 *   `deps` overrides (semanticSearch/ftsSearch/configured) exist for tests.
 * @returns {Promise<{mode: 'semantic'|'fts'|'unconfigured', results: Array, degraded?: string}>}
 */
export async function searchVault(
  query,
  { mode = 'auto', limit = 12, deps = {} } = {},
) {
  const semantic = deps.semanticSearch || semanticSearch;
  const fts = deps.ftsSearch || ftsSearch;
  const configured = deps.configured ?? isGbrainSearchConfigured();

  if (!configured) {
    return { mode: 'unconfigured', results: [] };
  }

  if (mode === 'fts') {
    return {
      mode: 'fts',
      results: normalizeRows(await fts(query, { limit }), query),
    };
  }

  if (mode === 'auto') {
    try {
      return {
        mode: 'semantic',
        results: normalizeRows(await semantic(query, { limit }), query),
      };
    } catch (error) {
      return {
        mode: 'fts',
        degraded: `semantic unavailable (${error?.message || error}); used full-text`,
        results: normalizeRows(await fts(query, { limit }), query),
      };
    }
  }

  return {
    mode: 'semantic',
    results: normalizeRows(await semantic(query, { limit }), query),
  };
}
