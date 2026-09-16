/**
 * Desktop-side mirror of the Gauge contracts so the renderer and main process
 * don't import the Node-only research package directly.
 * Keep in sync with packages/research/src/gauge/{types,config}.ts.
 */

export type GaugeCheckKey = "trend" | "regime" | "residual" | "volume" | "stretch" | "event_wall" | "conflict" | "freshness";
export type GaugeStatus = "pass" | "caution" | "fail" | "n_a";
export type GaugeOverall = "clear" | "mixed" | "blocked";
export type GaugeMode = "standalone" | "context";
export type GaugeDirection = "up" | "down";
export type GaugeContextSource = "propagation_target" | "incident" | "manual";
export type GaugePricingStatus = "open" | "partial" | "priced" | "contradicted" | "stale" | "unknown";
export type GaugeSurface = "panel" | "drawer" | "stock" | "script" | "other";

export type GaugeContext = {
  expected_direction: GaugeDirection | null;
  event_ts: string;
  source: GaugeContextSource;
  pricing_status?: GaugePricingStatus | null;
  sessions_since_event?: number | null;
  thesis_is_scheduled_event?: boolean;
};

export type GaugeValue = number | string | boolean | null;

export type GaugeCheck = {
  key: GaugeCheckKey;
  number: number;
  label: string;
  status: GaugeStatus;
  reason: string;
  note: string | null;
  /** G2: 2–3 word label for caution/fail rows. */
  short_label: string | null;
  values: Record<string, GaugeValue>;
};

export type GaugeSummary = {
  evaluable: number;
  aligned: number;
  cautions: number;
  fails: number;
  unavailable: number;
  overall: GaugeOverall | null;
  binding_check: GaugeCheckKey | null;
  binding_line: string;
  sentence: string;
  calibrating: boolean;
  /** G3: one-sentence state tooltip. */
  tooltip: string;
};

// --- v2 setup layer ---------------------------------------------------------

export type GaugeSetupKey =
  | "coiled"
  | "coiled_event_ahead"
  | "quiet_drift"
  | "confirmed_drift"
  | "accumulation"
  | "move_spent"
  | "divergence"
  | "regime_break"
  | "unreadable"
  | "event_wall"
  | "no_setup";

export type GaugeDecisionState = "actionable" | "wait" | "nothing_here" | "unreadable" | "contradicted_setup";

export const GAUGE_DECISION_STATES: GaugeDecisionState[] = ["actionable", "wait", "nothing_here", "unreadable", "contradicted_setup"];

export type GaugeScreenPattern = "quiet_accumulation" | "compression" | "independent_tape" | "insider_divergence";

export type GaugeSetup = {
  key: GaugeSetupKey;
  name: string;
  read: string;
  direction: GaugeDirection | null;
  values: Record<string, GaugeValue>;
  screen: Array<{ pattern: GaugeScreenPattern; day_count: number; read: string }>;
};

export type GaugeMissing = { label: string; detail: string } | null;

export type GaugeSnapshot = {
  schema_version: number;
  session: string;
  at: string;
  ticker: string;
  setup: GaugeSetupKey;
  state: GaugeDecisionState;
  direction: GaugeDirection | null;
  readable: boolean;
  values: Record<string, GaugeValue>;
};

export type GaugeReadout = {
  schema_version: number;
  ticker: string;
  tracked: boolean;
  mode: GaugeMode;
  context: GaugeContext | null;
  computed_at: string;
  quant_as_of: string | null;
  /** v2 hero. */
  setup: GaugeSetup;
  state: GaugeDecisionState;
  /** Non-null exactly when state is `wait`. */
  missing: GaugeMissing;
  /** Explains a state the setup line does not (the context contradiction). */
  state_line: string | null;
  readable: boolean;
  readability_note: string | null;
  /** v2 evidence. */
  checks: GaugeCheck[];
  summary: GaugeSummary;
};

export type GaugeReadoutRequest = {
  ticker: string;
  context?: GaugeContext | null;
  surface?: GaugeSurface;
  /** Bypass the memo (panel "recompute"). */
  fresh?: boolean;
};

export type GaugeReadoutResponse = {
  readout: GaugeReadout;
  /** Non-fatal gather problems (the readout still computed). */
  errors: string[];
  memo_hit: boolean;
};

export type GaugeDailyCounter = {
  day: string;
  total: number;
  by_surface: Record<string, number>;
  by_state: Record<string, number>;
  memo_hits: number;
};

export type GaugeStatusInfo = {
  dataDir: string;
  configFile: string;
  memoTtlMs: number;
  memoSize: number;
  calibratingNaCount: number;
  r2Floor: number;
  thresholds: Record<string, Record<string, number>>;
  trackedTickers: number;
  counters: GaugeDailyCounter;
  lastError: string | null;
  /** v2 §4: whether the Screen store could be read this session. */
  screenAvailable: boolean;
  screenFindings: number;
  /** v2 §10 setup ledger. */
  snapshots: { enabled: boolean; file: string; count: number; lastSession: string | null };
  setupOrder: GaugeSetupKey[];
};
