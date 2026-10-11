import { NextResponse } from 'next/server';
import { getHermesConfig } from '@/lib/hermes/config';

export const dynamic = 'force-dynamic';

/**
 * Expose same-origin Hermes auth bootstrap for the native /chat client.
 * Protected by Cloudflare Access in production; never cache the token.
 */
export async function GET() {
  const config = getHermesConfig();

  if (!config.configured) {
    return NextResponse.json(
      {
        error:
          'HERMES_DASHBOARD_SESSION_TOKEN is not configured. Set it in ~/.hermes/.env and restart hermes-dashboard + the dashboard app.',
        configured: false,
      },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  return NextResponse.json(
    {
      configured: true,
      token: config.sessionToken,
      basePath: config.basePath,
      wsPath: `${config.basePath}/api/ws`,
      authRequired: false,
      dashboardUrl: config.dashboardUrl,
    },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      },
    },
  );
}
