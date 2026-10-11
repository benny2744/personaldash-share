import { ensureUniqueFilename } from '@/lib/vault';

export function sanitizeMeetingFilename(filename) {
  const clean = String(filename || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.endsWith('.md') ? clean : `${clean || 'Meeting Notes'}.md`;
}

export async function uniqueMeetingPath(filename) {
  return ensureUniqueFilename('meetings', sanitizeMeetingFilename(filename));
}
