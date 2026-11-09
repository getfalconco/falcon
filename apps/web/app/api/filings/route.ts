import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { recentFilings } from "@/lib/sec";
import { TICKER_PATTERN } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

/**
 * Real SEC filings from the last 24 hours for up to 30 tickers, for the
 * welcome flow's result screen. Public data only; nothing is invented.
 *
 *   GET /api/filings?tickers=AAPL,MSFT
 *   200 { ok: true, count, items: [{ ticker, form, label, filedAt }] }
 *   502 { ok: false }  SEC unreachable
 */
export async function GET(request: Request) {
  const limit = rateLimit(`filings:${clientIp(request)}`, { limit: 12, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);

  const tickers = (new URL(request.url).searchParams.get("tickers") ?? "")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => TICKER_PATTERN.test(t))
    .slice(0, 30);

  try {
    const items = await recentFilings(tickers);
    return NextResponse.json(
      { ok: true, count: items.length, items: items.slice(0, 20) },
      { headers: { "Cache-Control": "private, max-age=120" } },
    );
  } catch (error) {
    console.error("[api/filings GET]", error);
    return NextResponse.json({ ok: false }, { status: 502 });
  }
}
