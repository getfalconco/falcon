import {
  sectorsFromCalendar,
  selectFirstReading,
  untrackedTickers,
  type ReadingEarnings,
  type ReadingFact,
} from "../../shared/first-reading";
import { catalogMatch } from "../../shared/onboarding-tickers";
import type { StockCatalogEntry } from "../../shared/stock-catalog";
import type { SectorId } from "../../shared/user-preferences";
import { isEtfTicker } from "@/lib/etf-tickers";

/**
 * What the closing screen of setup reads, gathered from data the app already
 * holds: the relationship graph built from filings on disk, the corporate
 * calendar's earnings dates, and the Tracker's list of names it has history
 * for. Every source has the same short budget and is optional: a slow or
 * missing one leaves its facts out, never the screen waiting.
 */

/** How long the closing screen waits on any one source. */
export const READING_BUDGET_MS = 2500;

export type FirstReading = {
  facts: ReadingFact[];
  /** Names the Tracker has no history for yet and was asked to fetch. */
  started: string[];
  /** Names the Tracker has no history for and could not be asked about. */
  notTracked: string[];
  /** The sectors the reader's names sit in, for the sector preference setup no longer asks for. */
  sectors: SectorId[];
};

function withBudget<T>(work: Promise<T> | undefined, ms: number): Promise<T | null> {
  if (!work) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), ms);
    work.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** Today in New York, YYYY-MM-DD: earnings dates are New York dates. */
export function newYorkToday(now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Whether a typed ticker is a listed stock or fund. The symbol directory
 * leaves funds out on purpose, so a fund on the app's own fund list counts
 * too. A search matches substrings and returns the first matches in symbol
 * order, so a short symbol ("F") can sit past a small page: a miss on the
 * first page asks once more for the whole list.
 */
export async function lookupTicker(ticker: string): Promise<StockCatalogEntry | null> {
  if (isEtfTicker(ticker)) return { symbol: ticker, companyName: ticker };
  const search = window.meridian?.searchStockSymbols;
  if (!search) throw new Error("catalog unavailable");
  const first = catalogMatch(ticker, await search(ticker, 50));
  if (first) return first;
  return catalogMatch(ticker, await search(ticker, 20_000));
}

/**
 * Asks the app to cover these names: the same request the dashboard makes for
 * held paper positions (lib/portfolio-coverage), which adds a name to the
 * Tracker with a year of history and reads its annual filing for the graph.
 * Resolves to whether the request was taken.
 */
export async function requestCoverage(tickers: readonly string[]): Promise<boolean> {
  const sync = window.meridian?.syncPortfolioHoldings;
  if (!sync || tickers.length === 0) return false;
  try {
    const result = await sync([...tickers]);
    return result.ok === true;
  } catch {
    return false;
  }
}

/** The first reading for these names. `coverageRequested` says whether `requestCoverage` was taken. */
export async function readFirstReading(
  tickers: readonly string[],
  coverageRequested: boolean,
  budgetMs = READING_BUDGET_MS,
): Promise<FirstReading> {
  if (tickers.length === 0) return { facts: [], started: [], notTracked: [], sectors: [] };
  const bridge = window.meridian;
  const [graph, calendar, tracker] = await Promise.all([
    withBudget(bridge?.getGraphData?.(), budgetMs),
    withBudget(bridge?.getCalendarCorporate?.({ symbols: [...tickers] }), budgetMs),
    withBudget(bridge?.getTrackerStatus?.(), budgetMs),
  ]);

  const edges = graph && graph.ok ? graph.graph.edges : [];
  const earnings: ReadingEarnings[] =
    calendar && calendar.ok
      ? calendar.events
          .filter((e) => e.kind === "earnings")
          .map((e) => ({ ticker: e.ticker, date: e.date, estimated: e.estimated }))
      : [];
  const facts = selectFirstReading({ tickers, edges, earnings, today: newYorkToday() });

  // Only a Tracker that answered can say what it lacks; with no answer the
  // screen says nothing about history rather than guessing.
  let missing: string[] = [];
  if (tracker && tracker.ok) {
    const ready = tracker.status.tickers.filter((t) => t.backfilled).map((t) => t.ticker);
    missing = untrackedTickers(tickers, ready);
  }
  const sectors = calendar && calendar.ok ? sectorsFromCalendar(calendar.sectors) : [];
  return coverageRequested
    ? { facts, started: missing, notTracked: [], sectors }
    : { facts, started: [], notTracked: missing, sectors };
}
