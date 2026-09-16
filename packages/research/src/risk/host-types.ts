/**
 * The shapes the Risk host reports outward, and the one it is fed.
 *
 * They live beside the engine because the desktop panel and the always-on
 * engine service both read them, and neither owns the definition.
 */

// RiskHistoryItem is already the engine’s own type — this file adds only the
// shapes that did not exist before the host had a public surface.
import type { RiskComponentKey, RiskSnapshot } from "./types.js";


/** What the renderer pushes whenever the paper account changes (§5). */
export type RiskAccountPush = {
  account: "paper";
  cash: number;
  positions: Array<{ ticker: string; shares: number; cost_usd: number; market_value: number | null }>;
  as_of: string;
  /**
   * Ctrl+P demo overlay: the host computes an immediate, in-memory snapshot
   * for it and never writes it to account.json or the history.
   */
  demo?: boolean;
};

export type RiskStatus = {
  dataDir: string;
  configFile: string;
  riskCardEnabled: boolean;
  weights: Record<RiskComponentKey, number>;
  debounceMs: number;
  pollIntervalMs: number;
  historyRetentionDays: number;
  snapshotCount: number;
  latestComputedAt: string | null;
  lastPollAt: string | null;
  lastError: string | null;
  account: { received: boolean; as_of: string | null; positions: number; cash: number };
  /** The current trigger fingerprint (debug). */
  keys: { close: string; bands: string; horizon: string } | null;
};

/** §8 card contract: the card reads the latest snapshot only. */
export type RiskLatest = {
  snapshot: RiskSnapshot | null;
  riskCardEnabled: boolean;
  /** True while the snapshot describes the demo (Ctrl+P) portfolio. */
  demo?: boolean;
};
