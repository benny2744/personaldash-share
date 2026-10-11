import crypto from 'node:crypto';
import { getSetting } from '@/lib/settings/resolve';
import { readNote, writeNote } from '@/lib/vault';
import { triggerGbrainSync } from '@/lib/gbrainSync';
import { validateAttention, parseAttention } from './attentionSchema';

const allowed = ['watches', 'priorities', 'clusters'];
// Per-file write chains: concurrent attention saves apply in order instead
// of racing read-backup-write cycles (single Next server process).
const writeChains = new Map();

export async function readAttention(name) {
  const { readWatchLevels, readPeoplePriorities, readClusters } =
    await import('@/lib/dingtalkIntel/files');
  if (!allowed.includes(name))
    throw new Error('Unknown attention configuration');
  const directory = await getSetting('attention.directory');
  try {
    const text = await readNote(`${directory}/${name}.md`);
    return parseAttention(name, text);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (name === 'watches')
      return {
        watches: (await readWatchLevels()).map((w) => ({
          conversation_id: w.conversationId,
          title: w.title,
          level: w.level,
          reason: w.reason,
        })),
      };
    if (name === 'priorities') return readPeoplePriorities();
    return { clusters: await readClusters() };
  }
}

export async function writeAttention(name, data, summary) {
  validateAttention(name, data);
  const previous = writeChains.get(name) || Promise.resolve();
  const result = previous.then(
    () => writeAttentionExclusive(name, data, summary),
    () => writeAttentionExclusive(name, data, summary),
  );
  writeChains.set(
    name,
    result.catch(() => {}),
  );
  return result;
}

async function writeAttentionExclusive(name, data, summary) {
  const directory = await getSetting('attention.directory');
  const target = `${directory}/${name}.md`;
  if (name === 'watches' || name === 'clusters') {
    const { query } = await import('@/lib/dingtalk/db');
    const ids = (
      await query('SELECT open_conversation_id FROM dingtalk_conversations')
    ).rows;
    const known = new Set(ids.map((r) => r.open_conversation_id));
    const referenced =
      name === 'watches'
        ? data.watches.map((w) => w.conversation_id)
        : data.clusters.flatMap((c) => c.conversation_ids ?? c.conversationIds);
    if (referenced.some((id) => !known.has(id)))
      throw new Error('Unknown conversation ID');
  }
  let previousContent;
  try {
    previousContent = await readNote(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const baseline = await readAttention(name);
    previousContent = `# Attention ${name} — original configuration\n\n\`\`\`json\n${JSON.stringify(baseline, null, 2)}\n\`\`\`\n`;
  }
  if (previousContent)
    await writeNote(
      `${directory}/backups/${name}-${Date.now()}-${crypto
        .randomBytes(4)
        .toString('hex')}.md`,
      previousContent,
      { atomic: true },
    );
  // Strip fence markers from the summary so it can never shadow or break
  // the configuration fence written after it.
  const safeSummary = String(
    summary || 'Configuration maintained through the setup assistant.',
  )
    .replace(/```/g, "'''")
    .slice(0, 2000);
  await writeNote(
    target,
    `# Attention ${name}\n\n${safeSummary}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`,
    { atomic: true },
  );
  triggerGbrainSync('attention-configuration');
  return { saved: true, path: target };
}

/** Reader seam for the pipeline; absent overrides preserve existing registries. */
export async function attentionOverride(name) {
  const directory = await getSetting('attention.directory');
  try {
    const text = await readNote(`${directory}/${name}.md`);
    return parseAttention(name, text);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
