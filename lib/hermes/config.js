/**
 * Server-only Hermes dashboard configuration for PersonalDash chat.
 *
 * The shared session token is injected by Hermes into its own SPA and is
 * also loaded into PersonalDash via ~/.hermes/.env. Bootstrap returns it
 * with Cache-Control: no-store behind Cloudflare Access.
 */

function normalizeBasePath(raw) {
  const value = String(raw || '').trim();
  if (!value || value === '/') return '/hermes';
  const withLead = value.startsWith('/') ? value : `/${value}`;
  return withLead.replace(/\/+$/, '');
}

/**
 * @returns {{
 *   sessionToken: string,
 *   basePath: string,
 *   dashboardUrl: string,
 *   configured: boolean,
 * }}
 */
export function getHermesConfig() {
  const sessionToken = String(
    process.env.HERMES_DASHBOARD_SESSION_TOKEN || '',
  ).trim();
  const basePath = normalizeBasePath(
    process.env.HERMES_BASE_PATH || '/hermes',
  );
  const dashboardUrl = String(
    process.env.HERMES_DASHBOARD_URL || 'http://127.0.0.1:9119',
  ).replace(/\/+$/, '');

  return {
    sessionToken,
    basePath,
    dashboardUrl,
    configured: Boolean(sessionToken),
  };
}

export function assertHermesConfigured() {
  const config = getHermesConfig();
  if (!config.configured) {
    throw new Error(
      'HERMES_DASHBOARD_SESSION_TOKEN is not configured. Set it in ~/.hermes/.env and restart hermes-dashboard + personaldash.',
    );
  }
  return config;
}
