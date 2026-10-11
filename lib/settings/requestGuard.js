/** Reject cross-site browser writes, including requests through the host proxy. */
export function configurationRequestError(request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    return 'Cross-site configuration requests are not allowed';
  const origin = request.headers.get('origin');
  if (!origin) return null; // non-browser integrations rely on deployment authentication
  try {
    const source = new URL(origin);
    const host = request.headers.get('host') || new URL(request.url).host;
    if (!['http:', 'https:'].includes(source.protocol) || source.host !== host)
      return 'Cross-site configuration requests are not allowed';
  } catch {
    return 'Invalid request origin';
  }
  return null;
}
