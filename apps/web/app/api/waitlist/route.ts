import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { handleWaitlistApply, type WaitlistApplyDeps } from "@/lib/waitlist-apply";
import {
  bearerToken,
  memberNumberFor,
  userFromAccessToken,
} from "@/lib/waitlist-membership";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Retired: this used to look a membership up by `?email=`, which handed any
 * caller the name and status of any address and put the email in the URL.
 * The signed-in member's own ticket now comes from GET /api/waitlist/me,
 * authenticated by their Supabase access token. Builds that still call this
 * get a 410 and fall back to their placeholder ticket.
 */
export async function GET() {
  return NextResponse.json(
    { error: "This lookup has moved. Sign in to see your status." },
    { status: 410, headers: NO_STORE },
  );
}

/** The real Supabase admin calls behind lib/waitlist-apply.ts. */
function adminDeps(): WaitlistApplyDeps {
  const admin = getSupabaseAdmin();
  return {
    userFromAccessToken,
    async createUser({ email, password, userMetadata }) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        email_confirm: false,
        ...(password ? { password } : {}),
        user_metadata: userMetadata,
      });
      return !error && data?.user ? { ok: true } : { ok: false, error };
    },
    async findUserByEmail(email) {
      const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) throw error;
      return data.users.find((u) => u.email?.toLowerCase() === email) ?? null;
    },
    async updateUserMetadata(userId, metadata) {
      const { error } = await admin.auth.admin.updateUserById(userId, {
        user_metadata: metadata,
      });
      if (error) throw error;
    },
    memberNumberFor,
    // About one account insert, plus jitter: a taken email (fast rejection)
    // should not answer visibly sooner than a new one.
    minAnonymousMs: 900 + Math.floor(Math.random() * 250),
  };
}

/**
 * Founding-membership capture (logic in lib/waitlist-apply.ts).
 *
 *   POST /api/waitlist  { name, email, password?, phone?, application? }
 *
 *   No token: creates the account when the email is free. A taken email is
 *   left untouched. Both answer 200 { ok: true }, nothing else.
 *
 *   Authorization: Bearer <supabase access token>: updates the token's own
 *   user only and answers 200 { ok: true, memberNumber }. 401 for a bad
 *   token, 403 when a body email names a different account.
 */
export async function POST(request: Request) {
  try {
    // Creates a Supabase auth user with no auth on the caller: throttle hard so
    // it can't be scripted into mass account creation / squatting.
    const limit = rateLimit(`waitlist-post:${clientIp(request)}`, {
      limit: 8,
      windowMs: 60_000,
    });
    if (!limit.ok) return tooManyRequests(limit.retryAfter);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "A valid email is required." },
        { status: 400, headers: NO_STORE },
      );
    }

    // Per address too, so one email can't be hammered from many IPs. The same
    // limit applies whether or not the email has an account.
    const rawEmail =
      body && typeof body === "object" ? (body as { email?: unknown }).email : undefined;
    const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
    if (email) {
      const perEmail = rateLimit(`waitlist-post-email:${email}`, {
        limit: 10,
        windowMs: 10 * 60_000,
      });
      if (!perEmail.ok) return tooManyRequests(perEmail.retryAfter);
    }

    const result = await handleWaitlistApply(adminDeps(), {
      token: bearerToken(request),
      body,
    });
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  } catch (error) {
    console.error("[api/waitlist POST]", error);
    return NextResponse.json(
      { error: "Failed to claim your ticket." },
      { status: 500, headers: NO_STORE },
    );
  }
}
