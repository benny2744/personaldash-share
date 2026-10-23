export function getOpencodeFrameUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function getOpencodeHosts(value, fallback) {
  const hosts = [];
  for (const entry of (value || '').split(',')) {
    const separator = entry.indexOf('|');
    if (separator < 1) continue;
    const label = entry.slice(0, separator).trim();
    const url = getOpencodeFrameUrl(entry.slice(separator + 1));
    if (!label || !url || hosts.some((host) => host.url === url)) continue;
    const parsed = new URL(url);
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/'
    )
      continue;
    hosts.push({ id: parsed.host, label, url });
  }
  if (!hosts.length) {
    const url = getOpencodeFrameUrl(fallback);
    if (url) hosts.push({ id: new URL(url).host, label: 'OpenCode', url });
  }
  return hosts;
}
