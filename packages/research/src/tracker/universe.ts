/**
 * Tracked universe discovery (§1: "dynamic ticker list = watchlist ∪
 * seeded/cached tickers").
 *
 * Reads the tickers already cached on disk rather than hard-coding a list, so
 * the engine tracks whatever the rest of the app has pulled data for. Sources:
 *   data/backtest/candles/<T>.json   price cache
 *   data/backtest/edgar/<T>.json     filing cache
 *   data/cache/<T>.<accession>.txt   step1 filing text cache
 */

import fs from "node:fs";
import path from "node:path";

/** Plausible US-listed ticker: 1–5 letters, optional .A/.B class suffix. */
const TICKER_RE = /^[A-Z]{1,5}(\.[A-Z])?$/;

function readDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function collectFromJsonDir(dir: string, into: Set<string>): void {
  for (const entry of readDirSafe(dir)) {
    if (!entry.endsWith(".json")) continue;
    const symbol = entry.slice(0, -".json".length).toUpperCase();
    if (TICKER_RE.test(symbol)) into.add(symbol);
  }
}

/** Step1 cache files are named "<TICKER>.<accession>.<kind>". */
function collectFromStep1Cache(dir: string, into: Set<string>): void {
  for (const entry of readDirSafe(dir)) {
    const symbol = entry.split(".")[0]?.toUpperCase() ?? "";
    if (TICKER_RE.test(symbol)) into.add(symbol);
  }
}

export type UniverseDiscovery = {
  tickers: string[];
  /** Per-source counts, for reporting what the universe was built from. */
  sources: Record<string, number>;
};

/**
 * Every ticker with cached data under the desktop data dir, excluding the
 * benchmark (tracked separately as the regression reference, not as a subject).
 */
export function discoverCachedTickers(
  desktopDataDir: string,
  options?: { exclude?: string[] },
): UniverseDiscovery {
  const exclude = new Set((options?.exclude ?? ["SPY"]).map((s) => s.toUpperCase()));

  const candles = new Set<string>();
  collectFromJsonDir(path.join(desktopDataDir, "backtest", "candles"), candles);

  const edgar = new Set<string>();
  collectFromJsonDir(path.join(desktopDataDir, "backtest", "edgar"), edgar);

  const step1 = new Set<string>();
  collectFromStep1Cache(path.join(desktopDataDir, "cache"), step1);

  // Once tracked, stays tracked: the tracker's own persisted state is a source
  // too, so a ticker survives another subsystem clearing its cache. On
  // 2026-08-22 the backtest candle/edgar caches were emptied and the universe
  // silently shrank 42 → 28 even though all 42 state files were still there.
  // Removal is an explicit act (removeTicker deletes the state file), never
  // a side effect of someone else's cleanup.
  const tracked = new Set<string>();
  collectFromJsonDir(path.join(desktopDataDir, "tracker", "state"), tracked);

  const all = new Set<string>([...candles, ...edgar, ...step1, ...tracked]);
  for (const symbol of exclude) all.delete(symbol);

  return {
    tickers: [...all].sort(),
    sources: {
      candles: candles.size,
      edgar: edgar.size,
      step1: step1.size,
      tracked: tracked.size,
    },
  };
}
