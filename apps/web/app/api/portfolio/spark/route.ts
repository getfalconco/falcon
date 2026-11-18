import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { sparkSymbols, sparksFor } from "@/lib/portfolio-spark";

export const dynamic = "force-dynamic";

/**
 * The Dashboard's "Last 7 Days" lines (lib/portfolio-spark.ts):
 *
 *   GET /api/portfolio/spark?symbols=AAPL,BRK-B,BTC-USD  ->  200 { spark: { SYMBOL: number[] }, at }
 *
 * Hourly closes over the last 7 calendar days per quote symbol, fetched on
 * this server (never from the browser) and held 10 minutes per symbol. A
 * symbol without data is left out. Market data per symbol, no sizes, so no
 * auth, like /api/market; the answer is private to the browser because the
 * symbol list is the member's.
 */

export async function GET(request: Request) {
  const limit = rateLimit(`portfolio-spark:${clientIp(request)}`, { limit: 30, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);
  const symbols = sparkSymbols(new URL(request.url).searchParams.get("symbols"));
  const spark = symbols.length ? await sparksFor(symbols) : {};
  return NextResponse.json({ spark, at: Date.now() }, { headers: { "Cache-Control": "private, max-age=300" } });
}
