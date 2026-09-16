/**
 * Finnhub endpoint resolution shared by every caller in this package (and the
 * desktop's calendar sources).
 *
 * By default requests go straight to finnhub.io with `FINNHUB_API_KEY`. A
 * packaged desktop build has no provider key of its own: it sets
 * `FINNHUB_BASE_URL` to the research-worker's `/api/finnhub` proxy and puts the
 * user's Supabase JWT in `FINNHUB_API_KEY`; the proxy verifies the JWT and
 * swaps in the real key. Callers don't need to know which mode is active.
 */

const DEFAULT_BASE = "https://finnhub.io/api/v1";

/** Base URL without a trailing slash, e.g. `https://finnhub.io/api/v1`. */
export function finnhubApiBase(): string {
  const fromEnv = process.env.FINNHUB_BASE_URL?.trim();
  return (fromEnv || DEFAULT_BASE).replace(/\/+$/, "");
}

/** `/quote?symbol=…` → full URL on the active base (token not included). */
export function finnhubUrl(pathWithQuery: string): string {
  const rel = pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`;
  return `${finnhubApiBase()}${rel}`;
}
