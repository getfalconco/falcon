import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { sparkSymbols } from "@/lib/portfolio-spark";
import { MAX_HISTORY_SYMBOLS, historyFor, isEquityRange } from "@/lib/portfolio-history";

export const dynamic = "force-dynamic";

/**
 * Price history for the Equity card (lib/portfolio-history.ts):
 *
 *   GET /api/portfolio/history?range=1M&symbols=AAPL,BRK-B,BTC-USD,SPY
 *     -> 200 { range, series: { SYMBOL: { t: epoch ms[], c: close[], prev?: the close before the range } }, at }
 *
 * Ranges 1D, 1W, 1M, 3M, YTD, 1Y, 5Y (the longest). Fetched on this server
 * (never from the browser) and cached per symbol and range. Market data per
 * symbol, no sizes, so no auth, like /api/portfolio/spark; private to the
 * browser because the symbol list is the member's. 400 for an unknown range.
 */

export async function GET(request: Request) {
  const limit = rateLimit(`portfolio-history:${clientIp(request)}`, { limit: 60, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);
  const params = new URL(request.url).searchParams;
  const range = params.get("range");
  if (!isEquityRange(range)) return NextResponse.json({ error: "Unknown range." }, { status: 400 });
  const symbols = sparkSymbols(params.get("symbols")).slice(0, MAX_HISTORY_SYMBOLS);
  const series = symbols.length ? await historyFor(symbols, range) : {};
  return NextResponse.json({ range, series, at: Date.now() }, { headers: { "Cache-Control": "private, max-age=60" } });
}
