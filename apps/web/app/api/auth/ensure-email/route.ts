import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";

/**
 * Confirm the email of a known account (approved member or waitlist entry) so
 * signInWithPassword works without an OTP loop.
 *
 * Waitlist entries are included on purpose: signup emails can fail to send, so
 * confirmation would otherwise be unreachable and lock people out of even
 * checking their own status. Confirming grants no access by itself — waitlist
 * users are still signed out and shown the waitlist screen — and the password
 * check stays authoritative.
 */
export async function POST(request: Request) {
  try {
    // Unauthenticated + pages through every user per call, so throttle per IP.
    const limit = rateLimit(`ensure-email:${clientIp(request)}`, {
      limit: 15,
      windowMs: 60_000,
    });
    if (!limit.ok) return tooManyRequests(limit.retryAfter);

    const body = (await request.json()) as { email?: string };
    const email = body.email?.trim().toLowerCase();
    if (!email) {
      return NextResponse.json({ error: "email required" }, { status: 400 });
    }

    const admin = getSupabaseAdmin();
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) throw error;

    const user = data.users.find((u) => u.email?.toLowerCase() === email);
    if (!user) {
      return NextResponse.json({ ok: true, confirmed: false, reason: "not_found" });
    }

    const approved =
      user.app_metadata?.approved === true || user.user_metadata?.approved === true;
    const waitlisted =
      user.app_metadata?.waitlist === true || user.user_metadata?.waitlist === true;

    if (!approved && !waitlisted) {
      return NextResponse.json({ ok: true, confirmed: false, reason: "unknown_account" });
    }

    if (user.email_confirmed_at) {
      return NextResponse.json({ ok: true, confirmed: true, reason: "already" });
    }

    const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
      email_confirm: true,
    });
    if (updateError) throw updateError;

    return NextResponse.json({ ok: true, confirmed: true, reason: "fixed" });
  } catch (error) {
    console.error("[auth/ensure-email]", error);
    return NextResponse.json({ error: "Failed to ensure email." }, { status: 500 });
  }
}
