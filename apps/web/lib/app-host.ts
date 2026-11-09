/**
 * The product sign-in lives on its own host (app.getfalcon.co), served by this
 * same Next.js site: middleware.ts rewrites `/` there to the login screen.
 */

/** Marketing site origin, where non-auth pages on the app host are sent. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://getfalcon.co").replace(/\/$/, "");

/**
 * Where "Get started" goes. In development it stays on the local server
 * (`/login`) unless NEXT_PUBLIC_APP_URL is set, e.g. http://app.localhost:3000.
 */
export const APP_URL = (
  process.env.NEXT_PUBLIC_APP_URL ||
  (process.env.NODE_ENV === "development" ? "/login" : "https://app.getfalcon.co")
).replace(/\/$/, "");

/** True for app.getfalcon.co and app.localhost (any port). */
export function isAppHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const name = host.split(":")[0].toLowerCase();
  return name === "app.getfalcon.co" || name === "app.localhost";
}
