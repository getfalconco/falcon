/**
 * Screen — contracts (spec v1.0).
 *
 * The tape-driven opportunity channel: every close it scans the tracked
 * universe's persisted quant series for multi-session structures worth
 * attention — conditions, not predictions. Deterministic, LLM-free, read-only
 * over the Tracker stores; it emits nothing into the pipeline (no messages, no
 * incidents, no routing, no budget) — with one narrow exception since S1: a
 * pattern's FIRST session on a ticker the user is close to emits a single
 * `tape_structure` message (see emit.ts). Screen finds → Gauge times →
 * Analyst explains; the chain is otherwise still navigational.
 */

export const SCREEN_SCHEMA_VERSION = 1;

export const SCREEN_PATTERNS = ["quiet_accumulation", "compression", "independent_tape", "insider_divergence"] as const;
export type ScreenPattern = (typeof SCREEN_PATTERNS)[number];

/** Lifecycle state of a persisted finding (§5). */
export type ScreenFindingState = "new" | "continuing" | "ended";

/** One pattern evaluation on one ticker for one completed session (§3). */
export type ScreenEvalStatus = "present" | "absent" | "n_a";

export type ScreenModifier = "near_52w_high" | "near_52w_low";

export type ScreenDirection = "up" | "down";
export type ScreenInsiderDirection = "buy" | "sell";

export type ScreenValue = number | string | boolean | null;

// ---------------------------------------------------------------------------
// Series views (§10.1) — what the patterns read, built from persisted bars
// ---------------------------------------------------------------------------

/** One completed session's derived view. Null = window not covered (§3.11 rule inherited from Tracker). */
export type ScreenSessionView = {
  /** NY trading date. */
  d: string;
  close: number;
  volume: number;
  /** Simple return vs the previous aligned session. */
  ret: number | null;
  /** Benchmark simple return for the same session. */
  bench_ret: number | null;
  /** Session volume ÷ median volume of the N prior sessions (no self-inclusion). */
  volume_ratio: number | null;
  /** ret − β·bench_ret with β from the regression window ending at this session (Tracker's definition). */
  residual_move: number | null;
  /** residual_move ÷ robust std of that regression's residuals. */
  residual_z: number | null;
};

export type ScreenSeriesView = {
  ticker: string;
  /** Last completed session in the view (≤ the scan session). */
  as_of: string | null;
  /** Aligned ticker⋂benchmark sessions on file up to `as_of`. */
  history_sessions: number;
  /** Views for the last `windows.sessions` completed sessions, oldest first (may be shorter than the window when history is thin). */
  sessions: ScreenSessionView[];
  beta: number | null;
  r2: number | null;
  /** Robust 30-session daily vol at `as_of` (fraction). */
  daily_vol: number | null;
  /** vol30 / vol90. */
  vol_regime: number | null;
  momentum_5d: number | null;
  momentum_20d: number | null;
  /** (max high − min low) over the compression window ÷ last close; null when the window is not covered. */
  range_10s: number | null;
  pct_from_52w_high: number | null;
  pct_from_52w_low: number | null;
};

// ---------------------------------------------------------------------------
// Detector state the patterns read (§2 boundary: state only, no re-detection)
// ---------------------------------------------------------------------------

export type ScreenInsiderClusterInput = {
  active: boolean;
  direction: ScreenInsiderDirection | null;
  insider_count: number | null;
  window_business_days: number | null;
  total_notional: number | null;
  /** ISO instant the detector last fired (null = never). */
  last_fired_at: string | null;
};

export type ScreenNewsBurstInput = {
  active: boolean;
  last_fired_at: string | null;
  /** NY trading dates on which a news_burst message was emitted (from the message store). */
  fired_days: string[];
};

export type ScreenTickerInput = {
  ticker: string;
  /** Split-adjusted daily bars as persisted by Tracker (any order; the view sorts and truncates). */
  bars: import("../tracker/types.js").DailyBar[];
  news_burst: ScreenNewsBurstInput | null;
  insider_cluster: ScreenInsiderClusterInput | null;
};

// ---------------------------------------------------------------------------
// Evaluation + findings (§3, §5)
// ---------------------------------------------------------------------------

export type ScreenEvaluation = {
  ticker: string;
  pattern: ScreenPattern;
  session: string;
  status: ScreenEvalStatus;
  /** Why n_a (insufficient history, r² floor, cluster direction unavailable…); null otherwise. */
  na_reason: string | null;
  values: Record<string, ScreenValue>;
  modifiers: ScreenModifier[];
  /** Sessions that satisfied the per-session criterion (volume / residual) — listed in the detail view. */
  qualifying_sessions: string[];
  /** The per-session views the criteria were counted over (detail view). */
  sessions_view: ScreenSessionView[];
  /** One templated condition-language line (§6) — present evaluations only. */
  read: string | null;
};

export type ScreenEndedReason = "condition_false" | "not_evaluable" | "untracked";

export type ScreenFinding = {
  /** Deterministic: screen:{TICKER}:{pattern}:{first_session}. */
  id: string;
  schema_version: number;
  ticker: string;
  pattern: ScreenPattern;
  state: ScreenFindingState;
  /** Number of scanned sessions the condition has held. */
  day_count: number;
  first_session: string;
  last_evaluated: string;
  /** Every scanned session on which the condition held (oldest first) — makes re-runs idempotent. */
  sessions: string[];
  values: Record<string, ScreenValue>;
  modifiers: ScreenModifier[];
  qualifying_sessions: string[];
  sessions_view: ScreenSessionView[];
  read: string;
  ended_at: string | null;
  ended_reason: ScreenEndedReason | null;
  /**
   * S1: instant this finding was emitted to Base as a `tape_structure`
   * message; null when it never was. One emit per finding, ever.
   */
  emitted_at?: string | null;
};

/** A ticker × pattern that could not be evaluated this scan — never a silent skip (§5). */
export type ScreenDegraded = {
  ticker: string;
  pattern: ScreenPattern | "all";
  reason: string;
  history_sessions: number | null;
};

export type ScreenScan = {
  schema_version: number;
  /** Completed trading session the scan describes. */
  session: string;
  scanned_at: string;
  trigger: ScreenScanTrigger;
  tickers_scanned: number;
  tickers_total: number;
  evaluations: number;
  new: number;
  continuing: number;
  ended: number;
  degraded: ScreenDegraded[];
  errors: string[];
};

export type ScreenScanTrigger = "startup" | "close_run" | "manual" | "script";

export type ScreenStoreState = {
  schema_version: number;
  findings: ScreenFinding[];
  /** Newest last. */
  scans: ScreenScan[];
};

// ---------------------------------------------------------------------------
// S1 emit channel — the one message Screen puts into the pipeline
// ---------------------------------------------------------------------------

export const SCREEN_MESSAGE_TYPE = "tape_structure" as const;
export type ScreenMessageType = typeof SCREEN_MESSAGE_TYPE;

/** Cumulative move since the pattern's first session (the structure's own reference point). */
export type ScreenSinceFirst = {
  /** First session actually covered by the series view; null when none is. */
  covered_from: string | null;
  /** Sessions counted (may be fewer than the finding's day_count when the view window is shorter). */
  sessions: number;
  /** Compounded simple return over the covered sessions. */
  ret: number | null;
  /** Sum of residual z over the covered sessions ÷ sqrt(n) — a multi-session z. */
  residual_z_cum: number | null;
};

export type TapeStructurePayload = {
  pattern: ScreenPattern;
  /** The finding this message reports (`screen:TICKER:pattern:first_session`). */
  finding_id: string;
  first_session: string;
  /** Completed session of the scan that emitted it. */
  session: string;
  day_count: number;
  values: Record<string, ScreenValue>;
  modifiers: ScreenModifier[];
  /** Screen's own condition-language line for the finding. */
  read: string;
  since_first: ScreenSinceFirst;
};

/**
 * The Tracker §4 message envelope, emitted by Screen. Same shape so Base can
 * treat it like any other measurement message; `source_engine` and `type`
 * are what set it apart. Tracker's own types are untouched — Base carries the
 * union (`BaseMessage`).
 */
export type TapeStructureMessage = {
  id: string;
  schema_version: number;
  type: ScreenMessageType;
  ticker: string;
  timestamp: string;
  source_engine: "screen";
  context_flags: import("../tracker/types.js").ContextFlag[];
  quant_context: import("../tracker/types.js").QuantContext;
  payload: TapeStructurePayload;
};

/** §8 minimal contract for later surfaces: latest active findings. */
export type ScreenActiveFinding = {
  ticker: string;
  pattern: ScreenPattern;
  day_count: number;
  read: string;
};
