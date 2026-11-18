import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { bearerToken, userFromAccessToken } from "@/lib/waitlist-membership";
import { PAPER_MAX, PAPER_MIN, paperAccount } from "@/lib/paper-account";
import { StoreError, clearPaperAccount, savePaperAccount } from "@/lib/portfolio-store";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The signed-in member's paper account (lib/paper-account.ts): the account
 * "paper" in public.portfolio_accounts, a USD cash balance and no positions.
 * Who is asking comes only from the Supabase access token.
 *
 *   POST   /api/portfolio/paper { balance, name? } -> 200 { available, account }
 *   DELETE /api/portfolio/paper                    -> 200 { available }
 *
 *   `available: false` while the table is missing: nothing is stored, and the
 *   client keeps the account in memory for the page visit.
 *   400 bad balance, 401 not signed in, 429 rate limited, 502 database failed.
 */

export async function POST(request: Request) {
  const ipLimit = rateLimit(`portfolio-paper-ip:${clientIp(request)}`, { limit: 20, windowMs: 10 * 60_000 });
  if (!ipLimit.ok) return tooManyRequests(ipLimit.retryAfter);
  const user = await userFromAccessToken(bearerToken(request)).catch(() => null);
  if (!user) return NextResponse.json({ error: "Sign in again to create a paper account." }, { status: 401, headers: NO_STORE });
  const userLimit = rateLimit(`portfolio-paper-user:${user.id}`, { limit: 10, windowMs: 10 * 60_000 });
  if (!userLimit.ok) return tooManyRequests(userLimit.retryAfter);

  const raw = await request.text().catch(() => "");
  if (raw.length > 2_000) return NextResponse.json({ error: "Invalid body." }, { status: 400, headers: NO_STORE });
  let body: { balance?: unknown; name?: unknown } = {};
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "Send { balance }." }, { status: 400, headers: NO_STORE });
  }
  const balance = typeof body.balance === "number" ? body.balance : NaN;
  const account = paperAccount(balance, typeof body.name === "string" ? body.name : null);
  if (!account) {
    return NextResponse.json(
      { error: `The starting balance is between $${PAPER_MIN.toLocaleString("en-US")} and $${PAPER_MAX.toLocaleString("en-US")}.` },
      { status: 400, headers: NO_STORE },
    );
  }
  try {
    const saved = await savePaperAccount(user.id, account);
    return NextResponse.json({ available: saved.available, account }, { headers: NO_STORE });
  } catch (error) {
    console.error("[api/portfolio/paper POST]", error instanceof StoreError ? error.code : "unknown");
    return NextResponse.json({ error: "Your paper account couldn't be created." }, { status: 502, headers: NO_STORE });
  }
}

export async function DELETE(request: Request) {
  const ipLimit = rateLimit(`portfolio-paper-ip:${clientIp(request)}`, { limit: 20, windowMs: 10 * 60_000 });
  if (!ipLimit.ok) return tooManyRequests(ipLimit.retryAfter);
  const user = await userFromAccessToken(bearerToken(request)).catch(() => null);
  if (!user) return NextResponse.json({ error: "Sign in again." }, { status: 401, headers: NO_STORE });
  try {
    return NextResponse.json(await clearPaperAccount(user.id), { headers: NO_STORE });
  } catch (error) {
    console.error("[api/portfolio/paper DELETE]", error instanceof StoreError ? error.code : "unknown");
    return NextResponse.json({ error: "Your paper account couldn't be removed." }, { status: 502, headers: NO_STORE });
  }
}
