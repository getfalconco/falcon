/**
 * The shapes the Analyst host reports outward. They live beside the engine
 * because the desktop panel and the always-on engine service both read them,
 * and neither owns the definition.
 */

import type {
  AnalystMetrics,
  AnalystOutput,
  AnalystRequestKind,
  BreakerState as AnalystBreakerState,
  ReactionState as AnalystReactionState,
} from "./types.js";

export type AnalystEvidenceLine = {
  message_id: string;
  type: string;
  timestamp: string;
  line: string;
};

export type AnalystOutputDetail = {
  output: AnalystOutput;
  evidence: AnalystEvidenceLine[];
  /** Other outputs for the same incident, oldest first (supersession chain). */
  chain: Array<{ request_id: string; produced_at: string; status: "ok" | "failed"; superseded_by: string | null }>;
  incident_found: boolean;
};

export type AnalystRequestPreview = {
  request_id: string;
  incident_id: string;
  ticker: string;
  kind: AnalystRequestKind;
  update: boolean;
  priority_band: string;
  message_count: number;
  anomaly_types: string[];
  news_lines: number;
  news_excluded: number;
  reaction_state: AnalystReactionState;
  prompt_chars: number;
};

export type AnalystRunSummary = {
  started_at: string;
  finished_at: string;
  messages_scanned: number;
  incidents_replayed: number;
  analyst_incidents: number;
  requests_built: number;
  already_produced: number;
  updates: number;
  dispatched: number;
  deferred_by_budget: number;
  ok: number;
  downgraded: number;
  failed: number;
  cache_hits: number;
  skipped: number;
  superseded: number;
  errors: string[];
  dry_run: boolean;
  preview: AnalystRequestPreview[];
};

export type AnalystStatus = {
  /** Master switch for the live Phase A loop (config.enabled). */
  enabled: boolean;
  /** ANTHROPIC_API_KEY present in the main process. */
  configured: boolean;
  running: boolean;
  /** Phase B gate — stays false until the rubric gate passes. */
  surfacing_enabled: boolean;
  model: string;
  prompt_version: string;
  effort: string;
  timeout_ms: number;
  concurrency: number;
  cycle_interval_ms: number;
  next_cycle_at: string | null;
  breaker: AnalystBreakerState;
  metrics: AnalystMetrics;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  estimated_spend_usd: number;
  budget: {
    day: string;
    used: number;
    remaining: number;
    daily: number;
    /** S2: the slice spent on Screen-driven structure reviews, and its sub-cap. */
    structure_used: number;
    structure_remaining: number;
    structure_cap: number;
  };
  output_count: number;
  current_count: number;
  permanent_failures: number;
  active_incidents: number;
  last_run: AnalystRunSummary | null;
  data_dir: string;
  config_file: string;
};
