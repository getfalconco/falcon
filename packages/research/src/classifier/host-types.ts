/**
 * The shapes the Classifier host reports outward — one cycle's outcome and the
 * live status block. They live here rather than in a consumer because both the
 * desktop panel and the always-on engine service read them, and neither owns
 * the definition.
 */

import type { BreakerState, ClassifierMetrics } from "./types.js";

export type ClassifierRunSummary = {
  started_at: string;
  finished_at: string;
  /** Messages scanned from the Tracker log. */
  messages_scanned: number;
  requests_built: number;
  covered: number;
  overflows: number;
  dispatched: number;
  deferred_by_budget: number;
  ok: number;
  failed: number;
  cache_hits: number;
  merged: number;
  skipped: number;
  errors: string[];
  dry_run: boolean;
};

export type ClassifierStatus = {
  /** Master switch for the live Phase A loop (config.enabled). */
  enabled: boolean;
  /** ANTHROPIC_API_KEY present where the host runs. */
  configured: boolean;
  /** A cycle is in progress right now. */
  running: boolean;
  /** Phase B: Base applies the re-score mapping. */
  rescore_enabled: boolean;
  model: string;
  prompt_version: string;
  cycle_interval_ms: number;
  next_cycle_at: string | null;
  breaker: BreakerState;
  metrics: ClassifierMetrics;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  estimated_spend_usd: number;
  budget: { day: string; used: number; remaining: number; daily: number };
  verdict_count: number;
  /** Grouped error shapes behind the failure count, most frequent first. */
  failure_reasons: Array<{ reason: string; count: number }>;
  permanent_failures: number;
  metadata_rows: number;
  last_run: ClassifierRunSummary | null;
  data_dir: string;
};
