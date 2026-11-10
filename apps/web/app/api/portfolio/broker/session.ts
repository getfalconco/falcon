import type { NextResponse } from "next/server";
import type { BrokerSession } from "@/lib/portfolio-server";

/**
 * The throwaway SnapTrade user for one import, kept only in an httpOnly
 * cookie scoped to these routes (the browser can't read it) for 30 minutes.
 */
const COOKIE = "falcon_broker";
const PATH = "/api/portfolio/broker";

export function readBrokerSession(request: Request): BrokerSession | null {
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(decodeURIComponent(raw), "base64url").toString("utf8")) as Partial<BrokerSession>;
    if (typeof parsed.userId === "string" && typeof parsed.userSecret === "string") {
      return { userId: parsed.userId, userSecret: parsed.userSecret };
    }
  } catch {
    // Malformed cookie: treat as no session.
  }
  return null;
}

export function writeBrokerSession(response: NextResponse, request: Request, session: BrokerSession | null) {
  response.cookies.set(COOKIE, session ? Buffer.from(JSON.stringify(session)).toString("base64url") : "", {
    httpOnly: true,
    secure: new URL(request.url).protocol === "https:",
    sameSite: "lax",
    path: PATH,
    maxAge: session ? 30 * 60 : 0,
  });
}
