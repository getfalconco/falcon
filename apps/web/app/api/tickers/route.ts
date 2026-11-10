import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { companyNames, searchTickers } from "@/lib/sec";
import { MAX_STOCKS, TICKER_PATTERN } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

/**
 * Ticker lookups for the welcome flow, from the SEC's public ticker list
 * (cached server-side, see lib/sec.ts).
 *
 *   GET /api/tickers?q=app             ->  200 { results: [{ ticker, name }] }
 *   GET /api/tickers?symbols=AAPL,MSFT ->  200 { names: { AAPL: "Apple Inc.", ... } }
 */
export async function GET(request: Request) {
  const limit = rateLimit(`tickers:${clientIp(request)}`, { limit: 90, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);

  const params = new URL(request.url).searchParams;
  const symbols = params.get("symbols");
  if (symbols !== null) {
    const wanted = symbols
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => TICKER_PATTERN.test(s))
      .slice(0, MAX_STOCKS);
    try {
      const names = Object.fromEntries(await companyNames(wanted));
      return NextResponse.json({ names }, { headers: { "Cache-Control": "public, max-age=300" } });
    } catch (error) {
      console.error("[api/tickers GET symbols]", error);
      return NextResponse.json({ names: {} }, { status: 502 });
    }
  }

  const q = (params.get("q") ?? "").slice(0, 40);
  try {
    const results = await searchTickers(q);
    return NextResponse.json({ results }, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (error) {
    console.error("[api/tickers GET]", error);
    return NextResponse.json({ results: [], error: "Search is unavailable right now." }, { status: 502 });
  }
}
