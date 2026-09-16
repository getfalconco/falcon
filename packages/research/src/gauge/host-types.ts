/**
 * The shapes the Gauge host takes and reports — the readout request, its
 * answer, and the status block. They live beside the engine because the
 * desktop panel and the always-on engine service both read them.
 */

import type { GaugeContext, GaugeReadout, GaugeSetupKey, GaugeSurface } from "./types.js";
import type { GaugeDailyCounter } from "./memo.js";

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
