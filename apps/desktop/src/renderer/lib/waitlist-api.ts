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
  | { ok: true; status: "created" | "updated"; memberNumber: number | null }
  | { ok: false; error: string };

const NOT_FOUND: Membership = {
  found: false,
  name: null,
  memberNumber: null,
  grantedAt: null,
  approved: false,
};

/** Membership-card lookup by email. Returns { found:false } for unknown emails. */
export async function getMembership(email: string): Promise<Membership> {
  const bridge = window.meridian?.getWaitlistMembership;
  if (!bridge) return NOT_FOUND;
  try {
    return await bridge(email.trim().toLowerCase());
  } catch {
    return NOT_FOUND;
  }
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
