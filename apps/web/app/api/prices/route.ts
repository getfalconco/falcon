import { NextResponse } from "next/server";
import { emptyHistory, emptyLatest, getHistory, getLatest, isPriceRange, normalizeTicker, type PriceHistory, type PriceLatest } from "@/lib/prices-api";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Daily stock prices for the universe (shapes, units and adjustment:
 * lib/prices-api.ts).
 *
 *   GET /api/prices?ticker=AAPL&range=1m|3m|6m|1y|5y|max  ->  200 PriceHistory (split-adjusted OHLCV, oldest first)
 *   GET /api/prices?ticker=AAPL&latest=1                  ->  200 PriceLatest  (last close, change, volume, date)
 *
 * Reads public.prices_daily / public.prices_splits (written once a trading
 * day by the prices step of .github/workflows/options-daily.yml, Databento
 * EQUS.SUMMARY) with the service role. No auth: market data display
 * licensing is deferred until launch, as for /api/options. The data changes
 * once a day: 10 minutes in the browser and at the CDN.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const CACHE_OK = "public, max-age=600, s-maxage=600, stale-while-revalidate=3600";
const CACHE_EMPTY = "public, max-age=0, s-maxage=60";

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  const limit = rateLimit(`prices:${clientIp(request)}`, { limit: 240, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter, CORS);

  const params = new URL(request.url).searchParams;
  const ticker = normalizeTicker(params.get("ticker"));
  if (!ticker) return NextResponse.json({ error: "Use ?ticker=SYMBOL&range=1m|3m|6m|1y|5y|max or ?ticker=SYMBOL&latest=1" }, { status: 400, headers: CORS });
  const latest = params.get("latest") === "1" || params.get("latest") === "true";
  const rawRange = params.get("range") ?? "1y";
  if (!latest && !isPriceRange(rawRange)) return NextResponse.json({ error: "Bad range: use 1m, 3m, 6m, 1y, 5y or max" }, { status: 400, headers: CORS });
  const range = isPriceRange(rawRange) ? rawRange : "1y";

  let body: PriceHistory | PriceLatest;
  let ok = false;
  try {
    if (latest) {
      body = await getLatest(ticker);
      ok = body.date !== null;
    } else {
      body = await getHistory(ticker, range);
      ok = body.count > 0;
    }
  } catch (error) {
    console.error("[api/prices] supabase read failed", error);
    body = latest ? emptyLatest(ticker) : emptyHistory(ticker, range);
  }

  return NextResponse.json(body, {
    headers: {
      ...CORS,
      "Cache-Control": ok ? CACHE_OK : CACHE_EMPTY,
      "Netlify-Vary": "query=ticker|range|latest",
    },
  });
}
