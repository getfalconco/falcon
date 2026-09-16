/**
 * Five-year series backfill (§4) — the hard data prerequisite.
 *
 * Tracker keeps a rolling ~260 sessions and REPLACES the array wholesale every
 * close, so history never accumulates there and raising its lookback would
 * change every other engine's windows. Quant Lab therefore keeps its own
 * store, fetched once, and reads Tracker read-only.
 *
 * Bars come from `fetchAdjustedDailyBars` — the same adjusted source the
 * Tracker uses (closes are Yahoo adjclose, O/H/L scaled by the same factor,
 * volume split-adjusted at source). Adjusted prices are mandatory for both
 * entry and exit (§6): a 10-for-1 split on raw closes reads as a 90% loss.
 *
 * Note on adjustment: adjclose is back-adjusted as of today, so a dividend paid
 * after session T shifts T's printed level. Returns stay internally consistent,
 * which is what a backtest measures, but the absolute prices are not what the
 * tape showed that day. This is standard practice and it is why the report
 * never quotes a historical price as if it were a quote.
 */

import { fetchAdjustedDailyBars } from "../tracker/sources.js";
import type { DailyBar } from "../tracker/types.js";
import type { ScreenWindows } from "../screen/config.js";
import { TradingCalendar } from "./calendar.js";
import { buildQuantSeries, detectGaps } from "./series.js";
import type { SeriesStore } from "./store.js";
import type { SeriesGap } from "./types.js";

export type BackfillOutcome = {
  ticker: string;
  status: "ok" | "empty" | "error";
  sessions: number;
  from: string | null;
  to: string | null;
  gaps: SeriesGap[];
  error?: string;
};

export type BackfillSummary = {
  benchmark: string;
  benchmarkSessions: number;
  outcomes: BackfillOutcome[];
  startedAt: string;
  finishedAt: string;
};

export type BackfillDeps = {
  store: SeriesStore;
  windows: ScreenWindows;
  benchmark: string;
  years: number;
  fetchSpacingMs: number;
  /** Injected so tests never touch the network. */
  fetchBars?: (symbol: string, lookbackCalendarDays: number) => Promise<DailyBar[]>;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (done: number, total: number, ticker: string) => void;
  now?: () => string;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function defaultFetch(symbol: string, lookbackCalendarDays: number): Promise<DailyBar[]> {
  const result = await fetchAdjustedDailyBars(symbol, lookbackCalendarDays);
  return result.bars;
}

/**
 * Fetches the benchmark plus every ticker and persists a point-in-time series
 * for each. The benchmark is fetched first because it supplies both the
 * regression input and the trading calendar.
 */
export async function runBackfill(tickers: string[], deps: BackfillDeps): Promise<BackfillSummary> {
  const nowIso = deps.now ?? (() => new Date().toISOString());
  const startedAt = nowIso();
  const fetchBars = deps.fetchBars ?? defaultFetch;
  const sleep = deps.sleep ?? defaultSleep;
  // A calendar year is ~365.25 days; the extra margin covers the warm-up that
  // the longest window (252-session 52-week context) consumes before the
  // earliest usable session.
  const lookbackDays = Math.ceil(deps.years * 365.25) + 30;

  const benchBars = await fetchBars(deps.benchmark, lookbackDays);
  const calendar = TradingCalendar.fromBars(benchBars);

  const outcomes: BackfillOutcome[] = [];
  // The benchmark is a series in its own right: market-adjusted returns read it
  // back out of the store rather than re-fetching.
  outcomes.push(persist(deps, benchBars, benchBars, deps.benchmark, calendar));

  const targets = tickers.filter((t) => t.toUpperCase() !== deps.benchmark.toUpperCase());
  let done = 0;
  for (const ticker of targets) {
    if (deps.fetchSpacingMs > 0) await sleep(deps.fetchSpacingMs);
    try {
      const bars = await fetchBars(ticker, lookbackDays);
      outcomes.push(persist(deps, bars, benchBars, ticker, calendar));
    } catch (err) {
      outcomes.push({
        ticker: ticker.toUpperCase(),
        status: "error",
        sessions: 0,
        from: null,
        to: null,
        gaps: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
    done++;
    deps.onProgress?.(done, targets.length, ticker);
  }

  return {
    benchmark: deps.benchmark.toUpperCase(),
    benchmarkSessions: calendar.length,
    outcomes,
    startedAt,
    finishedAt: nowIso(),
  };
}

function persist(
  deps: BackfillDeps,
  bars: DailyBar[],
  benchBars: DailyBar[],
  ticker: string,
  calendar: TradingCalendar,
): BackfillOutcome {
  const upper = ticker.toUpperCase();
  if (bars.length === 0) {
    return { ticker: upper, status: "empty", sessions: 0, from: null, to: null, gaps: [] };
  }
  const series = buildQuantSeries({ ticker: upper, bars, benchBars, windows: deps.windows });
  deps.store.save(series);
  const snaps = series.snapshots;
  return {
    ticker: upper,
    status: snaps.length > 0 ? "ok" : "empty",
    sessions: snaps.length,
    from: snaps[0]?.d ?? null,
    to: snaps[snaps.length - 1]?.d ?? null,
    gaps: detectGaps(series, calendar.sessions()),
  };
}
