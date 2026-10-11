import { NextResponse } from 'next/server';
import { SETTINGS_GROUPS } from '@/lib/settings/registry';
import { describeSettings } from '@/lib/settings/resolve';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(
    { settings: await describeSettings(), groups: SETTINGS_GROUPS },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
