import { setSettings, getSetting } from '@/lib/settings/resolve';
import { SETTINGS_BY_KEY, validateSettingValue } from '@/lib/settings/registry';
import { providerRequest, sameEndpoint } from '@/lib/setup/provider';
import { configurationRequestError } from '@/lib/settings/requestGuard';

export const runtime = 'nodejs';

export async function POST(request) {
  const denied = configurationRequestError(request);
  if (denied) return Response.json({ error: denied }, { status: 403 });
  try {
    const body = await request.json();
    const baseUrl = String(body.baseUrl || '').trim();
    const model = String(body.model || '').trim();
    for (const [key, value] of [
      ['llm.baseUrl', baseUrl],
      ['llm.model', model],
    ]) {
      if (!value || !validateSettingValue(SETTINGS_BY_KEY.get(key), value).ok)
        return Response.json(
          { error: 'Enter a server URL, model, and API key.' },
          { status: 400 },
        );
    }
    const submittedKey =
      typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    let apiKey = submittedKey;
    if (!apiKey) {
      // A blank key field may reuse the STORED key — but only for the SAME
      // endpoint. Never send an existing credential to a newly entered
      // server; require a fresh key when switching endpoints.
      if (sameEndpoint((await getSetting('llm.baseUrl')) || '', baseUrl)) {
        apiKey = (await getSetting('llm.apiKey')) || '';
      }
    }
    if (!apiKey)
      return Response.json(
        { error: 'Enter a server URL, model, and API key.' },
        { status: 400 },
      );
    await providerRequest(
      { baseUrl, model, apiKey },
      [{ role: 'user', content: 'Reply with OK.' }],
      { max_tokens: 16 },
    );
    // One transaction: the connection is never half-updated.
    await setSettings([
      ['llm.baseUrl', baseUrl],
      ['llm.model', model],
      ['llm.apiKey', apiKey],
    ]);
    return Response.json({ saved: true });
  } catch {
    return Response.json(
      { error: 'Could not connect. Check the server URL, model, and key.' },
      { status: 400 },
    );
  }
}
