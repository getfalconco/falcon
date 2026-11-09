import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { searchTickers } from "@/lib/sec";

export const dynamic = "force-dynamic";

/**
 * Ticker autocomplete for the welcome flow's "Add your stocks" step, from the
 * SEC's public ticker list (cached server-side, see lib/sec.ts).
 *
 *   GET /api/tickers?q=app  ->  200 { results: [{ ticker, name }] }
 */
export async function GET(request: Request) {
  const limit = rateLimit(`tickers:${clientIp(request)}`, { limit: 90, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);

  const q = (new URL(request.url).searchParams.get("q") ?? "").slice(0, 40);
  try {
    const results = await searchTickers(q);
    return NextResponse.json({ results }, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (error) {
    console.error("[api/tickers GET]", error);
    return NextResponse.json({ results: [], error: "Search is unavailable right now." }, { status: 502 });
  }
}
