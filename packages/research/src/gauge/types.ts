/**
 * Gauge — contracts (spec v1.0).
 *
 * The pre-flight instrument panel: a set of deterministic condition checks
 * over a tracked ticker's live quant state, never a recommendation. Two modes:
 * standalone (ticker only — describes the tape neutrally) and context (ticker
 * + a thesis — directional semantics plus two contextual checks). Fully
 * deterministic, stateless, LLM-free; every input traces to Tracker / Base /
 * Propagation / calendar state already on disk.
 */

export const GAUGE_SCHEMA_VERSION = 1;

export const GAUGE_CHECK_KEYS = [
  "trend",
  "regime",
  "residual",
  "volume",
  "stretch",
  "event_wall",
  "conflict",
  "freshness",
] as const;
export type GaugeCheckKey = (typeof GAUGE_CHECK_KEYS)[number];

/** §3 numbering — the summary tie-break orders by it. */
export const GAUGE_CHECK_NUMBER: Record<GaugeCheckKey, number> = {
  trend: 1,
  regime: 2,
  residual: 3,
  volume: 4,
  stretch: 5,
  event_wall: 6,
  conflict: 7,
  freshness: 8,
};

/** Checks that exist only in context mode (§3 #7, #8). */
export const GAUGE_CONTEXT_ONLY_CHECKS: readonly GaugeCheckKey[] = ["conflict", "freshness"];

export const GAUGE_STATUSES = ["pass", "caution", "fail", "n_a"] as const;
export type GaugeStatus = (typeof GAUGE_STATUSES)[number];

export const GAUGE_OVERALLS = ["clear", "mixed", "blocked"] as const;
export type GaugeOverall = (typeof GAUGE_OVERALLS)[number];

export type GaugeMode = "standalone" | "context";

/** Thesis direction as Gauge reads it. Mixed/unclear event directions map to null. */
export type GaugeDirection = "up" | "down";

export type GaugeContextSource = "propagation_target" | "incident" | "manual";

export type GaugePricingStatus = "open" | "partial" | "priced" | "contradicted" | "stale" | "unknown";

// ---------------------------------------------------------------------------
// Context (§2)
// ---------------------------------------------------------------------------

export type GaugeContext = {
  /** Expected move on this ticker; null when the thesis direction is unresolved. */
  expected_direction: GaugeDirection | null;
  /** Instant the thesis is anchored on (the event). */
  event_ts: string;
  source: GaugeContextSource;
  /** Source pricing status when the caller has one (Propagation target). */
  pricing_status?: GaugePricingStatus | null;
  /** Sessions opened since the event when the caller already knows (pricing.sessions_elapsed); derived from event_ts otherwise. */
  sessions_since_event?: number | null;
  /** The thesis IS the scheduled event (check 6 → n_a, "event is the thesis"). */
  thesis_is_scheduled_event?: boolean;
};

// ---------------------------------------------------------------------------
// Inputs — everything the checks read, already plucked from the stores
// ---------------------------------------------------------------------------

/** Tracker §3 quant context as persisted by the close-run (all fractions). */
export type GaugeQuantInput = {
  beta: number | null;
  r2: number | null;
  /** Robust 30-session daily vol (0.02 = 2%). */
  daily_vol: number | null;
  /** vol30 / vol90. */
  vol_regime: number | null;
  momentum_5d: number | null;
  momentum_20d: number | null;
  momentum_60d: number | null;
  volume_ratio: number | null;
  volume_ratio_partial: boolean;
  /** Negative below the high (−0.088 = 8.8% under). */
  pct_from_52w_high: number | null;
  /** Positive above the low. */
  pct_from_52w_low: number | null;
  /** Mean |1-day earnings move| as a fraction. */
  earnings_rhythm: number | null;
  move_zscore: number | null;
  residual_zscore: number | null;
  /** Trading day the quant describes. */
  as_of: string | null;
};

export type GaugeSignedDirection = "up" | "down";
export type GaugeInsiderDirection = "buy" | "sell";

/** Edge-triggered detector states (+ the snapshot unexplained_move) with direction where the detector has one. */
export type GaugeDetectorInput = {
  news_burst: boolean;
  drift: { active: boolean; direction: GaugeSignedDirection | null };
  insider_cluster: { active: boolean; direction: GaugeInsiderDirection | null };
  filing_overdue: boolean;
  unexplained_move: { active: boolean; direction: GaugeSignedDirection | null };
};

export type GaugeIncidentInput = {
  incident_id: string;
  band: "P0" | "P1" | "P2" | "P3";
  tags: string[];
};

export type GaugeEarningsInput = {
  due_at: string;
  /** Trading sessions until due (0 = today). */
  sessions_until: number;
  fiscal_period: string | null;
};

/** v2 §4: one active Screen finding on this ticker, as the setup layer reads it. */
export type GaugeScreenPattern = "quiet_accumulation" | "compression" | "independent_tape" | "insider_divergence";

export type GaugeScreenFinding = {
  pattern: GaugeScreenPattern;
  state: "new" | "continuing";
  /** Scanned sessions the condition has held. */
  day_count: number;
  /** independent_tape tape direction / insider_divergence cluster side; null for the symmetric patterns. */
  direction: GaugeSignedDirection | GaugeInsiderDirection | null;
  /** Screen's own one-line read (shown as provenance, never re-templated). */
  read: string;
  values: Record<string, GaugeValue>;
};

/**
 * v2 news context. The gates read `burst_active` / `event_in_window`, never the
 * raw article count: this universe is news-saturated (42 of 43 tickers carry
 * articles in any 5-session window), so a literal "no news" gate never opens —
 * the same lesson Tracker's T6 calibration learned for drift/unexplained.
 */
export type GaugeNewsContext = {
  /** news_burst detector active now. */
  burst_active: boolean;
  /** Articles over the lookback — diagnostic only, never a gate. */
  articles: number;
  /** gap_event / unexplained_move fired, or a scheduled event landed, inside the lookback. */
  event_in_window: boolean;
  lookback_sessions: number;
};

export type GaugeInputs = {
  ticker: string;
  /** False → the single honest state "Not tracked — no gauge." */
  tracked: boolean;
  now: string;
  quant: GaugeQuantInput | null;
  detectors: GaugeDetectorInput | null;
  /** Nearest confirmed upcoming earnings; null when none is known. */
  next_earnings: GaugeEarningsInput | null;
  /** Open Base incidents on the ticker. */
  incidents: GaugeIncidentInput[];
  /** Tracker's r² floor (thresholds.lowR2Fallback) — read from one place, never duplicated in Gauge config. */
  r2_floor: number;
  /** Daily bars on file — names the gap when a quant field is null. */
  history_sessions: number | null;
  /** v2 §4: active Screen findings on this ticker (empty when Screen has nothing or has never scanned). */
  screen: GaugeScreenFinding[];
  /** False when the Screen store could not be read at all — the setup pool narrows honestly. */
  screen_available: boolean;
  /** v2: news/event context for the setup gates. */
  news: GaugeNewsContext;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type GaugeValue = number | string | boolean | null;

export type GaugeCheck = {
  key: GaugeCheckKey;
  number: number;
  label: string;
  status: GaugeStatus;
  /** One templated line — condition language only (§5). */
  reason: string;
  /** Appended disclosure (52w proximity, intraday-partial, direction unresolved…). */
  note: string | null;
  /** G2: 2–3 word label for caution/fail rows (null on pass / n_a). */
  short_label: string | null;
  /** Raw values the check read, for the panel. */
  values: Record<string, GaugeValue>;
};

export type GaugeSummary = {
  /** Checks not n_a. */
  evaluable: number;
  /** pass count among evaluable. */
  aligned: number;
  cautions: number;
  fails: number;
  unavailable: number;
  /** null only when the ticker is not tracked. */
  overall: GaugeOverall | null;
  /** The worst check (fail > caution; lower number wins ties); null when every evaluable check passes. */
  binding_check: GaugeCheckKey | null;
  /** The worst check's reason verbatim (or the all-aligned line). */
  binding_line: string;
  /** State + binding line, e.g. "blocked — earnings in 1 session — typical move 4.9%". */
  sentence: string;
  /** ≥ calibratingNaCount checks unavailable → banner instead of a thin readout. */
  calibrating: boolean;
  /** G3: one-sentence state tooltip (config template). */
  tooltip: string;
};

// ---------------------------------------------------------------------------
// v2 §1–§3: setup recognition, decision state, missing condition
// ---------------------------------------------------------------------------

export const GAUGE_SETUPS = [
  "coiled",
  "coiled_event_ahead",
  "quiet_drift",
  "confirmed_drift",
  "accumulation",
  "move_spent",
  "divergence",
  "regime_break",
  "unreadable",
  "event_wall",
  "no_setup",
] as const;
export type GaugeSetupKey = (typeof GAUGE_SETUPS)[number];

/**
 * §3. Four states, plus the context-mode verdict when a directional setup runs
 * against the thesis. `actionable` is the one decision word the language rules
 * allow, and its definition is fixed: conditions are consistent enough to test
 * a thesis. It never means "act".
 */
export const GAUGE_DECISION_STATES = ["actionable", "wait", "nothing_here", "unreadable", "contradicted_setup"] as const;
export type GaugeDecisionState = (typeof GAUGE_DECISION_STATES)[number];

export type GaugeSetup = {
  key: GaugeSetupKey;
  /** Hero label, e.g. "COILED" — descriptive, never a judgement. */
  name: string;
  /** One-sentence reading of the structure. */
  read: string;
  /**
   * Tape-pressure direction, for the context-mode contradiction test. Null on
   * direction-symmetric setups (coiled, event wall, accumulation) and on
   * MOVE SPENT, whose direction describes a move already delivered rather than
   * pressure now — "late" is not "contradicted".
   */
  direction: GaugeSignedDirection | null;
  /** Raw values the recognition read. */
  values: Record<string, GaugeValue>;
  /** Screen findings that fed the recognition (provenance). */
  screen: Array<{ pattern: GaugeScreenPattern; day_count: number; read: string }>;
};

/** §3: what is missing on a `wait`, always bound to a measurable threshold. */
export type GaugeMissing = {
  /** 2–4 word label, e.g. "volume confirmation". */
  label: string;
  /** The sentence, naming the threshold and the current value. */
  detail: string;
} | null;

export type GaugeReadout = {
  schema_version: number;
  ticker: string;
  tracked: boolean;
  mode: GaugeMode;
  context: GaugeContext | null;
  computed_at: string;
  /** Trading day the quant describes (null when unknown / untracked). */
  quant_as_of: string | null;
  /** v2 hero: the recognized structure. */
  setup: GaugeSetup;
  /** v2 decision frame. */
  state: GaugeDecisionState;
  /** v2 action line — non-null exactly when state is `wait`. */
  missing: GaugeMissing;
  /** Explains a state the setup line does not (today: the context contradiction); null otherwise. */
  state_line: string | null;
  /**
   * Whether residual-based reads are usable (r² ≥ Tracker's floor and the vol
   * regime is intact). False does not hide the structure — range and volume are
   * measurable without a market fit — it only qualifies it.
   */
  readable: boolean;
  /** The readability caveat when `readable` is false; null otherwise. */
  readability_note: string | null;
  /** v2 evidence (unchanged from v1). */
  checks: GaugeCheck[];
  summary: GaugeSummary;
};

/** §10: one line of the setup ledger, appended per (ticker, session, setup, state). */
export type GaugeSnapshot = {
  schema_version: number;
  /** Trading day the readout describes (quant_as_of). */
  session: string;
  /** When the line was written. */
  at: string;
  ticker: string;
  setup: GaugeSetupKey;
  state: GaugeDecisionState;
  direction: GaugeSignedDirection | null;
  readable: boolean;
  /** The few numbers the outcome study needs to normalise by. */
  values: Record<string, GaugeValue>;
};

/** Which surface asked — for the log-only daily counter (§7). */
export type GaugeSurface = "panel" | "drawer" | "stock" | "script" | "other";
