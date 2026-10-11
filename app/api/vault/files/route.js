import { NextResponse } from 'next/server';
import { listDirectory } from '@/lib/vault';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const path = searchParams.get('path') || '';

  try {
    const files = await listDirectory(path);
    return NextResponse.json(files);
  } catch (error) {
    console.error('Error listing vault directory:', error);
    return NextResponse.json({ error: 'Failed to list directory' }, { status: 500 });
  }
}
