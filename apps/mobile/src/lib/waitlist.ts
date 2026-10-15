import { requireSupabase } from "@/lib/supabase";

/**
 * Waitlist membership: the signed-in user's own ticket, from the site's
 * GET /api/waitlist/me (apps/web/app/api/waitlist/me/route.ts). The site
 * answers only for the Supabase access token it is handed; there is no lookup
 * by email.
 *
 * Waitlisted accounts are signed out right after auth (lib/auth), so the
 * ticket is read with the session just before (captureMembership) and kept
 * in memory for the status screen.
 */
export type Membership = {
  found: boolean;
  name: string | null;
  memberNumber: number | null;
  grantedAt: string | null;
  approved: boolean;
};

const SITE_URL = (process.env.EXPO_PUBLIC_SITE_URL ?? "https://getfalcon.co").replace(/\/$/, "");

/** Thrown when there is no session and no saved ticket: the user must sign in. */
export class SignInRequiredError extends Error {
  constructor() {
    super("Sign in to see your status.");
    this.name = "SignInRequiredError";
  }
}

let captured: { email: string; membership: Membership } | null = null;

async function requestOwnMembership(accessToken: string): Promise<Membership> {
  const res = await fetch(`${SITE_URL}/api/waitlist/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) throw new SignInRequiredError();
  if (!res.ok) throw new Error("Could not load your status. Try again.");

  const data = (await res.json()) as Partial<Membership>;
  return {
    found: data.found === true,
    name: data.name ?? null,
    memberNumber: data.memberNumber ?? null,
    grantedAt: data.grantedAt ?? null,
    approved: data.approved === true,
  };
}

/**
 * Reads the ticket with a live session and keeps it. Call before signing a
 * waitlisted user out. Never throws.
 */
export async function captureMembership(accessToken: string, email: string): Promise<void> {
  try {
    captured = { email: email.trim().toLowerCase(), membership: await requestOwnMembership(accessToken) };
  } catch {
    // The status screen asks the user to sign in again.
  }
}

/** Forget the kept ticket (sign-out). */
export function clearCapturedMembership(): void {
  captured = null;
}

/**
 * The signed-in user's ticket, or the one kept from their last sign-in when
 * `email` matches it. Throws SignInRequiredError when neither exists.
 */
export async function fetchMembership(email?: string): Promise<Membership> {
  const client = requireSupabase();
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (token) return requestOwnMembership(token);

  const wanted = email?.trim().toLowerCase();
  if (captured && (!wanted || captured.email === wanted)) return captured.membership;
  throw new SignInRequiredError();
}

export type ApplyInput = {
  fullName: string;
  email: string;
  phone: string;
  password: string;
};

/**
 * Creates the account carrying `waitlist: true` — the same metadata shape the
 * web signup writes, so the admin Waitlist tab lists mobile applicants too.
 */
export async function applyForEarlyAccess(input: ApplyInput): Promise<void> {
  const client = requireSupabase();
  const email = input.email.trim();

  const fullName = input.fullName.trim();
  const { data, error } = await client.auth.signUp({
    email,
    password: input.password,
    options: {
      data: {
        full_name: fullName,
        phone: input.phone.trim() || null,
        waitlist: true,
      },
    },
  });

  if (error) {
    const code = error.code;
    if (code === "user_already_exists" || code === "email_exists") {
      throw new Error("That email already has an account. Check your status instead.");
    }
    throw error;
  }

  // signUp already wrote the name onto the account. The member number comes
  // only from GET /api/waitlist/me with a live session (the site no longer
  // returns it to an unauthenticated POST /api/waitlist, and that POST cannot
  // change an existing account). With "Confirm email" on there is no session
  // yet, so the status screen shows the ticket without a number until the
  // member signs in.
  captured = null;
  const token = data.session?.access_token;
  if (token) {
    await captureMembership(token, email);
    if (captured) return;
  }
  captured = {
    email: email.toLowerCase(),
    membership: {
      found: true,
      name: fullName || null,
      memberNumber: null,
      grantedAt: null,
      approved: false,
    },
  };
}
