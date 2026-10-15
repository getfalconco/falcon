/**
 * Waitlist membership + application, proxied through the main process (see
 * main/waitlist/register-waitlist-handlers.ts) so the renderer never makes a
 * cross-origin request that Electron would block via CORS.
 */

export type Membership = {
  found: boolean;
  name: string | null;
  memberNumber: number | null;
  grantedAt: string | null;
  approved: boolean;
};

export type ApplicationAnswers = Record<string, string>;

export type ApplyPayload = {
  name: string;
  email: string;
  password?: string;
  phone?: string;
  application?: ApplicationAnswers;
};

export type ApplyResult =
  | { ok: true; memberNumber: number | null }
  | { ok: false; error: string };

const NOT_FOUND: Membership = {
  found: false,
  name: null,
  memberNumber: null,
  grantedAt: null,
  approved: false,
};

/** A ticket request already on its way (see primeWaitlistMembership). */
let inflight: Promise<Membership> | null = null;
const PRIME_TIMEOUT_MS = 6000;

/**
 * The signed-in user's own ticket. Main asks the site with the user's session
 * token (main/waitlist/membership.ts); there is no lookup by email. Signed
 * out, it answers with the ticket last read while signed in, if any.
 */
export async function getMembership(): Promise<Membership> {
  if (inflight) return inflight;
  const bridge = window.meridian?.getWaitlistMembership;
  if (!bridge) return NOT_FOUND;
  try {
    return await bridge();
  } catch {
    return NOT_FOUND;
  }
}

/**
 * Waitlisted accounts are signed out right after auth, and the site only
 * answers for a live session. Call this BEFORE that sign-out: it reads the
 * ticket while the token is still valid, and main keeps it for the waitlist
 * screen. Resolves within PRIME_TIMEOUT_MS either way, so sign-out is never
 * held up by a slow site. Concurrent callers share one request.
 */
export function primeWaitlistMembership(): Promise<void> {
  if (!inflight) {
    const request = getMembership();
    inflight = request;
    void request.finally(() => {
      if (inflight === request) inflight = null;
    });
  }
  const request = inflight;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, PRIME_TIMEOUT_MS);
    void request.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Founding-member capture: creates the waitlist auth user with the application. */
export async function applyToWaitlist(payload: ApplyPayload): Promise<ApplyResult> {
  const bridge = window.meridian?.applyToWaitlist;
  if (!bridge) return { ok: false, error: "Application is unavailable right now." };
  try {
    return await bridge({ ...payload, email: payload.email.trim().toLowerCase() });
  } catch {
    return { ok: false, error: "Failed to submit your application." };
  }
}
