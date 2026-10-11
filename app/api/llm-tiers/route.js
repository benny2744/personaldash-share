import { NextResponse } from 'next/server';
import { listTiers, upsertTier, deleteTier, TIERS_LIST } from '@/lib/llmTiers';

export const dynamic = 'force-dynamic';

export async function GET() {
  const tiers = await listTiers();
  return NextResponse.json(
    { tiers, known: TIERS_LIST },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function PUT(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const tier = String(body?.tier || '').trim();
  if (!TIERS_LIST.includes(tier.toLowerCase())) {
    return NextResponse.json(
      { error: `unknown tier '${tier}'` },
      { status: 400 },
    );
  }
  try {
    const saved = await upsertTier(tier, body?.model, body?.baseUrl);
    return NextResponse.json(saved);
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'save failed' },
      { status: 400 },
    );
  }
}

export async function DELETE(request) {
  const tier = new URL(request.url).searchParams.get('tier');
  if (!tier) {
    return NextResponse.json({ error: 'tier query param required' }, { status: 400 });
  }
  await deleteTier(tier);
  return NextResponse.json({ ok: true });
}
