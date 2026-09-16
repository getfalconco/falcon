import { NextResponse } from "next/server";
import {
  createAdminSession,
  verifyAdminCredentials,
} from "@/lib/admin-session";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    // Throttle password guessing: the admin credential is a single shared
    // secret, so an unlimited endpoint is a brute-force target.
    const limit = rateLimit(`admin-login:${clientIp(request)}`, {
      limit: 8,
      windowMs: 5 * 60_000,
    });
    if (!limit.ok) return tooManyRequests(limit.retryAfter);

    const body = (await request.json()) as { email?: string; password?: string };
    const email = body.email?.trim() ?? "";
    const password = body.password ?? "";

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
    }

    if (!verifyAdminCredentials(email, password)) {
      return NextResponse.json({ error: "Invalid admin credentials." }, { status: 401 });
    }

    await createAdminSession(email);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[admin login]", error);
    return NextResponse.json({ error: "Admin login failed." }, { status: 500 });
  }
}
