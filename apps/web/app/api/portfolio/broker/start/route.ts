import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { APP_URL } from "@/lib/app-host";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { bearerToken, userFromAccessToken } from "@/lib/waitlist-membership";
import { endBrokerConnection, portfolioSources, startBrokerConnection } from "@/lib/portfolio-server";
import { readBrokerSession, writeBrokerSession } from "../session";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** Where SnapTrade sends the member back: this deployment when it's ours, else the app host. */
function returnOrigin(request: Request): string {
  const origin = new URL(request.url).origin;
  const host = new URL(origin).hostname;
  const ours = host === "getfalcon.co" || host.endsWith(".getfalcon.co") || host === "localhost" || host.endsWith(".localhost");
  return ours ? origin : APP_URL;
}

/**
 * Starts a read-only broker connection through SnapTrade's Connection Portal
 * for the signed-in member. Returns the portal link; the SnapTrade user's
 * secret stays server-side in an httpOnly cookie.
 *
 *   POST /api/portfolio/broker/start -> 200 { url }
 *   401 not signed in, 429 rate limited, 502 SnapTrade failed, 503 not configured
 */
export async function POST(request: Request) {
  const limit = rateLimit(`portfolio-broker-ip:${clientIp(request)}`, { limit: 10, windowMs: 10 * 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);

  if (!portfolioSources().broker) {
    return NextResponse.json({ error: "Broker connections aren't available yet." }, { status: 503, headers: NO_STORE });
  }
  const user = await userFromAccessToken(bearerToken(request)).catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "Sign in again to connect a broker." }, { status: 401, headers: NO_STORE });
  }

  // A link left over from an earlier try is removed first.
  const previous = readBrokerSession(request);
  if (previous) await endBrokerConnection(previous);

  try {
    const { session, url } = await startBrokerConnection(
      `falcon-${randomUUID()}`,
      `${returnOrigin(request)}/api/portfolio/broker/done`,
    );
    const response = NextResponse.json({ url }, { headers: NO_STORE });
    writeBrokerSession(response, request, session);
    return response;
  } catch (error) {
    console.error("[portfolio broker start]", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json(
      { error: "We couldn't reach the broker service. Try again in a moment." },
      { status: 502, headers: NO_STORE },
    );
  }
}
