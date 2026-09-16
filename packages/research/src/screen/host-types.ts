/**
 * The shapes the Analyst host reports outward. They live beside the engine
 * because the desktop panel and the always-on engine service both read them,
 * and neither owns the definition.
 */

import type { ScreenFinding, ScreenPattern, ScreenScan } from "./types.js";

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
