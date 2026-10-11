const levels = ['HIGH', 'NORMAL', 'DIGEST_ONLY', 'IGNORE'];
const priorityKeys = [
  'directReports',
  'supervisor',
  'academicDean',
  'headOfPastoral',
  'highPriorityTopics',
  'priorityDepts',
  'priorityTitlePatterns',
];

/** Validate the on-disk format consumed by the attention pipeline. */
export function validateAttention(name, data) {
  if (
    !['watches', 'priorities', 'clusters'].includes(name) ||
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data)
  )
    throw new Error('Invalid attention configuration');
  if (JSON.stringify(data).length > 200000)
    throw new Error('Configuration is too large');
  if (name === 'watches') {
    if (
      !Array.isArray(data.watches) ||
      !data.watches.every(
        (w) =>
          w &&
          typeof w.conversation_id === 'string' &&
          w.conversation_id &&
          levels.includes(w.level),
      )
    )
      throw new Error('Watches require conversation_id and a valid level');
    if (
      new Set(data.watches.map((w) => w.conversation_id)).size !==
      data.watches.length
    )
      throw new Error('Duplicate watched conversations');
  }
  if (name === 'clusters') {
    if (
      !Array.isArray(data.clusters) ||
      !data.clusters.every(
        (c) =>
          c &&
          typeof c.id === 'string' &&
          c.id &&
          Array.isArray(c.conversation_ids ?? c.conversationIds) &&
          (c.conversation_ids ?? c.conversationIds).every(
            (id) => typeof id === 'string' && id,
          ) &&
          (!(c.default_watch_level ?? c.defaultWatchLevel) ||
            levels.includes(c.default_watch_level ?? c.defaultWatchLevel)),
      )
    )
      throw new Error('Clusters require IDs and conversation ID lists');
    if (new Set(data.clusters.map((c) => c.id)).size !== data.clusters.length)
      throw new Error('Duplicate cluster IDs');
  }
  if (
    name === 'priorities' &&
    !Object.entries(data).every(
      ([key, value]) =>
        priorityKeys.includes(key) &&
        Array.isArray(value) &&
        value.every((item) => typeof item === 'string'),
    )
  )
    throw new Error('Priorities must be supported lists of names or rules');
  return data;
}

export function parseAttention(name, text) {
  const fences = [
    ...String(text || '').matchAll(/```json\s*\n([\s\S]*?)\n```/g),
  ];
  if (!fences.length) throw new Error('Missing JSON configuration fence');
  // The configuration fence is always written LAST, after the summary; an
  // earlier fence inside assistant-authored summary text must not win.
  const fence = fences[fences.length - 1];
  return validateAttention(name, JSON.parse(fence[1]));
}
