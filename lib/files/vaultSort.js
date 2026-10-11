/**
 * lib/files/vaultSort.js — pure sort for the vault explorer table.
 * Directories are pinned above files; the chosen key sorts within each
 * group. Entries missing the sort value sort last (within their group).
 */

const DIR_GROUP = 0;
const FILE_GROUP = 1;

function group(entry) {
  return entry.type === 'directory' ? DIR_GROUP : FILE_GROUP;
}

/**
 * @param {Array<{name: string, type: 'directory'|'file', size?: number|null, modifiedAt?: string|null}>} entries
 * @param {{key?: 'name'|'modified'|'size', dir?: 'asc'|'desc'}} [sort]
 */
export function sortVaultEntries(entries, { key = 'name', dir = 'asc' } = {}) {
  const sorted = [...entries].sort((a, b) => {
    const groupDiff = group(a) - group(b);
    if (groupDiff !== 0) return groupDiff;

    let cmp = 0;
    if (key === 'name') {
      cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      return dir === 'desc' ? -cmp : cmp;
    }
    if (key === 'modified') {
      const av = a.modifiedAt ? Date.parse(a.modifiedAt) : null;
      const bv = b.modifiedAt ? Date.parse(b.modifiedAt) : null;
      return compareNullableDescAware(av, bv, dir);
    }
    if (key === 'size') {
      return compareNullableDescAware(a.size ?? null, b.size ?? null, dir);
    }
    return cmp;
  });
  return sorted;
}

// Missing values always sort last, regardless of direction.
function compareNullableDescAware(a, b, dir) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const cmp = a - b;
  return dir === 'desc' ? -cmp : cmp;
}
