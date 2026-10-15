import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import {
  bearerToken,
  membershipOf,
  userFromAccessToken,
} from "@/lib/waitlist-membership";

export const dynamic = "force-dynamic";

/**
 * The signed-in member's own ticket: name, member number, join date and
 * whether they are approved.
 *
 * Who is asking comes only from the Supabase access token in the
 * Authorization header, verified server-side. There is no email parameter:
 * nobody can look up anyone but themselves.
 *
 *   GET /api/waitlist/me
 *   Authorization: Bearer <supabase access token>
 *
 *   200 { found, name, memberNumber, grantedAt, approved }
 *   401 { error }  missing, expired or revoked token
 *   429 { error }  rate limited
 */
export async function GET(request: Request) {
  try {
    // Each call pages through the member list for the ticket number.
    const limit = rateLimit(`waitlist-me:${clientIp(request)}`, {
      limit: 30,
      windowMs: 60_000,
    });
    if (!limit.ok) return tooManyRequests(limit.retryAfter);

    const user = await userFromAccessToken(bearerToken(request));
    if (!user) {
      return NextResponse.json(
        { error: "Sign in to see your status." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json(await membershipOf(user), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[api/waitlist/me GET]", error);
    return NextResponse.json({ error: "Failed to load membership." }, { status: 500 });
  }
}
