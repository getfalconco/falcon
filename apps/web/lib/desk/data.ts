/**
 * Daily bars for Desk strategy tests (the `load_prices` tool). Server-only.
 *
 * `getDailyBars` is the one seam to the price source. A window starting on or
 * after 2024-07-01 reads Databento's split-adjusted daily bars (Supabase
 * prices_daily, price return); an earlier window, or a Databento store that
 * lacks the benchmark or most of the tickers, falls back to Yahoo's split-
 * and dividend-adjusted bars through the backtester's Yahoo source (packages/
 * backtest/src/data). One request never mixes the two sources: a window that
 * starts before 2024-07-01 reads Yahoo for all of it (one request per ticker
 * covers the whole span, so a long window is no slower than a short one).
 *
 * Bulk loads (an event test over ~1,000 tickers since 2016): the Desk has its
 * own Yahoo client, 16 requests at a time (the backtester's shared one runs 6),
 * so a cold load of 1,000 tickers x 11 years takes about 20 s instead of 75 s.
 * Each ticker's history is cached (memory, then one file per ticker on disk:
 * the OS temp dir on Netlify, packages/backtest/.cache locally) for 12 hours,
 * keyed by ticker and covering everything from the earliest date asked for, so
 * a load cut short by the request deadline carries on in the next request
 * without fetching the finished tickers again.
 */

import { JsonCache, PoliteFetcher, YahooPriceSource, defaultCacheDir, type Bar } from "@falcon/backtest/data";
import { databentoBars, DATABENTO_LABEL } from "./tools/databento";
import { UNIVERSES, datedLabel, type UniverseBase } from "@falcon/backtest";

export type DailyBarsResult = {
  /** Bars per ticker, oldest first; tickers with no data are left out. Empty when a `sink` took them. */
  bars: Map<string, Bar[]>;
  /** Tickers with data (the keys of `bars`, or what went to the sink). */
  loaded: Set<string>;
  /** Tickers the source has no data for in the window. */
  missing: string[];
  /** Tickers not loaded because time ran out (call again: loaded ones are cached). */
  notLoaded: string[];
  source: string;
};

/** Tickers loaded so far of the total, while a load runs. */
export type LoadProgress = { loaded: number; total: number };

export type DailyBarsOptions = {
  onProgress?: (p: LoadProgress) => void;
  /**
   * Takes each ticker's bars as they arrive instead of keeping them in `bars` (a 1,000-ticker, 12-year load is
   * 2.7M bars: kept as objects that is most of a serverless function's memory).
   */
  sink?: (ticker: string, bars: Bar[]) => void;
};

/**
 * Adjusted daily bars for `tickers` dated from..to (inclusive). Stops at
 * `signal`; tickers still loading then come back in `notLoaded` instead of
 * failing the whole call.
 */
export async function getDailyBars(tickers: string[], from: string, to: string, signal?: AbortSignal, opts: DailyBarsOptions = {}): Promise<DailyBarsResult> {
  const db = from >= DATABENTO_FROM ? await databentoDailyBars(tickers, from, to, signal) : null;
  if (db) {
    if (opts.sink) {
      for (const [t, b] of db.bars) opts.sink(t, b);
      db.bars.clear();
    }
    return db;
  }
  return yahooDailyBars(tickers, from, to, signal, opts);
}

/** First day of the Databento store (EQUS.SUMMARY). */
export const DATABENTO_FROM = "2024-07-01";

async function databentoDailyBars(tickers: string[], from: string, to: string, signal?: AbortSignal): Promise<DailyBarsResult | null> {
  const bars = new Map<string, Bar[]>();
  const missing: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tickers.length && !signal?.aborted) {
      const t = tickers[next++]!;
      const d = await databentoBars(t, "max");
      const rows = d?.bars.filter((b) => b[0] >= from && b[0] <= to).map<Bar>((b) => ({ date: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] }));
      if (rows?.length) bars.set(t, rows);
      else missing.push(t);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  // Benchmark absent or too many tickers missing: let Yahoo answer the whole request.
  if (!bars.size || missing.length > tickers.length * 0.1 || (tickers.includes("SPY") && !bars.has("SPY"))) return null;
  return { bars, loaded: new Set(bars.keys()), missing: missing.sort(), notLoaded: [], source: `${DATABENTO_LABEL} (Databento EQUS.SUMMARY via Supabase), split-adjusted, price return (dividends not included)` };
}

/** The Desk's Yahoo client: 16 at a time, 10 ms between starts, 10 s per request, one retry on 429/5xx. */
export const DESK_YAHOO_CONCURRENCY = 16;
let deskYahoo: { dir: string; source: YahooPriceSource } | null = null;

/** Yahoo daily bars with the Desk's bulk client and the shared per-ticker cache (same files as the backtester's). */
export function deskYahooSource(dir = defaultCacheDir()): YahooPriceSource {
  if (deskYahoo?.dir !== dir) {
    const http = new PoliteFetcher({ concurrency: DESK_YAHOO_CONCURRENCY, minGapMs: 10, timeoutMs: 10_000, retries: 1 });
    deskYahoo = { dir, source: new YahooPriceSource(new JsonCache(dir), http) };
  }
  return deskYahoo.source;
}

/** Cache reads and parsing at once (network requests are bounded by the client). */
const READ_WORKERS = 24;

type PriceReader = { name: string; dailyBars: YahooPriceSource["dailyBars"] };

/**
 * Bars per ticker from Yahoo, a bounded number at a time. Tickers not reached
 * (or still loading) when `signal` aborts come back in `notLoaded`; whatever
 * finished is cached, so the same call again only fetches those.
 */
export async function yahooDailyBars(tickers: string[], from: string, to: string, signal?: AbortSignal, opts: DailyBarsOptions = {}, prices: PriceReader = deskYahooSource()): Promise<DailyBarsResult> {
  const { onProgress, sink } = opts;
  const bars = new Map<string, Bar[]>();
  const loaded = new Set<string>();
  const missing: string[] = [];
  const notLoaded: string[] = [];
  let next = 0;
  let done = 0;
  let reported = 0;
  const report = () => {
    if (!onProgress || (done - reported < 25 && done < tickers.length)) return;
    reported = done;
    onProgress({ loaded: done, total: tickers.length });
  };
  const worker = async () => {
    while (next < tickers.length) {
      const t = tickers[next++]!;
      if (signal?.aborted) {
        notLoaded.push(t);
        continue;
      }
      try {
        const b = await prices.dailyBars(t, from, to, signal);
        if (!b.length) missing.push(t);
        else {
          loaded.add(t);
          if (sink) sink(t, b);
          else bars.set(t, b);
        }
      } catch {
        if (signal?.aborted) {
          notLoaded.push(t);
          continue;
        }
        missing.push(t);
      }
      done++;
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_WORKERS, tickers.length) }, worker));
  return { bars, loaded, missing: missing.sort(), notLoaded: notLoaded.sort(), source: prices.name };
}

/** Named lists a test can use (today's membership; see packages/backtest/src/universes.ts). */
export const DESK_UNIVERSES = ["sp500_today", "us_large_caps", "falcon_universe", "falcon_graph", "falcon_semis", "sector_etfs"] as const satisfies readonly UniverseBase[];
export type DeskUniverse = (typeof DESK_UNIVERSES)[number];

export function universeTickers(name: DeskUniverse): { tickers: string[]; label: string; todaysPick: boolean; asOf: string | null } {
  const u = UNIVERSES[name];
  // Yahoo spells share classes with a dash (BRK-B).
  return { tickers: u.tickers.map((t) => t.replace(".", "-")), label: datedLabel(u), todaysPick: u.todaysPick, asOf: u.asOf };
}
