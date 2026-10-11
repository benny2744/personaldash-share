/** Share installs start with empty attention configuration, never personal seeds. */
import { attentionOverride } from '@/lib/setup/attention';
export function invalidateCache() {}
export async function readWatchLevels() {
  const data = await attentionOverride('watches');
  return (data?.watches || []).map((w) => ({
    conversationId: w.conversation_id,
    title: w.title,
    level: w.level,
    reason: w.reason,
    links: [],
  }));
}
export async function readPeoplePriorities() {
  return (await attentionOverride('priorities')) || {
    directReports: [], supervisor: [], academicDean: [], headOfPastoral: [],
    highPriorityTopics: [], priorityDepts: [], priorityTitlePatterns: [],
  };
}
export async function readClusters() {
  const data = await attentionOverride('clusters');
  return (data?.clusters || []).map((c) => ({
    ...c, conversationIds: c.conversation_ids || c.conversationIds || [],
  }));
}
