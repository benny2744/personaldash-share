import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import config from '@/lib/config';

const MEETINGS_SOP_PATH = 'Rules & SOPs/Bases/Meetings SOP.md';
const MEETING_TEMPLATE_PATH = 'Templates/Meeting.md';
const TEAMS_REFERENCE_PATH = 'Teams.md';

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * List note names in a directory, and build an alias map (lowercased alias →
 * canonical note name) from each note's `aliases:` frontmatter. The canonical
 * name itself is also seeded into the map so the resolver can match it directly.
 * @returns {Promise<{ names: string[], aliases: Object }>}
 */
async function listNotesWithAliases(dirPath) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return { names: [], aliases: {} };
  }
  const names = [];
  const aliases = {};
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.md') ||
      entry.name.endsWith(' Kanban.md')
    )
      continue;
    const name = entry.name.replace(/\.md$/i, '');
    names.push(name);
    aliases[name.toLowerCase()] = name;
    try {
      const raw = await fs.readFile(path.join(dirPath, entry.name), 'utf8');
      const { data } = matter(raw);
      const aliasList = Array.isArray(data.aliases)
        ? data.aliases
        : data.aliases
          ? [data.aliases]
          : [];
      for (const alias of aliasList) {
        const value = String(alias).trim();
        if (value) aliases[value.toLowerCase()] = name;
      }
    } catch {
      /* non-frontmatter or unreadable file — name still indexed above */
    }
  }
  names.sort((a, b) => a.localeCompare(b));
  return { names, aliases };
}

/**
 * Parse system/Teams.md into raw team rosters.
 * Format: each `## Team Name` heading, then `- [[Member Name]]` or `- Member Name` bullets.
 * @returns {Map<string, string[]>}
 */
function parseTeamRosters(content) {
  const rosters = new Map();
  let currentTeam = null;
  for (const line of content.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      currentTeam = heading[1].trim();
      rosters.set(currentTeam, []);
      continue;
    }
    if (!currentTeam) continue;
    const item = line.match(/^[-*]\s+(?:\[\[([^\]]+)\]\]|(.+))$/);
    if (!item) continue;
    const raw = (item[1] ?? item[2]).trim();
    if (raw) rosters.get(currentTeam).push(raw);
  }
  return rosters;
}

/**
 * Load the optional teams reference file and resolve each member against
 * `peopleAliases`. Returns normalized team names and a lowercase lookup map.
 */
function loadTeams(content, peopleAliases) {
  const rawRosters = parseTeamRosters(content);
  const teams = {};
  const teamAliases = {};
  for (const [teamName, members] of rawRosters.entries()) {
    const resolved = [];
    for (const raw of members) {
      const canonical = peopleAliases[raw.toLowerCase()];
      if (canonical && !resolved.includes(canonical)) resolved.push(canonical);
    }
    teams[teamName] = resolved;
    teamAliases[teamName.toLowerCase()] = teamName;
  }
  return { teams, teamAliases };
}

const PARTICIPANT_DELIMITERS = /[,，;；、/|]+/;

/**
 * Expand a comma-separated participants/groups hint string into resolved
 * people and raw unknown tokens. Team names expand to their rostered members.
 * @param {string} text
 * @param {object} vaultContext
 * @returns {{ resolvedPeople: string[], unresolvedTokens: string[], groupExpansions: Record<string, string[]> }}
 */
export function expandParticipantsText(text, vaultContext) {
  const peopleAliases = vaultContext?.peopleAliases ?? {};
  const teamAliases = vaultContext?.teamAliases ?? {};
  const teams = vaultContext?.teams ?? {};

  const resolvedPeople = new Set();
  const unresolvedTokens = [];
  const groupExpansions = {};

  if (!text?.trim()) {
    return { resolvedPeople: [], unresolvedTokens: [], groupExpansions };
  }

  for (const raw of text.split(PARTICIPANT_DELIMITERS)) {
    const token = raw.trim();
    if (!token) continue;
    const key = token.toLowerCase();

    const teamName = teamAliases[key];
    if (teamName) {
      const members = teams[teamName] ?? [];
      groupExpansions[teamName] = members;
      for (const member of members) resolvedPeople.add(member);
      continue;
    }

    const canonical = peopleAliases[key];
    if (canonical) {
      resolvedPeople.add(canonical);
      continue;
    }

    unresolvedTokens.push(token);
  }

  return {
    resolvedPeople: Array.from(resolvedPeople).sort((a, b) =>
      a.localeCompare(b),
    ),
    unresolvedTokens,
    groupExpansions,
  };
}

export async function loadMeetingVaultContext() {
  const [meetingsSop, meetingTemplate, people, projects, areas, teamsRaw] =
    await Promise.all([
      readTextIfExists(
        path.join(config.vaultPath, 'system', MEETINGS_SOP_PATH),
      ),
      readTextIfExists(
        path.join(config.vaultPath, 'system', MEETING_TEMPLATE_PATH),
      ),
      listNotesWithAliases(path.join(config.vaultPath, 'people')),
      listNotesWithAliases(path.join(config.vaultPath, 'projects')),
      listNotesWithAliases(path.join(config.vaultPath, 'areas')),
      readTextIfExists(
        path.join(config.vaultPath, 'system', TEAMS_REFERENCE_PATH),
      ),
    ]);

  const { teams, teamAliases } = loadTeams(teamsRaw, people.aliases);

  return {
    meetingsSop,
    meetingTemplate,
    people: people.names,
    projects: projects.names,
    areas: areas.names,
    peopleAliases: people.aliases,
    projectsAliases: projects.aliases,
    areasAliases: areas.aliases,
    teams,
    teamAliases,
  };
}
