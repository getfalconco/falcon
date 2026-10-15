import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { handleEnsureEmail, type EnsureEmailDeps } from "@/lib/ensure-email";
import { bearerToken, userFromAccessToken } from "@/lib/waitlist-membership";

const NO_STORE = { "Cache-Control": "no-store" };

/** The real Supabase admin calls behind lib/ensure-email.ts. */
function adminDeps(): EnsureEmailDeps {
  return {
    userFromAccessToken,
    async confirmEmail(userId) {
      const { error } = await getSupabaseAdmin().auth.admin.updateUserById(userId, {
        email_confirm: true,
      });
      if (error) throw error;
    },
    rateLimit,
    // Every unauthenticated answer takes the same time, with jitter.
    minAnonymousMs: 400 + Math.floor(Math.random() * 200),
  };
}

/**
 * Legacy email-confirmation helper (logic and rules in lib/ensure-email.ts).
 *
 *   POST /api/auth/ensure-email  { email }
 *
 *   No token: always 200 { ok: true, confirmed: false }. Nothing is looked up
 *   or changed, so the answer says nothing about whether the email exists.
 *
 *   Authorization: Bearer <supabase access token>: answers for the token's
 *   own account only, and confirms it only when the session came from an
 *   email code or link.
 */
export async function POST(request: Request) {
  try {
    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      body = null;
    }

    const result = await handleEnsureEmail(adminDeps(), {
      ip: clientIp(request),
      token: bearerToken(request),
      body,
    });
    if (result.status === 429) return tooManyRequests(result.retryAfter ?? 60, NO_STORE);
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  } catch (error) {
    console.error("[auth/ensure-email]", error);
    return NextResponse.json(
      { error: "Failed to ensure email." },
      { status: 500, headers: NO_STORE },
    );
  }
}
