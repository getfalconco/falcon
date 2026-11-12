import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { bearerToken, userFromAccessToken } from "@/lib/waitlist-membership";
import { brokerHoldings, readBrokerTicket, revokeBrokerGrant } from "@/lib/portfolio-server";
import { readBrokerCookie, writeBrokerCookie } from "../session";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Reads the holdings from the member's SnapTrade accounts with the ticket the
 * done page handed back (body, or this host's cookie), then revokes the
 * SnapTrade grant and clears the cookie: nothing stays linked.
 *
 *   POST /api/portfolio/broker/holdings { ticket? } -> 200 { holdings }
 *   401 not signed in, 409 no connection in progress, 502 SnapTrade failed
 */
export async function POST(request: Request) {
  const limit = rateLimit(`portfolio-holdings-ip:${clientIp(request)}`, { limit: 20, windowMs: 10 * 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);

  const user = await userFromAccessToken(bearerToken(request)).catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "Sign in again to connect a broker." }, { status: 401, headers: NO_STORE });
  }
  let bodyTicket: unknown;
  try {
    bodyTicket = ((await request.json()) as { ticket?: unknown }).ticket;
  } catch {
    bodyTicket = undefined;
  }
  const grant =
    readBrokerTicket(typeof bodyTicket === "string" ? bodyTicket : null, user.id) ??
    readBrokerTicket(readBrokerCookie(request), user.id);
  if (!grant) {
    const response = NextResponse.json({ error: "Start the connection again." }, { status: 409, headers: NO_STORE });
    writeBrokerCookie(response, request, null);
    return response;
  }

  let response: NextResponse;
  try {
    const holdings = await brokerHoldings(grant);
    response = NextResponse.json({ holdings }, { headers: NO_STORE });
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    console.error("[portfolio broker holdings]", status ?? (error instanceof Error ? error.name : "unknown error"));
    response = NextResponse.json(
      { error: "We couldn't read your broker holdings. Try again or use a CSV." },
      { status: 502, headers: NO_STORE },
    );
  }
  await revokeBrokerGrant(grant);
  writeBrokerCookie(response, request, null);
  return response;
}
