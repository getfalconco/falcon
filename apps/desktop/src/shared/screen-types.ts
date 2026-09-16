/**
 * Desktop-side mirror of the Screen contracts so the renderer and main
 * process don't import the Node-only research package directly.
 * Keep in sync with packages/research/src/screen/{types,config}.ts.
 */

export const SCREEN_PATTERNS = ["quiet_accumulation", "compression", "independent_tape", "insider_divergence"] as const;
export type ScreenPattern = (typeof SCREEN_PATTERNS)[number];
export type ScreenFindingState = "new" | "continuing" | "ended";
export type ScreenModifier = "near_52w_high" | "near_52w_low";
export type ScreenValue = number | string | boolean | null;
export type ScreenEndedReason = "condition_false" | "not_evaluable" | "untracked";
export type ScreenScanTrigger = "startup" | "close_run" | "manual" | "script";

export type ScreenSessionView = {
  d: string;
  close: number;
  volume: number;
  ret: number | null;
  bench_ret: number | null;
  volume_ratio: number | null;
  residual_move: number | null;
  residual_z: number | null;
};

export type ScreenFinding = {
  id: string;
  schema_version: number;
  ticker: string;
  pattern: ScreenPattern;
  state: ScreenFindingState;
  day_count: number;
  first_session: string;
  last_evaluated: string;
  sessions: string[];
  values: Record<string, ScreenValue>;
  modifiers: ScreenModifier[];
  qualifying_sessions: string[];
  sessions_view: ScreenSessionView[];
  read: string;
  ended_at: string | null;
  ended_reason: ScreenEndedReason | null;
  /** S1: instant this finding was emitted to Base; null/absent when it never was. */
  emitted_at?: string | null;
};

export type ScreenDegraded = {
  ticker: string;
  pattern: ScreenPattern | "all";
  reason: string;
  history_sessions: number | null;
};

export type ScreenScan = {
  schema_version: number;
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

/** §8 minimal contract for later surfaces. */
export type ScreenActiveFinding = {
  ticker: string;
  pattern: ScreenPattern;
  day_count: number;
  read: string;
};

/** S1 — a `tape_structure` message as the panel sees it. */
export type ScreenEmittedMessage = {
  id: string;
  type: "tape_structure";
  ticker: string;
  timestamp: string;
  source_engine: "screen";
  payload: {
    pattern: ScreenPattern;
    finding_id: string;
    first_session: string;
    session: string;
    day_count: number;
    read: string;
    since_first: { covered_from: string | null; sessions: number; ret: number | null; residual_z_cum: number | null };
  };
};

export type ScreenFindingsPayload = {
  /** Active first (day_count desc, then pattern priority), then ended (newest end first). */
  active: ScreenFinding[];
  ended: ScreenFinding[];
  last_scan: ScreenScan | null;
  labels: Record<ScreenPattern, string>;
  /** Pattern → panel priority (sort tie-break). */
  priority: Record<ScreenPattern, number>;
};

/** S1 — the emit channel's state, for the panel's header. */
export type ScreenEmitStatus = {
  enabled: boolean;
  dailyEmitCap: number;
  emittedTotal: number;
  lastEmit: { session: string; at: string; emitted: number; eligible: number; capped: number } | null;
  watchlistSize: number;
};

export type ScreenStatus = {
  dataDir: string;
  configFile: string;
  findingsFile: string;
  patterns: Record<ScreenPattern, { enabled: boolean; priority: number }>;
  retentionDays: number;
  pollIntervalMs: number;
  scanCount: number;
  lastScan: ScreenScan | null;
  lastPollAt: string | null;
  lastError: string | null;
  /** S1 — the emit channel. */
  emit: ScreenEmitStatus;
  /** Close-run fingerprint the host last observed. */
  keys: { session: string; landed: number; total: number } | null;
  r2Floor: number | null;
};

