export function wikilinksToMarkdown(text) {
  return String(text || '').replace(/\[\[([^[\]]+)\]\]/g, (_, inner) => {
    const [targetPart, aliasPart] = inner.split('|');
    const target = (targetPart || '').trim();
    const label = (aliasPart || target).trim();
    if (!target) return label;
    return `[${label}](/vault/${encodeURIComponent(target)})`;
  });
}

export function toDateInputValue(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function toCsv(value) {
  if (!Array.isArray(value) || value.length === 0) return '';
  return value.join(', ');
}

export function parseCsv(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
