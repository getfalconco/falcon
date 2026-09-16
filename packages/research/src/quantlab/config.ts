/**
 * Quant Lab configuration (§11).
 *
 * Every threshold, window and guard is a knob here — nothing is a literal in
 * the engine. Stored `config.json` WINS over these defaults field by field
 * (same rule as Screen/Gauge/Risk), so a calibration change needs the stored
 * file edited, not the code.
 *
 * The guard defaults are deliberately conservative: they exist to stop the
 * instrument flattering a strategy, and loosening one should feel like a
 * decision rather than a convenience.
 */

export type QuantLabBacktestConfig = {
  /** Years of history the backfill fetches and a backtest may span. */
  windowYears: number;
  /** Fraction of the window used as in-sample; the remainder is out-of-sample (§7). */
  inSampleRatio: number;
  /** Below this many signals the report refuses point estimates (§7). */
  minSignals: number;
  /** Variant count beyond which the report prints the selection-bias warning (§7). */
  variantWarningThreshold: number;
  /** Base-rate samples drawn per signal: n × this (§7). */
  baseRateMultiplier: number;
  /** Bootstrap resamples for the 95% CI on median return (§7). */
  bootstrapIterations: number;
  /** Seed for base-rate and bootstrap sampling — results must be reproducible. */
  randomSeed: number;
  /** Annualisation factor for Sharpe/Sortino (trading sessions per year). */
  sessionsPerYear: number;
  /** Annual risk-free rate used by Sharpe/Sortino. */
  riskFreeRate: number;
  /**
   * An IS/OOS Sharpe gap wider than this is flagged as likely overfit (§7).
   */
  overfitSharpeGap: number;
};

export type QuantLabDataConfig = {
  /** Benchmark symbol; also supplies the trading calendar (§6). */
  benchmark: string;
  /** A ticker with fewer aligned sessions than this is excluded from a backtest (§4). */
  minHistorySessions: number;
  /** Interior series holes of at least this many sessions exclude the ticker (§4). */
  maxGapSessions: number;
  /**
   * Sector-relative return needs peers. Below this many OTHER tickers in the
   * same sector the signal is marked degraded and market-adjusted leads (§5).
   * The live universe has five single-member sectors, so this matters.
   */
  minSectorPeers: number;
  /**
   * How many sessions before an earnings announcement the date counts as
   * known. Historically the only evidence is the 8-K itself, so treating the
   * date as knowable from the start of time would be look-ahead; companies do
   * pre-announce roughly a month out, which is what this approximates.
   */
  earningsKnowledgeHorizonSessions: number;
  /** Polite spacing between provider calls during the backfill, ms. */
  fetchSpacingMs: number;
};

export type QuantLabFilterDefaults = {
  /** §5 `liquidity` filter default: 20-session median dollar volume floor. */
  minDollarVolume20d: number;
  /** §5 `r2_floor` default. */
  r2Floor: number;
  /** §5 `unpriced` default: session move below this multiple of daily vol. */
  unprisedMaxRatio: number;
  /** §5 `vol_regime` default ceiling. */
  volRegimeMax: number;
};

export type QuantLabConfig = {
  schemaVersion: number;
  backtest: QuantLabBacktestConfig;
  data: QuantLabDataConfig;
  filterDefaults: QuantLabFilterDefaults;
  /** Hold horizons offered in the builder, in sessions. */
  holdHorizons: number[];
  /** Retention for stored backtest results, days. */
  resultRetentionDays: number;
  /**
   * Components that exist in the product but cannot be evaluated
   * point-in-time, with the reason the builder shows (§3). Config rather than
   * code so a later backfill can retire an entry without a release.
   */
  unavailableHistorically: Record<string, string>;
  /** Caveats printed on every report page (§13). */
  reportCaveats: string[];
};

export const DEFAULT_QUANTLAB_CONFIG: QuantLabConfig = {
  schemaVersion: 1,
  backtest: {
    windowYears: 5,
    inSampleRatio: 0.6,
    minSignals: 30,
    variantWarningThreshold: 10,
    baseRateMultiplier: 20,
    bootstrapIterations: 2000,
    randomSeed: 20260825,
    sessionsPerYear: 252,
    riskFreeRate: 0,
    overfitSharpeGap: 1.0,
  },
  data: {
    benchmark: "SPY",
    minHistorySessions: 300,
    maxGapSessions: 3,
    minSectorPeers: 3,
    earningsKnowledgeHorizonSessions: 21,
    fetchSpacingMs: 1100,
  },
  filterDefaults: {
    minDollarVolume20d: 5_000_000,
    r2Floor: 0.15,
    unprisedMaxRatio: 0.35,
    volRegimeMax: 1.5,
  },
  holdHorizons: [1, 3, 5, 10],
  resultRetentionDays: 365,
  unavailableHistorically: {
    insider_cluster:
      "Tracker prunes insider transactions to a 10-business-day window, so no cluster history exists. The Form 4 filings are on disk and a backfill can retire this.",
    news_burst:
      "News counts are ~40 trading days deep and the provider's free tier caps at ~12 months, so burst state cannot be rebuilt for a multi-year window.",
    classifier_verdict: "Classifier verdicts only exist from Aug 2026 forward.",
    analyst_output: "Analyst outputs only exist from Aug 2026 forward.",
    propagation_run: "Propagation runs only exist from Aug 2026 forward.",
  },
  reportCaveats: [
    "Returns are gross — no transaction costs, no slippage, no market impact.",
    "The news-burst veto is inactive in backtest (it cannot be rebuilt historically). This is permissive: more signals fire here than would fire live.",
    "Earnings dates are treated as known only within the configured horizon; before that the event is invisible to the rule.",
    "Sector membership is today's mapping applied to past sessions — it is not point-in-time.",
  ],
};

// ---------------------------------------------------------------------------
// Merge (stored config wins, field by field)
// ---------------------------------------------------------------------------

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function int(v: unknown, fallback: number, min = 1): number {
  return Math.max(min, Math.floor(num(v, fallback)));
}
function ratio(v: unknown, fallback: number): number {
  const n = num(v, fallback);
  return n > 0 && n < 1 ? n : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}
function strList(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? [...(v as string[])] : [...fallback];
}

export function mergeQuantLabConfig(stored: DeepPartial<QuantLabConfig> | null | undefined): QuantLabConfig {
  const d = DEFAULT_QUANTLAB_CONFIG;
  if (!stored) return structuredClone(d);
  const b = stored.backtest ?? {};
  const dt = stored.data ?? {};
  const f = stored.filterDefaults ?? {};

  const unavailable: Record<string, string> = { ...d.unavailableHistorically };
  for (const [key, value] of Object.entries(stored.unavailableHistorically ?? {})) {
    if (typeof value === "string" && value.length > 0) unavailable[key] = value;
  }

  const horizons =
    Array.isArray(stored.holdHorizons) && stored.holdHorizons.every((h) => typeof h === "number" && h > 0)
      ? [...new Set(stored.holdHorizons as number[])].sort((x, y) => x - y)
      : [...d.holdHorizons];

  return {
    // Always the code's version, never the file's — a stale file must not
    // claim to be a newer schema than the engine reading it.
    schemaVersion: d.schemaVersion,
    backtest: {
      windowYears: int(b.windowYears, d.backtest.windowYears),
      inSampleRatio: ratio(b.inSampleRatio, d.backtest.inSampleRatio),
      minSignals: int(b.minSignals, d.backtest.minSignals),
      variantWarningThreshold: int(b.variantWarningThreshold, d.backtest.variantWarningThreshold),
      baseRateMultiplier: int(b.baseRateMultiplier, d.backtest.baseRateMultiplier),
      bootstrapIterations: int(b.bootstrapIterations, d.backtest.bootstrapIterations, 100),
      randomSeed: int(b.randomSeed, d.backtest.randomSeed, 0),
      sessionsPerYear: int(b.sessionsPerYear, d.backtest.sessionsPerYear),
      riskFreeRate: num(b.riskFreeRate, d.backtest.riskFreeRate),
      overfitSharpeGap: num(b.overfitSharpeGap, d.backtest.overfitSharpeGap),
    },
    data: {
      benchmark: str(dt.benchmark, d.data.benchmark).toUpperCase(),
      minHistorySessions: int(dt.minHistorySessions, d.data.minHistorySessions),
      maxGapSessions: int(dt.maxGapSessions, d.data.maxGapSessions),
      minSectorPeers: int(dt.minSectorPeers, d.data.minSectorPeers, 0),
      earningsKnowledgeHorizonSessions: int(
        dt.earningsKnowledgeHorizonSessions,
        d.data.earningsKnowledgeHorizonSessions,
        0,
      ),
      fetchSpacingMs: int(dt.fetchSpacingMs, d.data.fetchSpacingMs, 0),
    },
    filterDefaults: {
      minDollarVolume20d: num(f.minDollarVolume20d, d.filterDefaults.minDollarVolume20d),
      r2Floor: num(f.r2Floor, d.filterDefaults.r2Floor),
      unprisedMaxRatio: num(f.unprisedMaxRatio, d.filterDefaults.unprisedMaxRatio),
      volRegimeMax: num(f.volRegimeMax, d.filterDefaults.volRegimeMax),
    },
    holdHorizons: horizons,
    resultRetentionDays: int(stored.resultRetentionDays, d.resultRetentionDays),
    unavailableHistorically: unavailable,
    reportCaveats: strList(stored.reportCaveats, d.reportCaveats),
  };
}
