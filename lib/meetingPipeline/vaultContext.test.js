import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub';
process.env.VAULT_PATH = process.env.VAULT_PATH || '/tmp/vault';
process.env.MEETING_S3_ENDPOINT =
  process.env.MEETING_S3_ENDPOINT || 'http://localhost:9000';
process.env.MEETING_S3_PUBLIC_BASE =
  process.env.MEETING_S3_PUBLIC_BASE || 'http://localhost:9000';
process.env.QWEN_FILETRANS_BASE_URL =
  process.env.QWEN_FILETRANS_BASE_URL || 'http://localhost';

const { loadMeetingVaultContext, expandParticipantsText } =
  await import('./vaultContext.js');

let tmpDir;
let originalVaultPath;

async function setupTestVault(contents) {
  const cfg = (await import('@/lib/config.js')).default;
  originalVaultPath = cfg.vaultPath;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-context-test-'));
  cfg.vaultPath = tmpDir;

  await fs.mkdir(path.join(tmpDir, 'system'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'people'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'areas'), { recursive: true });

  await fs.mkdir(path.join(tmpDir, 'system', 'Rules & SOPs'), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(tmpDir, 'system', 'Rules & SOPs', 'Meetings SOP.md'),
    '',
  );
  await fs.mkdir(path.join(tmpDir, 'system', 'Templates'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'system', 'Templates', 'Meeting.md'),
    '',
  );

  for (const [name, body] of contents) {
    const fullPath = path.join(tmpDir, name);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, body);
  }
}

async function teardownTestVault() {
  const cfg = (await import('@/lib/config.js')).default;
  if (originalVaultPath) cfg.vaultPath = originalVaultPath;
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

describe('vaultContext', () => {
  beforeEach(async () => {
    await setupTestVault([]);
  });
  afterEach(async () => {
    await teardownTestVault();
  });

  it('loads teams from system/Teams.md and resolves members against people aliases', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'system', 'Teams.md'),
      `## Leadership Team
- [[Alex]]
- [[Sarah Chen]]
- Unknown Person

## Empty Team
- [[Does Not Exist]]
`,
    );
    await fs.writeFile(
      path.join(tmpDir, 'people', 'Alex.md'),
      '---\naliases: [Alex老师]\n---\n',
    );
    await fs.writeFile(path.join(tmpDir, 'people', 'Sarah Chen.md'), '');

    const ctx = await loadMeetingVaultContext();
    assert.deepStrictEqual(ctx.teams['Leadership Team'].sort(), [
      'Alex',
      'Sarah Chen',
    ]);
    assert.deepStrictEqual(ctx.teams['Empty Team'], []);
    assert.strictEqual(ctx.teamAliases['leadership team'], 'Leadership Team');
  });

  it('returns empty teams when system/Teams.md is missing', async () => {
    const ctx = await loadMeetingVaultContext();
    assert.deepStrictEqual(ctx.teams, {});
    assert.deepStrictEqual(ctx.teamAliases, {});
  });

  describe('expandParticipantsText', () => {
    it('resolves individual names and aliases, expanding teams to members', () => {
      const ctx = {
        peopleAliases: {
          alex: 'Alex',
          alex老师: 'Alex',
          'sarah chen': 'Sarah Chen',
          sarah: 'Sarah Chen',
        },
        teamAliases: { 'leadership team': 'Leadership Team' },
        teams: { 'Leadership Team': ['Alex', 'Sarah Chen'] },
      };
      const result = expandParticipantsText(
        'Alex老师, Leadership Team, IT team',
        ctx,
      );
      assert.deepStrictEqual(result.resolvedPeople.sort(), [
        'Alex',
        'Sarah Chen',
      ]);
      assert.deepStrictEqual(result.unresolvedTokens, ['IT team']);
      assert.deepStrictEqual(result.groupExpansions, {
        'Leadership Team': ['Alex', 'Sarah Chen'],
      });
    });

    it('deduplicates people across multiple team/group hits', () => {
      const ctx = {
        peopleAliases: { alex: 'Alex' },
        teamAliases: {
          'team a': 'Team A',
          'team b': 'Team B',
        },
        teams: {
          'Team A': ['Alex'],
          'Team B': ['Alex'],
        },
      };
      const result = expandParticipantsText('Team A, Team B, Alex', ctx);
      assert.deepStrictEqual(result.resolvedPeople, ['Alex']);
      assert.deepStrictEqual(result.unresolvedTokens, []);
    });

    it('returns empty result for empty/whitespace text', () => {
      const ctx = {
        peopleAliases: { alex: 'Alex' },
        teamAliases: {},
        teams: {},
      };
      assert.deepStrictEqual(expandParticipantsText('', ctx), {
        resolvedPeople: [],
        unresolvedTokens: [],
        groupExpansions: {},
      });
      assert.deepStrictEqual(expandParticipantsText('   ', ctx), {
        resolvedPeople: [],
        unresolvedTokens: [],
        groupExpansions: {},
      });
    });

    it('tolerates multiple delimiters', () => {
      const ctx = {
        peopleAliases: { 'sarah chen': 'Sarah Chen', alex: 'Alex' },
        teamAliases: {},
        teams: {},
      };
      const result = expandParticipantsText('Sarah Chen、Alex; Alice', ctx);
      assert.deepStrictEqual(result.resolvedPeople.sort(), [
        'Alex',
        'Sarah Chen',
      ]);
      assert.deepStrictEqual(result.unresolvedTokens, ['Alice']);
    });
  });
});
