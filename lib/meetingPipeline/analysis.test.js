import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Tests for lib/meetingPipeline/analysis.js (pure) plus the metadata-precedence
// rule in passes.js buildMeetingContext. Env stubs so config load doesn't throw.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub';
process.env.VAULT_PATH = process.env.VAULT_PATH || '/tmp/vault';
process.env.MEETING_S3_ENDPOINT =
  process.env.MEETING_S3_ENDPOINT || 'http://localhost:9000';
process.env.MEETING_S3_PUBLIC_BASE =
  process.env.MEETING_S3_PUBLIC_BASE || 'http://localhost:9000';
process.env.QWEN_FILETRANS_BASE_URL =
  process.env.QWEN_FILETRANS_BASE_URL || 'http://localhost';

const {
  ANALYSIS_SCHEMA_VERSION,
  ANALYSIS_PROMPT_VERSION,
  sha256Hex,
  analysisInputHash,
  resolveEntityName,
  entityIdFor,
  locateEvidence,
  validateAnalysis,
  upconvertV0Contract,
  contractFromAnalysis,
  loadReusableAnalysis,
  analysisAttendees,
  analysisProject,
  analysisArea,
  effectIdFor,
  factHashFor,
} = await import('./analysis.js');
const { buildMeetingContext } = await import('./passes.js');

const vaultContext = {
  people: ['Sarah Chen', 'Alex'],
  projects: ['AI Curriculum', 'Admissions 2026'],
  areas: ['Teaching'],
  peopleAliases: { sarah: 'Sarah Chen' },
  projectsAliases: { 'ai curr': 'AI Curriculum' },
  areasAliases: {},
};

const metadata = { date: '2026-08-25', type: 'Leadership', topic: 'Budget' };

const transcript =
  'Alex: We agreed to move the launch to October. ' +
  'Sarah said the vendor approval is still blocking us. ' +
  'Alex will send the updated budget by Friday.';

function v1Json(overrides = {}) {
  return {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    summary_en: '## Context\nWe discussed the launch.',
    meeting: { project: 'AI Curriculum', area: null },
    entities: [
      {
        observed_name: 'Sarah',
        canonical_name: 'Sarah Chen',
        kind: 'person',
        role: 'attendee',
        resolution_status: 'resolved',
      },
      {
        observed_name: 'Alex',
        canonical_name: 'Alex',
        kind: 'person',
        role: 'attendee',
        resolution_status: 'resolved',
      },
    ],
    decisions: [
      { text: 'Launch moved to October', quote: 'move the launch to October' },
    ],
    action_items: [
      {
        action: 'Send the updated budget',
        owner_name: 'Alex',
        due: '2026-08-28',
        quote: 'send the updated budget by Friday',
      },
    ],
    entity_updates: [
      {
        entity_name: 'AI Curriculum',
        kind: 'project',
        update_type: 'log',
        category: 'status_change',
        fact: 'Launch moved to October',
        quote: 'move the launch to October',
        confidence: 0.94,
      },
    ],
    frontmatter_extra: {},
    ...overrides,
  };
}

function ctx(extra = {}) {
  return {
    vaultContext,
    cleanedTranscript: transcript,
    metadata,
    model: 'litellm/qwen3.7-plus',
    rawTranscript: null,
    ...extra,
  };
}

describe('locateEvidence', () => {
  it('locates exact substrings', () => {
    const ev = locateEvidence('move the launch to October', transcript);
    assert.equal(ev.located, true);
    assert.equal(
      transcript.slice(ev.char_start, ev.char_end),
      'move the launch to October',
    );
  });

  it('tolerates whitespace and case differences', () => {
    const ev = locateEvidence('MOVE  THE\nLAUNCH to october', transcript);
    assert.equal(ev.located, true);
  });

  it('tolerates curly-quote and dash variants', () => {
    const t = 'Alex said “launch” — not September';
    const ev = locateEvidence('Alex said "launch" - not September', t);
    assert.equal(ev.located, true);
  });

  it('returns located:false with the quote preserved when absent', () => {
    const ev = locateEvidence('this was never said', transcript);
    assert.equal(ev.located, false);
    assert.equal(ev.char_start, null);
    assert.equal(ev.quote, 'this was never said');
  });

  it('returns located:false for empty quotes', () => {
    assert.equal(locateEvidence('', transcript).located, false);
    assert.equal(locateEvidence(null, transcript).located, false);
  });
});

describe('resolveEntityName', () => {
  it('matches exact names case-insensitively', () => {
    assert.equal(
      resolveEntityName('sarah chen', 'person', vaultContext),
      'Sarah Chen',
    );
  });

  it('resolves aliases to canonical names', () => {
    assert.equal(
      resolveEntityName('sarah', 'person', vaultContext),
      'Sarah Chen',
    );
    assert.equal(
      resolveEntityName('ai curr', 'project', vaultContext),
      'AI Curriculum',
    );
  });

  it('returns null for unknown names — never invents', () => {
    assert.equal(
      resolveEntityName('Mystery Person', 'person', vaultContext),
      null,
    );
    assert.equal(resolveEntityName('', 'person', vaultContext), null);
  });
});

describe('validateAnalysis', () => {
  it('validates a full v1 contract and assigns stable IDs', () => {
    const a = validateAnalysis(v1Json(), ctx());
    assert.equal(a.schema_version, ANALYSIS_SCHEMA_VERSION);
    assert.equal(a.prompt_version, ANALYSIS_PROMPT_VERSION);
    assert.ok(a.analysis_id);
    assert.equal(a.analysis_input_hash, analysisInputHash(transcript));
    assert.equal(a.meeting.project, 'AI Curriculum');
    assert.equal(a.meeting.area, null);
    assert.deepEqual(
      a.entities.map((e) => e.entity_id),
      ['people/Sarah Chen.md', 'people/Alex.md'],
    );
    assert.equal(a.decisions[0].decision_id, 'dec_01');
    assert.equal(a.decisions[0].evidence.located, true);
    assert.equal(a.action_items[0].action_item_id, 'act_01');
    assert.equal(a.action_items[0].owner_entity_id, 'people/Alex.md');
    assert.equal(a.entity_updates[0].entity_update_id, 'eu_01');
    assert.equal(a.entity_updates[0].entity_id, 'projects/AI Curriculum.md');
    assert.equal(a.entity_updates[0].resolution_status, 'resolved');
  });

  it('downgrades a claimed resolution that fails vault validation', () => {
    const a = validateAnalysis(
      v1Json({
        entities: [
          {
            observed_name: 'Ghost',
            canonical_name: 'Ghost Person',
            kind: 'person',
            role: 'attendee',
            resolution_status: 'resolved',
          },
        ],
      }),
      ctx(),
    );
    assert.equal(a.entities[0].entity_id, null);
    assert.equal(a.entities[0].canonical_name, null);
    assert.equal(a.entities[0].resolution_status, 'unresolved');
    assert.equal(a.entities[0].observed_name, 'Ghost');
  });

  it('keeps proposed_new as a proposal with null entity_id', () => {
    const a = validateAnalysis(
      v1Json({
        entities: [
          {
            observed_name: 'New Vendor',
            canonical_name: null,
            kind: 'project',
            role: 'mentioned',
            resolution_status: 'proposed_new',
          },
        ],
      }),
      ctx(),
    );
    assert.equal(a.entities[0].resolution_status, 'proposed_new');
    assert.equal(a.entities[0].entity_id, null);
  });

  it('drops low-confidence updates and records the drop', () => {
    const a = validateAnalysis(
      v1Json({
        entity_updates: [
          {
            entity_name: 'AI Curriculum',
            kind: 'project',
            update_type: 'log',
            category: 'risk',
            fact: 'Maybe the launch slips',
            quote: '',
            confidence: 0.3,
          },
        ],
      }),
      ctx(),
    );
    assert.equal(a.entity_updates.length, 0);
    assert.equal(a.dropped_updates.length, 1);
    assert.equal(a.dropped_updates[0].reason, 'low_confidence');
  });

  it('derives update_type from category when missing or invalid', () => {
    const a = validateAnalysis(
      v1Json({
        entity_updates: [
          {
            entity_name: 'AI Curriculum',
            kind: 'project',
            category: 'milestone',
            fact: 'Hit the milestone',
            quote: '',
          },
          {
            entity_name: 'Sarah Chen',
            kind: 'person',
            category: 'role_change',
            fact: 'Sarah now leads grading',
            quote: '',
          },
        ],
      }),
      ctx(),
    );
    assert.equal(a.entity_updates[0].update_type, 'log');
    assert.equal(a.entity_updates[1].update_type, 'profile');
  });

  it('marks updates on unknown entities unresolved with null entity_id', () => {
    const a = validateAnalysis(
      v1Json({
        entity_updates: [
          {
            entity_name: 'Unknown Project',
            kind: 'project',
            update_type: 'log',
            category: 'decision',
            fact: 'Something was decided',
            quote: '',
          },
        ],
      }),
      ctx(),
    );
    assert.equal(a.entity_updates[0].entity_id, null);
    assert.equal(a.entity_updates[0].resolution_status, 'unresolved');
  });

  it('throws on unusable output', () => {
    assert.throws(() => validateAnalysis(null, ctx()));
    assert.throws(() => validateAnalysis(['x'], ctx()));
    assert.throws(() => validateAnalysis({ entities: [] }, ctx()));
  });
});

describe('upconvertV0Contract', () => {
  it('maps a legacy contract into the v1 shape', () => {
    const a = upconvertV0Contract(
      {
        summary_en: '## Summary\nStuff.',
        summary_zh: '中文',
        action_items: [
          { title: 'Do the thing', owner: 'sarah', due: '2026-09-01' },
        ],
        decisions: ['Decided the thing'],
        frontmatter_extra: { Confidential: 'true' },
      },
      ctx(),
    );
    assert.equal(a.prompt_version, '0-upconvert');
    assert.equal(a.entity_updates.length, 0);
    assert.equal(a.entities.length, 0);
    assert.equal(a.action_items[0].owner_entity_id, 'people/Sarah Chen.md');
    assert.equal(a.action_items[0].due, '2026-09-01');
    assert.equal(a.decisions[0].evidence.located, false);
    assert.equal(a.frontmatter_extra.Confidential, 'true');
  });
});

describe('contractFromAnalysis', () => {
  it('derives the legacy contract shape', () => {
    const a = validateAnalysis(v1Json(), ctx());
    const contract = contractFromAnalysis(a, { summaryZh: '中文总结' });
    assert.equal(contract.summary_en, a.summary_en);
    assert.equal(contract.summary_zh, '中文总结');
    assert.deepEqual(contract.action_items, [
      { title: 'Send the updated budget', owner: 'Alex', due: '2026-08-28' },
    ]);
    assert.deepEqual(contract.decisions, ['Launch moved to October']);
  });
});

describe('loadReusableAnalysis (reuse invariant)', () => {
  it('reuses when schema + input hash match', () => {
    const a = validateAnalysis(v1Json(), ctx());
    const reused = loadReusableAnalysis(JSON.stringify(a), transcript);
    assert.equal(reused.analysis_id, a.analysis_id);
  });

  it('refuses when the cleaned transcript changed (new generation)', () => {
    const a = validateAnalysis(v1Json(), ctx());
    assert.equal(
      loadReusableAnalysis(JSON.stringify(a), 'edited transcript'),
      null,
    );
  });

  it('refuses unsupported schema versions', () => {
    const a = validateAnalysis(v1Json(), ctx());
    a.schema_version = 'meeting_analysis_v99';
    assert.equal(loadReusableAnalysis(JSON.stringify(a), transcript), null);
  });

  it('refuses garbage', () => {
    assert.equal(loadReusableAnalysis('not json', transcript), null);
    assert.equal(loadReusableAnalysis(null, transcript), null);
  });
});

describe('metadata precedence (analysis authoritative over provisional)', () => {
  const base = {
    metadata: {
      date: '2026-08-25',
      type: 'Leadership',
      topic: 'Budget',
      attendees: ['Sarah Chen'],
      project: 'Admissions 2026',
      area: '',
    },
    cleanedTranscript: 'No names mentioned here.',
    summaryEn: '',
    vaultContext,
  };

  it('authoritative populated + provisional populated → authoritative wins', () => {
    const a = validateAnalysis(v1Json(), ctx());
    const result = buildMeetingContext({ ...base, analysis: a });
    assert.deepEqual(result.attendees.sort(), ['Alex', 'Sarah Chen']);
    assert.equal(result.project, 'AI Curriculum');
  });

  it('authoritative missing + provisional populated → provisional fills', () => {
    const a = validateAnalysis(
      v1Json({ entities: [], meeting: { project: null, area: null } }),
      ctx(),
    );
    const result = buildMeetingContext({ ...base, analysis: a });
    assert.deepEqual(result.attendees, ['Sarah Chen']);
    assert.equal(result.project, 'Admissions 2026');
  });

  it('authoritative populated + provisional null → authoritative preserved', () => {
    const a = validateAnalysis(v1Json(), ctx());
    const result = buildMeetingContext({
      ...base,
      metadata: { ...base.metadata, attendees: [], project: '' },
      analysis: a,
    });
    assert.deepEqual(result.attendees.sort(), ['Alex', 'Sarah Chen']);
    assert.equal(result.project, 'AI Curriculum');
  });

  it('no analysis at all → provisional behavior unchanged', () => {
    const result = buildMeetingContext(base);
    assert.deepEqual(result.attendees, ['Sarah Chen']);
    assert.equal(result.project, 'Admissions 2026');
  });
});

describe('effect identity', () => {
  it('effectIdFor is deterministic per analysis+update pair', () => {
    assert.equal(effectIdFor('a1', 'eu_01'), sha256Hex('a1:eu_01'));
    assert.notEqual(effectIdFor('a1', 'eu_01'), effectIdFor('a2', 'eu_01'));
  });

  it('factHashFor normalizes whitespace/case and scopes to the entity', () => {
    assert.equal(
      factHashFor('projects/X.md', 'Launch  MOVED to October'),
      factHashFor('projects/X.md', 'launch moved to october'),
    );
    assert.notEqual(
      factHashFor('projects/X.md', 'same fact'),
      factHashFor('projects/Y.md', 'same fact'),
    );
  });
});
