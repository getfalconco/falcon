/**
 * Tracker central configuration (§5, §7): every threshold tunable without
 * code changes. Values here are the pilot defaults; the persisted config file
 * (store.ts) overrides them at runtime.
 */

export type TrackerThresholds = {
  gapZ: number;
  volumeRatio: number;
  silenceMinBaselinePerDay: number;
  silenceTradingDays: number;
  silenceEarningsLookaheadDays: number;
  filingOverdueBusinessDays: number;
  filingLagHistoryCount: number;
  unexplainedZ: number;
  lowR2Fallback: number;
  driftZ: number;
  /** Drift gate: no news_burst fired within this many trading days (T6). */
  driftNewsFreeDays: number;
  newsBurstMultiple: number;
  newsBurstMinArticles: number;
  insiderClusterMinInsiders: number;
  insiderClusterWindowBusinessDays: number;
  /** Per-transaction notional floor; below it a transaction is de minimis and does not count. */
  insiderClusterMinNotionalUsd: number;
  /**
   * Same-day bulk guard: past this many distinct insiders filing one
   * direction on one date, a group whose median value is under the notional
   * floor is a share-plan settlement, not a cluster.
   */
  insiderClusterBulkInsiderCount: number;
  /** Snapshot re-fire + edge escalation multiple (§5 firing model). */
  escalationMultiple: number;
};

export type TrackerWindows = {
  betaDays: number;
  volShortDays: number;
  volLongDays: number;
  gapDays: number;
  week52Days: number;
  newsBaselineTradingDays: number;
  earningsHistoryCount: number;
  /** How many of the nearest upcoming earnings dates count as confirmed. */
  confirmedEarningsCount: number;
  backfillTradingDays: number;
  /** How far back the Form 4 scan reaches; matches the price history span. */
  insiderBackfillTradingDays: number;
};

export type TrackerIntervals = {
  newsPollMs: number;
  filingChecksPerTradingDay: number;
  calendarRefreshMs: number;
  schedulerTickMs: number;
  quoteCacheMs: number;
  /**
   * The hot lane: around a confirmed earnings due_at the normal round-robin is
   * far too slow — an 8-K item 2.02 filed at 16:05 ET waits 65–130 minutes for
   * its turn, by which time the second-order move has happened. Inside
   * `hotWindowHours` of a due_at, that ticker polls on these intervals instead
   * and is served before the shared per-cycle budget is spent.
   */
  hotNewsPollMs: number;
  hotFilingPollMs: number;
  /** Half-width of the hot window around a confirmed earnings due_at. */
  hotWindowHours: number;
  /** Articles/day at or above which the backfill uses the small window. */
  newsHighVolumePerDay: number;
  newsChunkDaysHighVolume: number;
  newsChunkDaysLowVolume: number;
};

/**
 * How the tracked universe is chosen (§1):
 *  - "cached": every ticker with cached data on disk, rediscovered at start.
 *  - "explicit": exactly the `tickers` list below.
 * Adding or removing a ticker at runtime switches the mode to "explicit" so a
 * deliberate choice is not silently overwritten on the next restart.
 */
export type UniverseMode = "cached" | "explicit";

export type TrackerConfig = {
  universeMode: UniverseMode;
  tickers: string[];
  /**
   * Tickers followed for price and filings only — no news polling (§S2).
   *
   * "Tracked" used to mean one thing, and it bundled two costs that are not
   * alike. Daily bars and EDGAR submissions are cheap and unmetered; the news
   * baseline alone can cost 24 Finnhub calls for a single busy name, and the
   * 15-minute poll then costs one per ticker per cycle forever. Finnhub's free
   * tier is the binding constraint on how many names we can follow at all.
   *
   * Propagation does not need news on a target — it needs a PRICE, so it can
   * say whether the move it expected has happened. A target it cannot price is
   * the single largest source of unusable output. So a name reachable in the
   * graph but not itself an event source belongs here: fully priceable, fully
   * scoreable, costing no news quota.
   *
   * Everything in this list is also in `tickers`; this marks which of them
   * skip the news channel.
   */
  priceTierTickers: string[];
  benchmark: string;
  thresholds: TrackerThresholds;
  windows: TrackerWindows;
  intervals: TrackerIntervals;
};

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  universeMode: "cached",
  // Fallback only — under "cached" the real list is discovered from disk at
  // start. This is the §7 pilot set, used when no cache exists yet.
  tickers: ["NVDA", "MSFT", "CEG", "TSM", "LLY"],
  priceTierTickers: [],
  benchmark: "SPY",
  thresholds: {
    gapZ: 2.5, // T8: 2.0 sat at ~p90 of the replay distribution (5 crossings/day universe-wide)
    volumeRatio: 3.0,
    silenceMinBaselinePerDay: 1,
    silenceTradingDays: 3,
    silenceEarningsLookaheadDays: 14,
    filingOverdueBusinessDays: 10,
    filingLagHistoryCount: 8,
    unexplainedZ: 2.5, // T8: 2.0 ≈ p90; 2.5 ≈ p95 (≈2.4 crossings/day)
    lowR2Fallback: 0.15,
    driftZ: 2.0,
    driftNewsFreeDays: 5,
    newsBurstMultiple: 4,
    newsBurstMinArticles: 5,
    insiderClusterMinInsiders: 3,
    insiderClusterWindowBusinessDays: 10,
    insiderClusterMinNotionalUsd: 50_000,
    insiderClusterBulkInsiderCount: 8,
    escalationMultiple: 1.5,
  },
  windows: {
    betaDays: 90,
    volShortDays: 30,
    volLongDays: 90,
    gapDays: 60,
    week52Days: 252,
    newsBaselineTradingDays: 30,
    earningsHistoryCount: 4,
    confirmedEarningsCount: 2,
    backfillTradingDays: 252,
    insiderBackfillTradingDays: 252,
  },
  intervals: {
    newsPollMs: 15 * 60_000,
    filingChecksPerTradingDay: 3,
    calendarRefreshMs: 24 * 60 * 60_000,
    schedulerTickMs: 60_000,
    quoteCacheMs: 60_000,
    hotNewsPollMs: 60_000,
    hotFilingPollMs: 60_000,
    hotWindowHours: 2,
    newsHighVolumePerDay: 10,
    newsChunkDaysHighVolume: 2,
    newsChunkDaysLowVolume: 7,
  },
};

export function mergeTrackerConfig(partial: Partial<TrackerConfig> | null): TrackerConfig {
  if (!partial) return structuredClone(DEFAULT_TRACKER_CONFIG);
  return {
    ...structuredClone(DEFAULT_TRACKER_CONFIG),
    ...partial,
    // Explicit rather than by spread: a stored config written before the tier
    // existed has no key, and `...partial` would leave `undefined` behind.
    priceTierTickers: [...(partial.priceTierTickers ?? DEFAULT_TRACKER_CONFIG.priceTierTickers)],
    thresholds: { ...DEFAULT_TRACKER_CONFIG.thresholds, ...(partial.thresholds ?? {}) },
    windows: { ...DEFAULT_TRACKER_CONFIG.windows, ...(partial.windows ?? {}) },
    intervals: { ...DEFAULT_TRACKER_CONFIG.intervals, ...(partial.intervals ?? {}) },
  };
}
