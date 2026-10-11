import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub';
process.env.VAULT_PATH = process.env.VAULT_PATH || '/tmp/vault';
process.env.GBRAIN_DATABASE_URL = process.env.GBRAIN_DATABASE_URL || '';

const {
  buildVectorLiteral,
  parseEmbeddingResponse,
  toSnippet,
  toVaultPath,
  searchVault,
  SEMANTIC_RANKED_SQL,
} = await import('./search.js');

describe('semantic search ranking', () => {
  it('applies LIMIT only after ranking every page by similarity', () => {
    // The inner DISTINCT ON stage must scan ALL pages; a premature LIMIT
    // there truncates to the lowest page IDs instead of the best matches.
    const inner = SEMANTIC_RANKED_SQL.slice(
      SEMANTIC_RANKED_SQL.indexOf('(') + 1,
      SEMANTIC_RANKED_SQL.lastIndexOf(') best'),
    );
    const outer = SEMANTIC_RANKED_SQL.slice(
      SEMANTIC_RANKED_SQL.lastIndexOf(') best') + 6,
    );
    assert.match(inner, /DISTINCT ON \(p\.id\)/);
    assert.match(inner, /ORDER BY p\.id, c\.embedding <=> \$1::vector\s*$/);
    assert.doesNotMatch(inner, /LIMIT/i);
    assert.match(outer, /ORDER BY score DESC, id\s+LIMIT \$2\s*$/);
  });
});

describe('gbrain search helpers', () => {
  it('maps gbrain slugs to vault file paths', () => {
    assert.equal(
      toVaultPath({ slug: 'digests/2026-09-13-dingtalk-lunch' }),
      'digests/2026-09-13-dingtalk-lunch.md',
    );
    assert.equal(
      toVaultPath({ source_path: 'people/示例用户.md', slug: 'people/示例用户' }),
      'people/示例用户.md',
    );
    assert.equal(
      toVaultPath({ source_path: 'note.markdown', slug: 'note' }),
      'note.markdown',
    );
    assert.equal(toVaultPath({}), '');
  });
  it('builds pgvector literals', () => {
    assert.equal(buildVectorLiteral([1, 2.5, -3]), '[1,2.5,-3]');
    assert.equal(buildVectorLiteral([]), '[]');
  });

  it('parses LiteLLM embedding responses', () => {
    const vector = parseEmbeddingResponse({
      data: [{ embedding: [0.1, 0.2] }],
    });
    assert.deepEqual(vector, [0.1, 0.2]);
    assert.throws(() => parseEmbeddingResponse({ data: [] }), /no vector/);
    assert.throws(() => parseEmbeddingResponse({}), /no vector/);
  });

  it('builds snippets around the first query match', () => {
    const body =
      'Intro line. '.repeat(40) +
      'The budget decision happened here. ' +
      'Tail. '.repeat(40);
    const snippet = toSnippet(body, 'budget decision');
    assert.ok(snippet.startsWith('…'), 'snips before the match');
    assert.ok(snippet.includes('budget decision'));
    assert.ok(snippet.length < 320);

    assert.equal(
      toSnippet('line1\nline2\tline3', 'nothing-matching').includes('\n'),
      false,
    );
    assert.equal(toSnippet(''), '');
    assert.equal(toSnippet('short', 'short'), 'short');
  });
});

describe('searchVault', () => {
  const rows = [
    {
      slug: 'note-a',
      title: 'Note A',
      type: 'concept',
      source_path: 'concepts/note-a.md',
      updated_at: '2026-10-01T00:00:00Z',
      score: 0.9,
      chunk_text: 'chunk mentioning budgets',
    },
  ];

  it('reports unconfigured when GBRAIN_DATABASE_URL is empty', async () => {
    const outcome = await searchVault('anything', {
      deps: { configured: false },
    });
    assert.deepEqual(outcome, { mode: 'unconfigured', results: [] });
  });

  it('returns semantic results in auto mode', async () => {
    const outcome = await searchVault('budget', {
      deps: {
        configured: true,
        semanticSearch: async () => rows,
        ftsSearch: async () => assert.fail('fts should not run'),
      },
    });
    assert.equal(outcome.mode, 'semantic');
    assert.equal(outcome.results[0].path, 'concepts/note-a.md');
    assert.equal(outcome.results[0].snippet, 'chunk mentioning budgets');
  });

  it('degrades to fts when semantic throws (auto mode)', async () => {
    const outcome = await searchVault('budget', {
      deps: {
        configured: true,
        semanticSearch: async () => {
          throw new Error('embed failed: 401');
        },
        ftsSearch: async () => rows,
      },
    });
    assert.equal(outcome.mode, 'fts');
    assert.match(outcome.degraded, /embed failed/);
    assert.equal(outcome.results.length, 1);
  });

  it('forces fts without an embed attempt in fts mode', async () => {
    const outcome = await searchVault('budget', {
      mode: 'fts',
      deps: {
        configured: true,
        semanticSearch: async () => assert.fail('semantic should not run'),
        ftsSearch: async () => rows,
      },
    });
    assert.equal(outcome.mode, 'fts');
  });

  it('propagates fts failures in auto mode after semantic fails', async () => {
    await assert.rejects(
      searchVault('budget', {
        deps: {
          configured: true,
          semanticSearch: async () => {
            throw new Error('down');
          },
          ftsSearch: async () => {
            throw new Error('db unreachable');
          },
        },
      }),
      /db unreachable/,
    );
  });
});
