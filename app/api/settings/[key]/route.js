import { NextResponse } from 'next/server';
import { SETTINGS_BY_KEY } from '@/lib/settings/registry';
import { resetSetting, setSetting } from '@/lib/settings/resolve';
import { configurationRequestError } from '@/lib/settings/requestGuard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PUT /api/settings/[key] — validate + persist an override.
 * DELETE /api/settings/[key] — remove the override (fall back to env/default).
 */
export async function PUT(request, { params }) {
  const denied = configurationRequestError(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 403 });
  const { key } = await params;
  if (!SETTINGS_BY_KEY.has(key)) {
    return NextResponse.json(
      { error: `Unknown setting '${key}'` },
      { status: 404 },
    );
  }
  try {
    const body = await request.json();
    await setSetting(key, body?.value);
    return NextResponse.json({ key, saved: true });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : error.statusCode || 500;
    return NextResponse.json(
      { error: status === 500 ? 'Could not save the setting' : error.message },
      { status },
    );
  }
}

export async function DELETE(request, { params }) {
  const denied = configurationRequestError(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 403 });
  const { key } = await params;
  if (!SETTINGS_BY_KEY.has(key)) {
    return NextResponse.json(
      { error: `Unknown setting '${key}'` },
      { status: 404 },
    );
  }
  try {
    await resetSetting(key);
    return NextResponse.json({ key, reset: true });
  } catch {
    return NextResponse.json(
      { error: 'Could not reset the setting' },
      { status: 500 },
    );
  }
}
