import { configurationChat } from '@/lib/setup/agent';
import { configurationRequestError } from '@/lib/settings/requestGuard';
export const runtime = 'nodejs';
export async function POST(request) {
  const denied = configurationRequestError(request);
  if (denied) return Response.json({ error: denied }, { status: 403 });
  try {
    const body = await request.json();
    if (
      !Array.isArray(body.messages) ||
      body.messages.length > 40 ||
      body.messages.some(
        (m) =>
          !m ||
          !['user', 'assistant'].includes(m.role) ||
          typeof m.content !== 'string' ||
          m.content.length > 8000,
      )
    )
      return Response.json(
        { error: 'Send a short configuration conversation.' },
        { status: 400 },
      );
    return Response.json(await configurationChat(body.messages), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json(
      {
        error:
          'The setup assistant could not answer. Check the AI connection and try again.',
      },
      { status: 502 },
    );
  }
}
