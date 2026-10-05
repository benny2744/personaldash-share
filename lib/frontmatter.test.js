import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildIdeaWriteBackUpdates,
  buildMeetingWriteBackUpdates,
  buildWriteBackUpdates,
  extractIdeaFields,
  extractTaskFields,
  normalizeIdeaScore,
  normalizeIdeaStatus,
  normalizeTaskContext,
  parseFrontmatter,
  patchFrontmatterFields,
  patchTaskRelatedSection,
  patchAttendeesSection,
} = await import('./frontmatter.js');

const FM = `---
Type: meeting
Attendees:
  - '[[TBD]]'
---

# Meeting

Body intro.

`;

function noteWithSection(bullets) {
  return `---
Type: meeting
---

# Meeting

## Decisions
- something

## Attendees
${bullets}

## Transcript
verbatim line
`;
}

describe('patchAttendeesSection', () => {
  it('replaces bullets in an existing ## Attendees section', () => {
    const raw = noteWithSection('- [[alex]]\n- [[Old Name]]');
    const out = patchAttendeesSection(raw, ['Jessie Zeng', 'Susan']);
    assert.ok(out.includes('## Attendees\n\n- [[Jessie Zeng]]\n- [[Susan]]\n'));
    assert.ok(!out.includes('Old Name'));
    assert.ok(out.includes('## Transcript\nverbatim line'));
    assert.ok(out.includes('## Decisions\n- something'));
  });

  it('renders - TBD for an empty attendee list', () => {
    const raw = noteWithSection('- [[alex]]');
    const out = patchAttendeesSection(raw, []);
    assert.ok(out.includes('## Attendees\n\n- TBD\n'));
  });

  it('inserts the section before ## Transcript when missing', () => {
    const raw = FM + '# Meeting\n\n## Transcript\nabc\n';
    const out = patchAttendeesSection(raw, ['Jessie Zeng']);
    assert.ok(
      out.includes('## Attendees\n\n- [[Jessie Zeng]]\n\n## Transcript'),
    );
  });

  it('inserts the section before the first ## heading when missing', () => {
    const raw = '---\nType: meeting\n---\n\n# Meeting\n\n## Decisions\n- x\n';
    const out = patchAttendeesSection(raw, ['Susan']);
    assert.ok(out.includes('## Attendees\n\n- [[Susan]]\n\n## Decisions'));
  });

  it('appends at the end when no headings exist', () => {
    const raw = '---\nType: meeting\n---\n\n# Meeting\n\nSome text.\n';
    const out = patchAttendeesSection(raw, ['Susan']);
    assert.ok(out.trimEnd().endsWith('## Attendees\n\n- [[Susan]]'));
  });

  it('preserves content after the section (transcript untouched)', () => {
    const raw = noteWithSection('- TBD');
    const before = raw.slice(raw.indexOf('## Transcript'));
    const out = patchAttendeesSection(raw, ['A B']);
    const after = out.slice(out.indexOf('## Transcript'));
    assert.equal(after, before);
  });
});

describe('buildMeetingWriteBackUpdates attendees', () => {
  it('wraps attendee names as wikilinks', () => {
    const updates = buildMeetingWriteBackUpdates({
      attendees: ['Jessie Zeng'],
    });
    assert.deepEqual(updates.Attendees, ['[[Jessie Zeng]]']);
  });
});

describe('task metadata frontmatter', () => {
  it('extracts the task context, linked area, and legacy uppercase tags', () => {
    assert.deepEqual(
      extractTaskFields({
        Context: ' side projects ',
        Area: '[[Family & Personal]]',
        Tags: ['type/task', 'follow-up'],
      }),
      {
        status: 'Todo',
        whenDate: null,
        priority: 'Medium',
        context: 'Side Projects',
        project: null,
        area: 'Family & Personal',
        domain: null,
        courses: [],
        people: [],
        notesSummary: null,
        tags: ['type/task', 'follow-up'],
      },
    );
  });

  it('normalizes only the supported contexts', () => {
    assert.equal(normalizeTaskContext('WORK'), 'Work');
    assert.equal(normalizeTaskContext('household'), null);
  });

  it('writes task metadata without dropping unrelated frontmatter', () => {
    const updates = buildWriteBackUpdates({
      context: 'Personal',
      area: 'Family & Personal',
      tags: ['type/task', 'errands'],
    });
    assert.deepEqual(updates, {
      Context: 'Personal',
      Area: '[[Family & Personal]]',
      tags: ['type/task', 'errands'],
    });

    const updated = parseFrontmatter(
      patchFrontmatterFields(
        `---\nType: task\nCustom: keep\n---\n# Task\n`,
        updates,
      ),
    );
    assert.equal(updated.data.Custom, 'keep');
    assert.equal(updated.data.Context, 'Personal');
    assert.equal(updated.data.Area, '[[Family & Personal]]');
    assert.deepEqual(updated.data.tags, ['type/task', 'errands']);
  });

  it('mirrors edited task relations into body wikilinks and preserves other links', () => {
    const raw = `---\nType: task\n---\n# Task\n\n## Related\n- Meeting: [[Planning]]\n- Project: [[Old Project]]\n\n## Notes\nKeep this.\n`;
    const updated = patchTaskRelatedSection(raw, {
      project: 'New Project',
      area: 'Family & Personal',
      people: ['Morgan'],
      courses: [],
    });
    assert.ok(updated.includes('- Meeting: [[Planning]]'));
    assert.ok(updated.includes('- Project: [[New Project]]'));
    assert.ok(updated.includes('- Area: [[Family & Personal]]'));
    assert.ok(updated.includes('- Person: [[Morgan]]'));
    assert.ok(!updated.includes('Old Project'));
    assert.ok(updated.includes('## Notes\nKeep this.'));
  });
});

describe('idea taxonomy frontmatter', () => {
  it('maps legacy statuses and t-shirt effort sizes onto the canonical enums', () => {
    assert.deepEqual(
      extractIdeaFields({
        Status: 'Backburner',
        Context: ' personal ',
        Impact: 'HIGH',
        Confidence: '',
        Effort: 'Large',
        Project: '[[My Project]]',
        Created: '2026-08-09',
        Notes: 'summary',
        tags: ['type/idea', 'edtech'],
      }),
      {
        status: 'Incubating',
        domain: null,
        context: 'Personal',
        impact: 'High',
        confidence: null,
        effort: 'High',
        project: 'My Project',
        ideaCreated: new Date('2026-08-09'),
        reviewedAt: null,
        notesSummary: 'summary',
        tags: ['type/idea', 'edtech'],
      },
    );
  });

  it('falls back to Captured for missing or unknown statuses', () => {
    assert.equal(extractIdeaFields({}).status, 'Captured');
    assert.equal(extractIdeaFields({ Status: 'Zzz' }).status, 'Zzz');
  });

  it('normalizes canonical, legacy, and case-variant statuses', () => {
    assert.equal(normalizeIdeaStatus('captured'), 'Captured');
    assert.equal(normalizeIdeaStatus('Backburner'), 'Incubating');
    assert.equal(normalizeIdeaStatus('In Progress'), 'Exploring');
    assert.equal(normalizeIdeaStatus('Done'), 'Shipped');
    assert.equal(normalizeIdeaStatus('Graduated'), 'Graduated');
    assert.equal(normalizeIdeaStatus('nope'), null);
    assert.equal(normalizeIdeaStatus(42), null);
  });

  it('normalizes scores including legacy t-shirt sizes', () => {
    assert.equal(normalizeIdeaScore('medium'), 'Medium');
    assert.equal(normalizeIdeaScore('Small'), 'Low');
    assert.equal(normalizeIdeaScore('XL'), 'High');
    assert.equal(normalizeIdeaScore('huge'), 'High');
    assert.equal(normalizeIdeaScore('gigantic'), null);
    assert.equal(normalizeIdeaScore(''), null);
  });

  it('writes idea metadata with wikilinked projects and strict dates', () => {
    const updates = buildIdeaWriteBackUpdates({
      status: 'Graduated',
      context: null,
      impact: 'High',
      confidence: 'Medium',
      effort: 'Low',
      project: 'My Project',
      ideaCreated: '2026-08-09',
      reviewedAt: '2026-10-01',
      tags: ['type/idea'],
    });
    assert.deepEqual(updates, {
      Status: 'Graduated',
      Context: '',
      Impact: 'High',
      Confidence: 'Medium',
      Effort: 'Low',
      Project: '[[My Project]]',
      Created: '2026-08-09',
      Reviewed: '2026-10-01',
      tags: ['type/idea'],
    });

    const updated = parseFrontmatter(
      patchFrontmatterFields(
        '---\nType: idea\nTags:\n  - legacy\n---\n# Idea\n',
        updates,
      ),
    );
    assert.equal(updated.data.Type, 'idea');
    assert.equal(updated.data.Status, 'Graduated');
    assert.equal(updated.data.Project, '[[My Project]]');
    assert.deepEqual(updated.data.tags, ['type/idea']);
    assert.equal(updated.data.Tags, undefined);
  });
});
