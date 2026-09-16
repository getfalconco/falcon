/**
 * Desktop-side mirror of the Analyst contracts so the renderer and main
 * process don't import the Node-only research package directly.
 * Keep in sync with packages/research/src/analyst/{types,service,store}.ts.
 */

export type AnalystRequestKind = "anomaly_review" | "scheduled_brief" | "structure_review";
export const ANALYST_REQUEST_KINDS: AnalystRequestKind[] = ["anomaly_review", "scheduled_brief", "structure_review"];

export type AnalystCause = "identified" | "partially_identified" | "unidentified";
export const ANALYST_CAUSES: AnalystCause[] = ["identified", "partially_identified", "unidentified"];

export type AnalystEdgeStatus = "no_edge" | "potential_edge" | "watch";
export const ANALYST_EDGE_STATUSES: AnalystEdgeStatus[] = ["no_edge", "potential_edge", "watch"];

export type AnalystReactionState = {
  basis: "residual" | "move" | "incomputable";
  realized_pct: number | null;
  realized_z: number | null;
  best_cause: {
    message_id: string;
    article_key: string;
    event_type: string;
    materiality: "high" | "standard" | "low";
    direction: "positive" | "negative" | "mixed" | "unclear";
    headline: string;
  } | null;
  tier_expectation_z: number | null;
  comparison: "exceeded" | "consistent" | "short_of" | "n_a";
  edge_default: "no_edge" | "watch" | "undetermined";
};

export type AnalystOutput = {
  schema_version: number;
  prompt_version: string;
  model: string;
  incident_id: string;
  request_id: string;
  kind: AnalystRequestKind;
  ticker: string;
  cause: AnalystCause;
  cause_summary: string;
  mechanism: string | null;
  evidence: string[];
  edge_status: AnalystEdgeStatus;
  edge_rationale: string | null;
  watch_trigger: string | null;
  status: "ok" | "failed";
  reaction_state: AnalystReactionState;
  edge_deviation: boolean;
  grounding_failed: boolean;
  failure_reason: string | null;
  produced_at: string;
  superseded_by: string | null;
  update: boolean;
  prior_request_id: string | null;
  attempts: number;
  latency_ms: number;
  retry_errors: string[];
};

/** An evidence id resolved against the source incident for display. */
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

export type AnalystBreakerState = {
  status: "closed" | "open";
  consecutive_failures: number;
  open_until: string | null;
  trips: number;
};

export type AnalystMetrics = {
  outputs_ok: number;
  outputs_failed: number;
  validation_failures: number;
  transport_failures: number;
  retries: number;
  breaker_trips: number;
  grounding_failed: number;
  edge_deviations: number;
  superseded: number;
  cache_hits: number;
  latencies_ms: number[];
  input_tokens: number;
  output_tokens: number;
  /** Counts by "kind|cause|edge_status". */
  by_cell: Record<string, number>;
};

/** What a dry run shows per request that would be sent. */
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
