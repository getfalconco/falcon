/**
 * Handover briefing: which user a stored report belongs to.
 *
 * The main process holds no user record, only the access token the renderer
 * hands over through the session bridge. The token's `sub` claim is the
 * account id, and it is stable across refreshes of the token itself, which is
 * what a cache partition needs.
 *
 * The signature is not checked, on purpose. The key only picks a file name on
 * this machine: a forged token buys a cache partition of its own and nothing
 * else, while checking it would need the project's signing secret in a
 * process that is not allowed to hold one.
 */

export const ANONYMOUS_USER_KEY = "anon";

/** Lower-case letters, digits and hyphens: safe inside a file name and never a path. */
const USER_KEY_SHAPE = /^[a-z0-9-]{1,64}$/;

export function userKeyFromAccessToken(token: string | null | undefined): string {
  if (typeof token !== "string") return ANONYMOUS_USER_KEY;
  const payload = token.split(".")[1];
  if (!payload) return ANONYMOUS_USER_KEY;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const sub = claims !== null && typeof claims === "object" ? (claims as { sub?: unknown }).sub : null;
    const key = typeof sub === "string" ? sub.trim().toLowerCase() : "";
    return USER_KEY_SHAPE.test(key) ? key : ANONYMOUS_USER_KEY;
  } catch {
    return ANONYMOUS_USER_KEY;
  }
}
