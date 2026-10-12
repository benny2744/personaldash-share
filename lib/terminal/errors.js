/**
 * lib/terminal/errors.js — plain HTTP-tagged errors for the terminal libs.
 * Lib modules stay Next-free (unit-testable under plain node); API routes
 * catch these and map to NextResponse.
 */

export function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** Map a thrown error to a response status, logging true 500s. */
export function errorStatus(error, { logEvent } = {}) {
  const status = Number(error?.status) || 500;
  if (status >= 500 && logEvent) {
    console.error(
      JSON.stringify({ event: logEvent, error: error?.message || String(error) }),
    );
  }
  return status;
}
