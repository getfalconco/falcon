/**
 * Desktop-side mirror of the Quant Lab contracts so the renderer and main
 * process don't import the Node-only research package directly.
 * Keep in sync with packages/research/src/quantlab/{types,config}.ts.
 */

export const QUANTLAB_SCHEMA_VERSION = 1;

export const SCREEN_PATTERN_NAMES = [
  "quiet_accumulation",
  "compression",
  "independent_tape",
  "insider_divergence",
] as const;
export type StrategyPatternName = (typeof SCREEN_PATTERN_NAMES)[number];

export const TRIGGER_KINDS = ["event", "pattern", "setup", "composite_and"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export type EntryWhen = "signal_close" | "next_open";
export type ReturnLayer = "raw" | "market_adjusted" | "sector_relative";

export type StrategyFilter =
  | { kind: "r2_floor"; min: number }
  | { kind: "no_earnings_within"; sessions: number }
  | { kind: "unpriced"; max_ratio: number }
  | { kind: "liquidity"; min_dollar_volume_20d: number }
  | { kind: "vol_regime"; max: number };

export type StrategyTrigger = {
  kind: TriggerKind;
  event?: { types: string[]; on: "root" | "graph_neighbour" };
  pattern?: { names: StrategyPatternName[]; state: "new" | "any" };
  setup?: { names: string[]; state: string };
  graph?: { edge_from_event_ticker: boolean; min_tier: "critical" | "important" | "marginal"; max_hops: number };
};

export type Strategy = {
  strategy_id: string;
  version: number;
  name: string;
  created_at: string;
  parent_version: number | null;
  universe: { tickers: "tracked" | string[]; min_history_sessions: number };
  trigger: StrategyTrigger;
  filters: StrategyFilter[];
  entry: { when: EntryWhen };
  hold: { sessions: number[] };
  exit: { kind: "time_only" };
  direction: { kind: "event_direction" | "pattern_direction" | "long_only" };
  notes: string;
  created_after_oos_view: boolean;
  live_enabled: boolean;
};

export type HorizonReturn = {
  sessions: number;
  exit_session: string | null;
  exit_price: number | null;
  raw: number | null;
  market_adjusted: number | null;
  sector_relative: number | null;
  degraded: string[];
};

export type Signal = {
  ticker: string;
  session: string;
  entry_session: string;
  entry_price: number;
  entry_when: EntryWhen;
  sign: 1 | -1;
  sector: string | null;
  reason: string;
  returns: HorizonReturn[];
};

export type HorizonStats = {
  sessions: number;
  n: number;
  n_tickers: number;
  median: number | null;
  mean: number | null;
  hit_rate: number | null;
  sharpe: number | null;
  sortino: number | null;
  max_drawdown: number | null;
  ci_low: number | null;
  ci_high: number | null;
  deciles: number[];
  base_rate_median: number | null;
  base_rate_n: number;
  insufficient: boolean;
};

export type SampleStats = {
  label: "in_sample" | "out_of_sample" | "full";
  from: string;
  to: string;
  horizons: HorizonStats[];
};

export type Exclusion = { ticker: string; reason: string; detail: string };

/** One session on the equity curve: strategy and benchmark growth, both from 1. */
export type EquityPoint = { d: string; s: number; b: number; n: number };

export type EquityCurve = {
  horizon: number;
  points: EquityPoint[];
  strategy_total: number | null;
  benchmark_total: number | null;
  strategy_max_drawdown: number | null;
  benchmark_max_drawdown: number | null;
  /** Share of sessions with at least one position open. */
  exposure: number;
  sessions: number;
  /** The modelling decision, carried with the curve. */
  assumption: string;
};

export type BacktestReport = {
  report_id: string;
  strategy_id: string;
  strategy_version: number;
  strategy_name: string;
  created_at: string;
  window: { from: string; to: string };
  headline_layer: ReturnLayer;
  full: SampleStats;
  in_sample: SampleStats;
  out_of_sample: SampleStats;
  variant_number: number;
  variant_warning: string | null;
  overfit_warning: string | null;
  split_warning: string | null;
  created_after_oos_view: boolean;
  verdict: string;
  excluded: Exclusion[];
  caveats: string[];
  signals: Signal[];
  /** Growth vs buy-and-hold benchmark, one curve per hold horizon. */
  equity: EquityCurve[];
};

export type LiveSignal = {
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
  complete: boolean;
  /** True when this row was replayed from an already-closed session, not recorded forward. */
  backfilled: boolean;
};

/** A strategy plus everything the builder needs to render it honestly. */
export type StrategyRow = {
  strategy: Strategy;
  /** Backtest runs of this family so far — the variant count. */
  runs: number;
  /** Components that cannot be evaluated point-in-time, with the reason (§3). */
  unavailable: Array<{ component: string; reason: string }>;
  backtestable: boolean;
  /** Null when the strategy may be enabled for live evaluation; the reason otherwise. */
  enable_blocked_reason: string | null;
  versions: number[];
};

export type QuantLabStatus = {
  dataDir: string;
  configFile: string;
  seriesDir: string;
  strategiesFile: string;
  ledgerFile: string;
  /** Backfilled series on disk. */
  seriesCount: number;
  seriesFrom: string | null;
  seriesTo: string | null;
  benchmark: string;
  universeSize: number;
  strategyCount: number;
  reportCount: number;
  ledgerCount: number;
  lastError: string | null;
  running: boolean;
};

export type BacktestProgress = {
  strategy_id: string;
  state: "running" | "done" | "error";
  message: string;
};
