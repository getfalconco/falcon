import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { bearerToken, userFromAccessToken } from "@/lib/waitlist-membership";
import { brokerAuthorizeUrl, portfolioSources } from "@/lib/portfolio-server";
import { isAllowedReturnOrigin, writeBrokerCookie } from "../session";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Where the result goes once SnapTrade sends the member to the done page:
 * "app" (the iPhone app's falcon:// deep link) or a Falcon web origin. The
 * caller says so in the body; otherwise the request's Origin, else the app host.
 */
async function returnTarget(request: Request): Promise<string> {
  let asked: unknown;
  try {
    asked = ((await request.json()) as { returnTo?: unknown }).returnTo;
  } catch {
    asked = undefined;
  }
  if (asked === "app") return "app";
  if (typeof asked === "string" && isAllowedReturnOrigin(asked)) return asked;
  const origin = request.headers.get("origin");
  if (origin && isAllowedReturnOrigin(origin)) return origin;
  return "https://app.getfalcon.co";
}

/**
 * Starts a read-only SnapTrade OAuth connection for the signed-in member and
 * returns SnapTrade's consent page link. The redirect always goes to the one
 * registered URI on the app host (see done/route.ts).
 *
 *   POST /api/portfolio/broker/start { returnTo?: "app" | origin } -> 200 { url }
 *   401 not signed in, 429 rate limited, 503 not configured
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

  const url = brokerAuthorizeUrl(user.id, await returnTarget(request));
  const response = NextResponse.json({ url }, { headers: NO_STORE });
  // A ticket left over from an earlier try is dropped.
  writeBrokerCookie(response, request, null);
  return response;
}
