import { yahooQuotes, type YahooQuote } from "./desk/tools/yahoo";
import { TtlCache } from "./desk/tools/util";
import { getLatest } from "./prices-api";
import type { Quote } from "./portfolio-holdings";

/**
 * Live prices for the stored portfolio (server only), from the free sources
 * the app already uses:
 *   stocks, ETFs, funds, ADRs  Yahoo Finance v7 quote (lib/desk/tools/yahoo.ts),
 *                              else Falcon's last stored daily close
 *                              (public.prices_daily, lib/prices-api.ts), marked "close"
 *   options                    Yahoo quote by OCC symbol (e.g. NVDA261218C00150000)
 *   crypto                     Yahoo quote as BTC-USD
 *   futures, others            none: the import price, labelled as such by the caller
 * Held 30 s per symbol on this server instance (misses too), one request per
 * 50 symbols with a 5 s timeout. Never invents a price: a symbol Yahoo does
 * not answer simply has no quote.
 */

const FRESH_MS = 30_000;
const CHUNK = 50;
const TIMEOUT_MS = 5_000;
const MAX_CLOSE_FALLBACKS = 40;

const cache = new TtlCache<Quote | null>(FRESH_MS, 2_000);

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Pure: Yahoo's v7 row as a quote; null without a price. */
export function quoteFromYahoo(row: YahooQuote): Quote | null {
  const price = num(row.regularMarketPrice);
  if (price === null || price < 0) return null;
  const time = num(row.regularMarketTime);
  return {
    price,
    change: num(row.regularMarketChange),
    changePct: num(row.regularMarketChangePercent),
    currency: typeof row.currency === "string" ? row.currency.toUpperCase() : null,
    at: time === null ? null : time * 1000,
    source: "live",
    marketCap: num(row.marketCap),
    volume: num(row.regularMarketVolume),
    name: typeof row.longName === "string" && row.longName ? row.longName : typeof row.shortName === "string" && row.shortName ? row.shortName : null,
  };
}

async function yahooChunk(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const rows = await yahooQuotes(symbols, AbortSignal.timeout(TIMEOUT_MS));
  for (const row of rows) {
    const sym = String(row.symbol ?? "").toUpperCase();
    const q = quoteFromYahoo(row);
    if (sym && q) out.set(sym, q);
  }
  return out;
}

/** The stored close for a stock-like symbol (BRK-B style), split-adjusted; null when none. */
async function storedClose(symbol: string): Promise<Quote | null> {
  try {
    const l = await getLatest(symbol);
    if (l.close === null || !l.date) return null;
    return { price: l.close, change: l.change, changePct: l.changePct, currency: "USD", at: Date.parse(`${l.date}T21:00:00Z`), source: "close" };
  } catch {
    return null;
  }
}

/**
 * Quotes for the given quote symbols (lib/portfolio-holdings.ts quoteSymbol).
 * `closeFallback` lists the symbols (stock-like) that may fall back to the
 * stored daily close when Yahoo has nothing. Never throws.
 */
export async function liveQuotes(symbols: readonly string[], closeFallback: ReadonlySet<string> = new Set()): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = {};
  const want = Array.from(new Set(symbols.map((s) => s.toUpperCase()))).filter((s) => /^[A-Z0-9^][A-Z0-9.^=-]{0,31}$/.test(s));
  const missing: string[] = [];
  for (const s of want) {
    const hit = cache.get(s);
    if (hit === undefined) missing.push(s);
    else if (hit) out[s] = hit;
  }
  const chunks: string[][] = [];
  for (let i = 0; i < missing.length; i += CHUNK) chunks.push(missing.slice(i, i + CHUNK));
  const results = await Promise.all(
    chunks.map((c) =>
      yahooChunk(c).catch((error: unknown) => {
        console.error("[portfolio prices] Yahoo quote failed", error instanceof Error ? error.name : "unknown");
        return null;
      }),
    ),
  );
  const unanswered: string[] = [];
  chunks.forEach((c, i) => {
    const got = results[i];
    for (const s of c) {
      const q = got?.get(s) ?? null;
      // A failed request is not cached, so the next poll tries again; a symbol Yahoo did not know is.
      if (got) cache.set(s, q);
      if (q) out[s] = q;
      else if (closeFallback.has(s)) unanswered.push(s);
    }
  });
  const closes = await Promise.all(unanswered.slice(0, MAX_CLOSE_FALLBACKS).map(async (s) => [s, await storedClose(s)] as const));
  for (const [s, q] of closes) if (q) out[s] = q;
  return out;
}
