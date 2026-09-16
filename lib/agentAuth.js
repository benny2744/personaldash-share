import { timingSafeEqual } from 'node:crypto';
// Explicit .js path: this Next build has no exports map for "next/server",
// and the explicit file also resolves under plain Node (node --test).
import { NextResponse } from 'next/server.js';
import { getHermesConfig } from '@/lib/hermes/config';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Credential for PersonalDash's agent-facing write endpoints (Hermes calling
 * INTO PersonalDash). Deliberately independent of the browser-exposed Hermes
 * dashboard token so the two can rotate/scope separately; the Hermes token is
 * kept as a fallback for existing deployments.
 */
export function getAgentApiToken() {
  const token = String(process.env.AGENT_API_TOKEN || '').trim();
  if (token) return token;
  return getHermesConfig().sessionToken;
}

/**
 * Shared-secret guard for agent-facing write endpoints.
 * Returns null when authorized, or a 401 response to return immediately.
 */
export function requireAgentAuth(request) {
  const denied = NextResponse.json(
    { error: 'Unauthorized' },
    { status: 401, headers: NO_STORE },
  );

  const expected = getAgentApiToken();
  const provided = request.headers.get('x-hermes-session-token') || '';
  if (!expected || !provided) return denied;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return denied;
  return null;
}
