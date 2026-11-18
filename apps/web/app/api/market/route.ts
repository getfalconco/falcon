import { NextResponse } from "next/server";
import { yahooQuotes } from "@/lib/desk/tools/yahoo";
import { MARKET_SOURCE, STRIP_KEYS, YAHOO_SYMBOL, stripQuoteFromYahoo, type MarketStripData, type StripKey, type StripQuote } from "@/lib/workspace/market-strip";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * The Dashboard's market strip (lib/workspace/market-strip.ts):
 *
 *   GET /api/market  ->  200 MarketStripData (SPY, QQQ, ^VIX, ^TNX: regular, pre- and post-market legs)
 *
 * One Yahoo v7 quote request for all four, held in memory for 15 s per
 * server instance so many open tabs share it, with a 5 s timeout. When Yahoo
 * fails the last good answer (up to 10 min old) comes back marked `stale`;
 * with none, 503 and an empty set. No auth, like /api/prices: market data
 * display licensing (and Yahoo's terms) are deferred until launch.
 */

const FRESH_MS = 15_000;
const STALE_MAX_MS = 10 * 60_000;
const TIMEOUT_MS = 5_000;

let last: { data: MarketStripData; at: number } | null = null;
let loading: Promise<MarketStripData> | null = null;

async function load(): Promise<MarketStripData> {
  const rows = await yahooQuotes(STRIP_KEYS.map((k) => YAHOO_SYMBOL[k]), AbortSignal.timeout(TIMEOUT_MS));
  const quotes = {} as Record<StripKey, StripQuote | null>;
  for (const k of STRIP_KEYS) {
    const row = rows.find((r) => String(r.symbol).toUpperCase() === YAHOO_SYMBOL[k]);
    quotes[k] = row ? stripQuoteFromYahoo(k, row) : null;
  }
  return { at: Date.now(), quotes, source: MARKET_SOURCE };
}

function emptyData(error: string): MarketStripData {
  return { at: Date.now(), quotes: { SPY: null, QQQ: null, VIX: null, TNX: null }, source: MARKET_SOURCE, error };
}

export async function GET(request: Request) {
  const limit = rateLimit(`market:${clientIp(request)}`, { limit: 60, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);

  const now = Date.now();
  if (last && now - last.at < FRESH_MS) return reply(last.data, 200);

  loading ??= load().finally(() => {
    loading = null;
  });
  try {
    const data = await loading;
    last = { data, at: Date.now() };
    return reply(data, 200);
  } catch (error) {
    console.error("[api/market] Yahoo quote failed", error instanceof Error ? error.message : error);
    if (last && now - last.at < STALE_MAX_MS) return reply({ ...last.data, stale: true }, 200);
    return reply(emptyData("Market data is unavailable right now."), 503);
  }
}

function reply(body: MarketStripData, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": status === 200 && !body.stale ? "public, max-age=5, s-maxage=15" : "no-store" },
  });
}
