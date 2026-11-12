/**
 * What the engine reads, and the interfaces that supply it. The engine never
 * fetches; a loader fills `MarketData` from whichever sources are plugged in.
 *
 * Vault (Engine/Ripple Engine, Backtesting): Yahoo Finance until the first
 * paying user, then a licensed source (Massive). A Massive implementation only
 * has to satisfy `PriceSource` / `EarningsSource`; nothing else changes.
 */

import type { Confidence, Direction, Relation } from "@falcon/ripple";

/** One daily bar, split- and dividend-adjusted (all four prices on the same basis). */
export type Bar = {
  /** Exchange-local trading date, YYYY-MM-DD. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** One reported quarter. */
export type EarningsEvent = {
  /** Exchange-local calendar date of the release, YYYY-MM-DD. */
  date: string;
  /** When in the day it came out, if known. The engine treats every release as known by the end of `date`. */
  time: "before_open" | "during" | "after_close" | "unknown";
  epsActual: number | null;
  epsEstimate: number | null;
  /** (actual - estimate) / |estimate| * 100. */
  surprisePct: number | null;
};

/**
 * One past hit of a ripple card on a ticker: the card about an event at
 * another company reached this one. Fed by the Ripple Engine later
 * (packages/engine writes RippleCard; a source maps cards to these rows).
 */
export type RippleSignal = {
  ticker: string;
  /** Exchange-local date the card became public, YYYY-MM-DD. */
  date: string;
  relation: Relation;
  direction: Direction;
  confidence: Confidence;
  degree: 1 | 2;
  cardId: string;
};

export interface PriceSource {
  readonly name: string;
  /** Adjusted daily bars covering [from, to] (inclusive), oldest first. Empty when the ticker is unknown. */
  dailyBars(ticker: string, from: string, to: string, signal?: AbortSignal): Promise<Bar[]>;
}

export interface EarningsSource {
  readonly name: string;
  /** Reported quarters with a release date in [from, to], oldest first. */
  earnings(ticker: string, from: string, to: string, signal?: AbortSignal): Promise<EarningsEvent[]>;
}

export interface RippleSource {
  readonly name: string;
  hits(query: { tickers: string[]; from: string; to: string }, signal?: AbortSignal): Promise<RippleSignal[]>;
}

export type MarketData = {
  /** Bars per ticker, including history before the test start for indicator warm-up. */
  bars: Record<string, Bar[]>;
  /** The SPY bars; also the trading calendar. */
  benchmark: Bar[];
  earnings: Record<string, EarningsEvent[]>;
  ripple: RippleSignal[];
  /** Which sources filled this, for the result's provenance line. */
  sources: { prices: string; earnings: string | null; ripple: string | null };
  /** Gaps the loader found (a ticker with no data, an earnings source that failed). */
  warnings: string[];
};
