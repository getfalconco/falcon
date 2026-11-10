import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { bearerToken, userFromAccessToken } from "@/lib/waitlist-membership";
import { brokerHoldings, endBrokerConnection } from "@/lib/portfolio-server";
import { readBrokerSession, writeBrokerSession } from "../session";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Reads the holdings from the member's connected broker accounts, then deletes
 * the throwaway SnapTrade user and clears its cookie: nothing stays linked.
 *
 *   POST /api/portfolio/broker/holdings -> 200 { holdings }
 *   401 not signed in, 409 no connection in progress, 502 SnapTrade failed
 */
export async function POST(request: Request) {
  const limit = rateLimit(`portfolio-holdings-ip:${clientIp(request)}`, { limit: 20, windowMs: 10 * 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);

  const user = await userFromAccessToken(bearerToken(request)).catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "Sign in again to connect a broker." }, { status: 401, headers: NO_STORE });
  }
  const session = readBrokerSession(request);
  if (!session) {
    return NextResponse.json({ error: "Start the connection again." }, { status: 409, headers: NO_STORE });
  }

  let response: NextResponse;
  try {
    const holdings = await brokerHoldings(session);
    response = NextResponse.json({ holdings }, { headers: NO_STORE });
  } catch (error) {
    console.error("[portfolio broker holdings]", error instanceof Error ? error.message : "unknown error");
    response = NextResponse.json(
      { error: "We couldn't read your broker holdings. Try again or use a CSV." },
      { status: 502, headers: NO_STORE },
    );
  }
  await endBrokerConnection(session);
  writeBrokerSession(response, request, null);
  return response;
}
