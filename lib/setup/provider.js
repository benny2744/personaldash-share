import { getSetting } from '@/lib/settings/resolve';
import config from '@/lib/config';

/** Same host+port+path (trailing slash ignored) → same endpoint. */
export function sameEndpoint(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return (
      left.host === right.host &&
      left.protocol === right.protocol &&
      left.pathname.replace(/\/+$/, '') === right.pathname.replace(/\/+$/, '')
    );
  } catch {
    return false;
  }
}

export async function setupProvider() {
  return {
    baseUrl:
      (await getSetting('llm.baseUrl')) ||
      config.meetingLlmLightBaseUrl ||
      config.meetingLlmBaseUrl ||
      config.zaiBaseUrl ||
      config.mimoBaseUrl,
    model:
      (await getSetting('llm.model')) ||
      config.meetingLlmLightModel ||
      config.meetingLlmModel,
    apiKey:
      (await getSetting('llm.apiKey')) ||
      config.meetingLlmLightApiKey ||
      config.meetingLlmApiKey ||
      config.zaiApiKey ||
      config.mimoApiKey,
  };
}

export async function providerRequest(provider, messages, extra = {}) {
  const response = await fetch(
    `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(90000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        temperature: 0.1,
        max_tokens: 3000,
        ...extra,
      }),
    },
  );
  if (!response.ok)
    throw new Error(`AI server returned HTTP ${response.status}`);
  const data = await response.json();
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('AI server returned no answer');
  return message;
}
