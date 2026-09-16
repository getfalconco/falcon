import { NextResponse } from "next/server";
import {
  createAdminSession,
  isTalentManagerRole,
} from "@/lib/admin-session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";

/**
 * Bridge: Falcon product login → limited admin cookie for Talent Managers.
 * Founder admin still uses ADMIN_EMAIL / ADMIN_PASSWORD via /api/admin/login.
 */
export async function POST(request: Request) {
  try {
    const limit = rateLimit(`admin-talent-session:${clientIp(request)}`, {
      limit: 20,
      windowMs: 5 * 60_000,
    });
    if (!limit.ok) return tooManyRequests(limit.retryAfter);

    const auth = request.headers.get("authorization") ?? "";
    const accessToken = auth.toLowerCase().startsWith("bearer ")
      ? auth.slice(7).trim()
      : "";
    if (!accessToken) {
      return NextResponse.json({ error: "Missing session." }, { status: 401 });
    }

    const admin = getSupabaseAdmin();
    const { data: userData, error } = await admin.auth.getUser(accessToken);
    const user = userData?.user;
    if (error || !user) {
      return NextResponse.json({ error: "Invalid session." }, { status: 401 });
    }

    const role =
      user.app_metadata?.role ?? user.user_metadata?.role ?? null;
    if (!isTalentManagerRole(role)) {
      return NextResponse.json(
        { error: "Not a talent manager." },
        { status: 403 },
      );
    }

    const email = (user.email ?? "").trim().toLowerCase();
    if (!email) {
      return NextResponse.json({ error: "Account has no email." }, { status: 400 });
    }

    await createAdminSession(email, "talent_manager");
    return NextResponse.json({ ok: true, access: "talent_manager" });
  } catch (err) {
    console.error("[admin talent-session]", err);
    return NextResponse.json(
      { error: "Could not open talent manager session." },
      { status: 500 },
    );
  }
}
