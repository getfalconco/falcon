/**
 * Forward returns in three layers (§6).
 *
 * All three are reported, but sector-relative is the headline. Without it, a
 * rule that fires on every semiconductor during a semiconductor rally looks
 * brilliant — it captured the sector, not an edge. Market-adjusted removes the
 * index; only sector-relative removes the industry.
 *
 * Exposure is measured in sessions, identically for both entry conventions, so
 * the two are comparable:
 *
 *   signal_close  close(S)      → close(S + h)        h sessions
 *   next_open     open(S + 1)   → close(S + h)        h sessions
 *
 * The benchmark and every sector peer are measured over exactly the same
 * instants with the same convention, so an adjustment can never be an artifact
 * of comparing a close-to-close move against an open-to-close one.
 *
 * Sign is applied last, to all three layers: a short call that fell more than
 * its sector is a positive sector-relative return.
 */

import type { TradingCalendar } from "./calendar.js";
import { median } from "./stats.js";
import { snapshotAt } from "./series.js";
import type { EntryWhen, HorizonReturn, QuantSeries, QuantSnapshot } from "./types.js";

export type Window = {
  /** Session the rule fired on. */
  signal: string;
  /** Session exposure begins. */
  entry: string;
  /** Session exposure ends; null when the window runs off the end of history. */
  exit: string | null;
  when: EntryWhen;
};

/**
 * Resolves the exposure window for one hold horizon.
 *
 * Returns null when the window would extend past the data — an incomplete hold
 * is dropped, never truncated to whatever history happens to exist, because a
 * truncated winner and a truncated loser are not the same kind of missing.
 */
export function resolveWindow(
  calendar: TradingCalendar,
  signal: string,
  when: EntryWhen,
  holdSessions: number,
): Window | null {
  if (!calendar.has(signal)) return null;
  if (when === "signal_close") {
    return { signal, entry: signal, exit: calendar.shift(signal, holdSessions), when };
  }
  const entry = calendar.shift(signal, 1);
  if (!entry) return null;
  // Open of E through close of E + h − 1 is h sessions of exposure.
  return { signal, entry, exit: calendar.shift(entry, holdSessions - 1), when };
}

/** Entry price under the window's convention. */
export function entryPriceOf(snap: QuantSnapshot, when: EntryWhen): number {
  return when === "signal_close" ? snap.close : snap.open;
}

/**
 * Unsigned return of one series over a window, or null when either end is
 * missing (the ticker did not trade, or history stops short).
 */
export function windowReturn(series: QuantSeries, window: Window): number | null {
  if (!window.exit) return null;
  const entrySnap = snapshotAt(series, window.entry);
  const exitSnap = snapshotAt(series, window.exit);
  if (!entrySnap || !exitSnap) return null;
  const from = entryPriceOf(entrySnap, window.when);
  if (!(from > 0) || !(exitSnap.close > 0)) return null;
  return exitSnap.close / from - 1;
}

export type ReturnContext = {
  calendar: TradingCalendar;
  /** Every backfilled series, keyed by ticker. */
  seriesByTicker: Map<string, QuantSeries>;
  /** Benchmark ticker; its series must be present in `seriesByTicker`. */
  benchmark: string;
  /** Ticker → sector, from the classifier's company metadata. */
  sectorOf: Map<string, string>;
  /** Sector → member tickers (including the subject). */
  sectorMembers: Map<string, string[]>;
  /** Below this many PEERS the sector layer is not computed (§5). */
  minSectorPeers: number;
};

/**
 * Sector median return over a window, excluding the subject itself.
 *
 * Excluding the subject matters: with a five-member sector, leaving the ticker
 * in its own benchmark drags the median toward the very move being measured,
 * and in a one-member sector it would make every sector-relative return
 * exactly zero.
 */
export function sectorMedianReturn(
  ctx: ReturnContext,
  ticker: string,
  window: Window,
): { value: number | null; peers: number; sector: string | null } {
  const sector = ctx.sectorOf.get(ticker.toUpperCase()) ?? null;
  // "No sector on file" and "a sector with nobody else in it" are different
  // failures and must not collapse into the same reason.
  if (!sector) return { value: null, peers: 0, sector: null };
  const members = ctx.sectorMembers.get(sector) ?? [];
  const returns: number[] = [];
  for (const peer of members) {
    if (peer === ticker.toUpperCase()) continue;
    const series = ctx.seriesByTicker.get(peer);
    if (!series) continue;
    const ret = windowReturn(series, window);
    if (ret != null) returns.push(ret);
  }
  if (returns.length < ctx.minSectorPeers) return { value: null, peers: returns.length, sector };
  return { value: median(returns), peers: returns.length, sector };
}

export type HorizonReturnInput = {
  ticker: string;
  window: Window;
  holdSessions: number;
  sign: 1 | -1;
  /** Point-in-time beta at the SIGNAL session — never a beta fitted over the hold. */
  beta: number | null;
};

/**
 * The three layers for one horizon.
 *
 * Beta comes from the signal session's snapshot, i.e. from a regression that
 * ended before the trade existed. Fitting beta over the holding window instead
 * would let the outcome choose its own adjustment.
 */
export function computeHorizonReturn(ctx: ReturnContext, input: HorizonReturnInput): HorizonReturn {
  const degraded: string[] = [];
  const series = ctx.seriesByTicker.get(input.ticker.toUpperCase());
  const bench = ctx.seriesByTicker.get(ctx.benchmark.toUpperCase());
  const exitSnap = input.window.exit && series ? snapshotAt(series, input.window.exit) : null;

  const raw = series ? windowReturn(series, input.window) : null;
  if (raw == null) degraded.push("window_incomplete");

  let marketAdjusted: number | null = null;
  if (raw != null && bench) {
    const benchReturn = windowReturn(bench, input.window);
    if (benchReturn == null) {
      degraded.push("benchmark_missing");
    } else if (input.beta == null) {
      // No fitted beta yet (inside the 90-session warm-up): subtracting the raw
      // index move would silently assume beta = 1 on a name that may be at 2.
      degraded.push("beta_unavailable");
    } else {
      marketAdjusted = raw - input.beta * benchReturn;
    }
  }

  let sectorRelative: number | null = null;
  if (raw != null) {
    const sector = sectorMedianReturn(ctx, input.ticker, input.window);
    if (sector.value == null) {
      degraded.push(sector.sector == null ? "sector_unknown" : "sector_peers_thin");
    } else {
      sectorRelative = raw - sector.value;
    }
  }

  const sign = input.sign;
  return {
    sessions: input.holdSessions,
    exit_session: input.window.exit,
    exit_price: exitSnap?.close ?? null,
    raw: raw == null ? null : raw * sign,
    market_adjusted: marketAdjusted == null ? null : marketAdjusted * sign,
    sector_relative: sectorRelative == null ? null : sectorRelative * sign,
    degraded,
  };
}

/**
 * Picks the value a report leads with. Sector-relative when it exists, then
 * market-adjusted, then raw — each fallback is recorded in `degraded` on the
 * return itself, so a thinner layer is never presented as the honest one.
 */
export function headlineValue(ret: HorizonReturn): number | null {
  return ret.sector_relative ?? ret.market_adjusted ?? ret.raw;
}

/** Builds the sector index from the classifier's metadata rows. */
export function buildSectorIndex(
  rows: Array<{ ticker: string; sector: string | null }>,
): { sectorOf: Map<string, string>; sectorMembers: Map<string, string[]> } {
  const sectorOf = new Map<string, string>();
  const sectorMembers = new Map<string, string[]>();
  for (const row of rows) {
    if (!row?.sector) continue;
    const ticker = row.ticker.toUpperCase();
    sectorOf.set(ticker, row.sector);
    const members = sectorMembers.get(row.sector) ?? [];
    members.push(ticker);
    sectorMembers.set(row.sector, members);
  }
  for (const members of sectorMembers.values()) members.sort();
  return { sectorOf, sectorMembers };
}
