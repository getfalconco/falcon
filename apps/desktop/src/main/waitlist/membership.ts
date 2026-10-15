import { getRendererSession, onRendererSession } from "../session-bridge";

/**
 * The signed-in user's own membership ticket, from the site's
 * GET /api/waitlist/me. The site answers only for the Supabase access token it
 * is handed, so the request carries the user's token from the session bridge
 * (main/session-bridge.ts) and never an email: nobody can be looked up but the
 * user who is signed in.
 *
 * Waitlisted accounts are signed out right after auth. The renderer asks for
 * the ticket before it signs them out (lib/waitlist-api
 * primeWaitlistMembership), and the answer is kept here in memory so the
 * waitlist screen can still show it once the token is gone.
 */

export type Membership = {
  found: boolean;
  name: string | null;
  memberNumber: number | null;
  grantedAt: string | null;
  approved: boolean;
};

export const NO_MEMBERSHIP: Membership = {
  found: false,
  name: null,
  memberNumber: null,
  grantedAt: null,
  approved: false,
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function normalizeMembership(data: unknown): Membership {
  const row = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  if (row.found !== true) return NO_MEMBERSHIP;
  return {
    found: true,
    name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : null,
    memberNumber: typeof row.memberNumber === "number" ? row.memberNumber : null,
    grantedAt: typeof row.grantedAt === "string" ? row.grantedAt : null,
    approved: row.approved === true,
  };
}

/**
 * Asks each site base in turn. Null when no base gave an answer (network,
 * 5xx); a 401 is an answer about the token, so it stops at once.
 */
export async function requestOwnMembership(
  bases: readonly string[],
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<Membership | null> {
  for (const base of bases) {
    try {
      const res = await fetchImpl(`${base}/api/waitlist/me`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "MeridianDesktop/1.0",
        },
      });
      if (res.status === 401) return NO_MEMBERSHIP;
      if (!res.ok) continue;
      return normalizeMembership(await res.json());
    } catch {
      // try next base
    }
  }
  return null;
}

/** The last ticket read with a token, for the signed-out waitlist screen. */
let lastMembership: Membership | null = null;
let lastToken: string | null = null;
let watching = false;

function watchSession(): void {
  if (watching) return;
  watching = true;
  // A different signed-in token may be someone else: forget the old ticket
  // so the waitlist screen never shows the previous account's card.
  onRendererSession((session) => {
    if (session.accessToken && session.accessToken !== lastToken) {
      lastMembership = null;
      lastToken = null;
    }
  });
}

export async function getOwnMembership(
  bases: readonly string[],
  fetchImpl: FetchLike = fetch,
): Promise<Membership> {
  watchSession();
  // Read the token now, before any await: the renderer signs a waitlisted
  // user out right after this call returns.
  const token = getRendererSession().accessToken;
  if (!token) return lastMembership ?? NO_MEMBERSHIP;

  const result = await requestOwnMembership(bases, token, fetchImpl);
  if (result) {
    lastMembership = result;
    lastToken = token;
    return result;
  }
  return lastToken === token && lastMembership ? lastMembership : NO_MEMBERSHIP;
}

/** Test seam. */
export function resetMembershipCacheForTests(): void {
  lastMembership = null;
  lastToken = null;
}
