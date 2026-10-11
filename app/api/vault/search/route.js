import { NextResponse } from 'next/server';
import { searchVault } from '@/lib/gbrain/search';

export const dynamic = 'force-dynamic';

const MODES = new Set(['auto', 'semantic', 'fts']);

// gbrain slugs dash-join words but vault filenames keep spaces
// ("2026-09-13 dingtalk-lunch.md"), and pre-hotfix pages have no source_path
// to recover the real name from. Resolve result paths against the app's own
// notes index: exact filepath first, then a normalized stem match
// (lowercase, punctuation stripped — collapses the dash/space ambiguity).
let pathIndexCache = { map: null, at: 0 };
const PATH_INDEX_TTL_MS = 60_000;

function normalizeStem(p) {
  return String(p)
    .toLowerCase()
    .replace(/\.(md|markdown)$/, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

async function getVaultPathIndex() {
  if (
    pathIndexCache.map &&
    Date.now() - pathIndexCache.at < PATH_INDEX_TTL_MS
  ) {
    return pathIndexCache.map;
  }
  const { default: prisma } = await import('@/lib/db');
  const rows = await prisma.note.findMany({
    where: { deletedAt: null },
    select: { filepath: true },
  });
  const map = new Map();
  for (const row of rows) {
    map.set(row.filepath, row.filepath);
    const stem = normalizeStem(row.filepath);
    if (!map.has(stem)) map.set(stem, row.filepath);
  }
  pathIndexCache = { map, at: Date.now() };
  return map;
}

async function resolveNotePaths(results) {
  if (!results.length) return results;
  try {
    const index = await getVaultPathIndex();
    return results.map((result) => {
      if (!result.path || index.has(result.path)) return result;
      const resolved = index.get(normalizeStem(result.path));
      return resolved ? { ...result, path: resolved } : result;
    });
  } catch (error) {
    console.error('Vault path resolution failed:', error);
    return results;
  }
}

/**
 * GET /api/vault/search?q=…&mode=auto|semantic|fts&limit=12
 * Semantic/full-text search over the gbrain corpus. When gbrain retrieval is
 * not configured, falls back to substring search over the app's own notes
 * index so the UI always returns something useful.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const query = (searchParams.get('q') || '').trim();
  const modeParam = searchParams.get('mode') || 'auto';
  const mode = MODES.has(modeParam) ? modeParam : 'auto';
  const limit = Math.min(
    Math.max(Number(searchParams.get('limit')) || 12, 1),
    50,
  );

  if (!query) {
    return NextResponse.json({ mode: 'none', query, results: [] });
  }

  try {
    const outcome = await searchVault(query, { mode, limit });
    if (outcome.mode === 'unconfigured') {
      // gbrain retrieval is not set up — the local notes index IS the search.
      const results = await prismaFallbackSearch(query, limit);
      return NextResponse.json(
        {
          mode: 'local',
          degraded: 'gbrain search is not configured; used local notes index',
          query,
          results,
          fallback: 'local',
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const results = await resolveNotePaths(outcome.results);
    return NextResponse.json(
      { ...outcome, results, query, fallback: null },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('Vault search failed:', error);
  }

  // gbrain retrieval failed hard — degrade to the local notes index.
  try {
    const results = await prismaFallbackSearch(query, limit);
    return NextResponse.json(
      {
        mode: 'local',
        degraded: 'gbrain search failed; used local notes index',
        query,
        results,
        fallback: 'local',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (localError) {
    console.error('Local vault search fallback failed:', localError);
  }

  return NextResponse.json({ error: 'Search failed' }, { status: 500 });
}

async function prismaFallbackSearch(query, limit) {
  const { default: prisma } = await import('@/lib/db');
  const rows = await prisma.note.findMany({
    where: {
      deletedAt: null,
      OR: [
        { title: { contains: query, mode: 'insensitive' } },
        { filepath: { contains: query, mode: 'insensitive' } },
      ],
    },
    select: {
      title: true,
      baseType: true,
      filepath: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
  return rows.map((row) => ({
    slug: row.filepath,
    title: row.title,
    type: row.baseType,
    path: row.filepath,
    updatedAt: row.updatedAt?.toISOString() || null,
    score: 0,
    snippet: '',
  }));
}
