/**
 * The signed-in member's access token for the AI and compute routes
 * (/api/strategy/*, /api/help), which answer 401 without it
 * (lib/strategy/guard.ts). The Workspace registers a getter once it knows who
 * is looking (Workspace.tsx useGate); the development preview has no account
 * and registers none, so its requests go without a token (allowed by
 * `next dev` only).
 */

type TokenGetter = () => Promise<string | null>;

let getToken: TokenGetter | null = null;

export function setTokenGetter(getter: TokenGetter | null): void {
  getToken = getter;
}

/** `Authorization: Bearer …` when there is a session, else nothing. */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = getToken ? await getToken().catch(() => null) : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** What a 401 from those routes says in the UI. */
export const SESSION_ENDED = "Your session ended. Sign in again.";
