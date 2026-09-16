/**
 * Quant Lab — contracts (spec v1.0).
 *
 * The developer surface where Falcon's quantitative claims become measurable:
 * define a rule, test it against history under honest constraints, and if it
 * survives, track what it does live. Deterministic, LLM-free, read-only over
 * every other engine's stores.
 *
 * Three parts: builder (define) → backtest (measure) → live ledger (verify
 * forward). A strategy is a set of conditions that must ALL hold — never a
 * weighted score (§2): weights are unfalsifiable knobs, a backtest will
 * happily overfit them, and a failed rule must name the clause that failed.
 */

import type { EquityCurve } from "./equity.js";

export const QUANTLAB_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Point-in-time series (§3)
// ---------------------------------------------------------------------------

/**
 * One completed session's derived quant state, computed from bars ≤ that
 * session only. This is the per-session history Tracker never kept: its
 * `TickerState.quant` is a single latest snapshot, overwritten every close.
 *
 * Field names mirror `ScreenSeriesView` (not Tracker's `QuantContext`) because
 * the values are produced by Screen's own `buildSeriesView`, which is already
 * the point-in-time implementation.
 */
export type QuantSnapshot = {
  /** NY trading date this snapshot describes. */
  d: string;
  /** Session open, carrying the same adjustment factor as the close — `next_open` entries price here. */
  open: number;
  close: number;
  volume: number;
  /** Simple return vs the previous aligned session. */
  ret: number | null;
  bench_ret: number | null;
  /** Session volume ÷ median volume of the N prior sessions (no self-inclusion). */
  volume_ratio: number | null;
  residual_move: number | null;
  residual_z: number | null;
  beta: number | null;
  r2: number | null;
  daily_vol: number | null;
  vol_regime: number | null;
  momentum_5d: number | null;
  momentum_20d: number | null;
  range_10s: number | null;
  pct_from_52w_high: number | null;
  pct_from_52w_low: number | null;
  /** Aligned ticker⋂benchmark sessions on file up to and including `d`. */
  history_sessions: number;
};

/** A ticker's full point-in-time series, oldest session first. */
export type QuantSeries = {
  ticker: string;
  snapshots: QuantSnapshot[];
};

// ---------------------------------------------------------------------------
// Data quality (§4)
// ---------------------------------------------------------------------------

/** Why a ticker was dropped from a backtest. Never silently interpolated. */
export type ExclusionReason =
  | "no_series"
  | "short_history"
  | "series_gap"
  | "no_sector"
  | "no_filings"
  | "insufficient_sector_peers";

export type Exclusion = {
  ticker: string;
  reason: ExclusionReason;
  detail: string;
};

/** A break in a daily series: sessions the benchmark traded but the ticker did not. */
export type SeriesGap = {
  from: string;
  to: string;
  sessions: number;
};

// ---------------------------------------------------------------------------
// Strategy definition (§5)
// ---------------------------------------------------------------------------

export const TRIGGER_KINDS = ["event", "pattern", "setup", "composite_and"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const SCREEN_PATTERN_NAMES = [
  "quiet_accumulation",
  "compression",
  "independent_tape",
  "insider_divergence",
] as const;
export type StrategyPatternName = (typeof SCREEN_PATTERN_NAMES)[number];

/** Where an event must land: on the ticker itself or on a graph neighbour. */
export type EventOn = "root" | "graph_neighbour";

export type EventTrigger = {
  /** 8-K item codes, prefixed `8k_item_` (e.g. `8k_item_2.02`). */
  types: string[];
  on: EventOn;
};

export type PatternTrigger = {
  names: StrategyPatternName[];
  /** `new` = first session the pattern held; `any` = it holds at all. */
  state: "new" | "any";
};

export type SetupTrigger = {
  /** Gauge setup keys, e.g. COILED. */
  names: string[];
  /** Gauge decision state the setup must be in. */
  state: string;
};

export type GraphTrigger = {
  edge_from_event_ticker: boolean;
  min_tier: "critical" | "important" | "marginal";
  max_hops: number;
};

export type StrategyTrigger = {
  kind: TriggerKind;
  event?: EventTrigger;
  pattern?: PatternTrigger;
  setup?: SetupTrigger;
  graph?: GraphTrigger;
};

export type StrategyFilter =
  | { kind: "r2_floor"; min: number }
  | { kind: "no_earnings_within"; sessions: number }
  | { kind: "unpriced"; max_ratio: number }
  | { kind: "liquidity"; min_dollar_volume_20d: number }
  | { kind: "vol_regime"; max: number };

export type FilterKind = StrategyFilter["kind"];

export type StrategyUniverse = {
  tickers: "tracked" | string[];
  min_history_sessions: number;
};

/** Entry timing. `signal_close` is only legal when the trigger is computable at the close (§6). */
export type EntryWhen = "signal_close" | "next_open";

export type StrategyDirection = {
  kind: "event_direction" | "pattern_direction" | "long_only";
};

export type Strategy = {
  strategy_id: string;
  version: number;
  name: string;
  created_at: string;
  parent_version: number | null;
  universe: StrategyUniverse;
  trigger: StrategyTrigger;
  filters: StrategyFilter[];
  entry: { when: EntryWhen };
  /** Hold horizons in sessions. Exit is time-only in v1 (§5) — no stops, no targets. */
  hold: { sessions: number[] };
  exit: { kind: "time_only" };
  direction: StrategyDirection;
  notes: string;
  /** Set when this version was created after an OOS result had been viewed (§7). */
  created_after_oos_view: boolean;
  /** Live-ledger toggle. The engine refuses to set this without an OOS result (§8). */
  live_enabled: boolean;
};

// ---------------------------------------------------------------------------
// Signals and returns (§6)
// ---------------------------------------------------------------------------

export type ReturnLayer = "raw" | "market_adjusted" | "sector_relative";

/** Realised return at one hold horizon, in all three layers. */
export type HorizonReturn = {
  sessions: number;
  exit_session: string | null;
  exit_price: number | null;
  raw: number | null;
  market_adjusted: number | null;
  sector_relative: number | null;
  /** Why a layer is missing or weaker than it looks. */
  degraded: string[];
};

/** One rule firing on one ticker on one session. */
export type Signal = {
  ticker: string;
  /** Session the trigger fired on. */
  session: string;
  /** Session the position is entered on (equal to `session` for signal_close). */
  entry_session: string;
  entry_price: number;
  entry_when: EntryWhen;
  /** +1 long, -1 short — returns are signed by this so a correct short counts positive. */
  sign: 1 | -1;
  sector: string | null;
  /** What fired, for the audit trail. */
  reason: string;
  returns: HorizonReturn[];
};

// ---------------------------------------------------------------------------
// Statistics and report (§7)
// ---------------------------------------------------------------------------

export type HorizonStats = {
  sessions: number;
  n: number;
  n_tickers: number;
  /** Null when n < the configured floor — the guard, not a formatting choice. */
  median: number | null;
  mean: number | null;
  hit_rate: number | null;
  sharpe: number | null;
  sortino: number | null;
  max_drawdown: number | null;
  /** Bootstrap 95% CI on the median. The width is the honesty. */
  ci_low: number | null;
  ci_high: number | null;
  /** Decile breakdown of returns — distribution, not just central tendency. */
  deciles: number[];
  /** Same tickers, same horizon, random entry dates. */
  base_rate_median: number | null;
  base_rate_n: number;
  /** True when n < the floor: point estimates suppressed. */
  insufficient: boolean;
};

export type SampleStats = {
  label: "in_sample" | "out_of_sample" | "full";
  from: string;
  to: string;
  horizons: HorizonStats[];
};

export type BacktestReport = {
  report_id: string;
  strategy_id: string;
  strategy_version: number;
  strategy_name: string;
  created_at: string;
  window: { from: string; to: string };
  /** Which return layer leads the report. Sector-relative unless too few peers. */
  headline_layer: ReturnLayer;
  full: SampleStats;
  in_sample: SampleStats;
  out_of_sample: SampleStats;
  /** "This is variant N of this strategy." */
  variant_number: number;
  variant_warning: string | null;
  /** IS/OOS divergence callout, null when the gap is unremarkable. */
  overfit_warning: string | null;
  /**
   * Set when the in-sample or out-of-sample side holds no signals at all, so
   * the split cannot separate what it exists to separate. Without this an
   * empty side reads as a defect rather than as the data constraint it is.
   */
  split_warning: string | null;
  created_after_oos_view: boolean;
  /** One deterministic sentence: the verdict line at the top of the Results tab. */
  verdict: string;
  excluded: Exclusion[];
  caveats: string[];
  signals: Signal[];
  /**
   * Growth of an equal-weight portfolio of this rule's signals against
   * buy-and-hold benchmark, one curve per hold horizon. The modelling
   * assumption travels on each curve.
   */
  equity: EquityCurve[];
};

// ---------------------------------------------------------------------------
// Live ledger (§8)
// ---------------------------------------------------------------------------

/**
 * A forward, out-of-sample-by-construction record. After a few months this is
 * the only performance evidence that cannot be overfit — worth more than any
 * backtest. It records what the rule said and what happened. Nothing else:
 * no orders, no sizing, no execution.
 */
export type LiveSignal = {
  /** Deterministic: `${strategy_id}:${version}:${ticker}:${session}` — re-runs are idempotent. */
  id: string;
  strategy_id: string;
  strategy_version: number;
  ticker: string;
  session: string;
  entry_session: string;
  entry_price: number;
  sign: 1 | -1;
  sector: string | null;
  reason: string;
  recorded_at: string;
  returns: HorizonReturn[];
  /** True once every horizon has a realised return. */
  complete: boolean;
  /**
   * True when this row was produced by evaluating a session that had ALREADY
   * closed — a replay, not a forward record.
   *
   * The ledger's entire value is that its contents were committed to before
   * the outcome existed, so a backfilled row is not evidence of anything and
   * must never be counted alongside genuine forward ones. Marking it is the
   * only way to keep both in the same file safely.
   */
  backfilled: boolean;
};
