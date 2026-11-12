/**
 * Market data for the history of past events (src/history.ts): adjusted
 * daily closes and the EPS record of past quarters.
 *
 * The engine does not fetch prices itself. It reads them through this
 * interface from the backtester's data layer (packages/backtest/src/data:
 * Yahoo Finance chart and earnings calendar, polite client, on-disk cache),
 * loaded at run time by path. Not a workspace dependency yet: tsc's NodeNext
 * settings here do not accept that package's extensionless imports, and the
 * daily Sightings job installs the engine alone. When the packages merge,
 * this becomes a plain import of "@falcon/backtest/data"; nothing else
 * changes. A licensed source (Massive) only has to satisfy `MarketData`.
 *
 * When the data layer cannot be loaded the engine still runs: every hit's
 * history stays null and the run says why.
 */

import path from "node:path";
import { ENGINE_ROOT } from "./http.ts";

/** One trading day's close, split and dividend adjusted. `date` is the exchange's YYYY-MM-DD. */
export type DailyClose = { date: string; close: number };

/** One reported quarter as the EPS record has it. */
export type ReportedQuarter = {
  /** New York calendar date of the release, YYYY-MM-DD. */
  date: string;
  time: "before_open" | "during" | "after_close" | "unknown";
  /** (actual - estimate) / |estimate| * 100; null without both. */
  surprisePct: number | null;
};

export interface MarketData {
  readonly name: string;
  /** Adjusted daily closes covering [from, to], oldest first; empty for a ticker the source does not have. */
  dailyCloses(ticker: string, from: string, to: string): Promise<DailyClose[]>;
  /** Reported quarters with a release date in [from, to], oldest first. */
  earnings(ticker: string, from: string, to: string): Promise<ReportedQuarter[]>;
}

/** The parts of packages/backtest/src/data this file uses. */
type BacktestYahoo = {
  YahooPriceSource: new (cache: unknown) => { name: string; dailyBars(t: string, from: string, to: string): Promise<Array<{ date: string; close: number }>> };
  YahooEarningsSource: new (cache: unknown) => {
    name: string;
    earnings(t: string, from: string, to: string): Promise<Array<{ date: string; time: ReportedQuarter["time"]; surprisePct: number | null }>>;
  };
};
type BacktestCache = { JsonCache: new (dir: string | null) => unknown };

/** Where the backtester's data layer sits, relative to this file (packages/engine/src). */
const BACKTEST_DATA = new URL("../../backtest/src/data/", import.meta.url);

export const MARKET_CACHE_DIR = path.join(ENGINE_ROOT, ".cache", "market");

/**
 * The backtester's Yahoo sources behind `MarketData`, caching under
 * packages/engine/.cache/market. Resolves to an error message instead when
 * the data layer is not there or does not load.
 */
export async function backtestMarketData(cacheDir: string = MARKET_CACHE_DIR): Promise<{ market: MarketData } | { error: string }> {
  let yahoo: BacktestYahoo;
  let cacheMod: BacktestCache;
  try {
    // Non-literal specifiers: loaded at run time only (see the note at the top).
    const yahooUrl = new URL("yahoo.ts", BACKTEST_DATA).href;
    const cacheUrl = new URL("cache.ts", BACKTEST_DATA).href;
    yahoo = (await import(yahooUrl)) as BacktestYahoo;
    cacheMod = (await import(cacheUrl)) as BacktestCache;
    if (typeof yahoo.YahooPriceSource !== "function" || typeof yahoo.YahooEarningsSource !== "function" || typeof cacheMod.JsonCache !== "function") {
      return { error: "packages/backtest/src/data does not export the Yahoo sources this engine expects" };
    }
  } catch (err) {
    return { error: `packages/backtest/src/data could not be loaded (${err instanceof Error ? err.message.split("\n")[0] : String(err)})` };
  }
  const cache = new cacheMod.JsonCache(cacheDir);
  const prices = new yahoo.YahooPriceSource(cache);
  const eps = new yahoo.YahooEarningsSource(cache);
  return {
    market: {
      name: `${prices.name}; ${eps.name}`,
      async dailyCloses(ticker, from, to) {
        const bars = await prices.dailyBars(ticker, from, to);
        return bars.map((b) => ({ date: b.date, close: b.close }));
      },
      async earnings(ticker, from, to) {
        const rows = await eps.earnings(ticker, from, to);
        return rows.map((r) => ({ date: r.date, time: r.time, surprisePct: r.surprisePct }));
      },
    },
  };
}
