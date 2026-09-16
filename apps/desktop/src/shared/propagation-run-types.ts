/**
 * Desktop-side mirror of the Propagation engine contracts so the renderer and
 * main process don't import the Node-only research package directly.
 * Keep in sync with packages/research/src/propagation/engine/{types,service,store}.ts.
 */

export type PropagationRole = "supplier" | "customer" | "competitor" | "partner" | "dependency" | "depended_on_by";
export const PROPAGATION_ROLES: PropagationRole[] = ["supplier", "customer", "competitor", "partner", "dependency", "depended_on_by"];

export type PropagationDirection = "positive" | "negative" | "mixed" | "unclear";
export type PropagationMateriality = "high" | "standard" | "low";
export type PropagationStrengthTier = "critical" | "important" | "marginal";
export type PropagationTier = "strong" | "moderate" | "weak";
export type PricingStatus = "open" | "partial" | "priced" | "contradicted" | "stale" | "unknown";
export const PRICING_STATUSES: PricingStatus[] = ["open", "partial", "priced", "contradicted", "stale", "unknown"];
export type Stage2Verdict = "confirmed" | "vetoed" | "adjusted";
export type PropagationRunStatus = "ok" | "stage1_only" | "failed";

export type PropagationEvent = {
  type: string;
  direction: PropagationDirection;
  materiality: PropagationMateriality;
  label: string;
  source_msg_ids: string[];
  event_ts: string;
  source: "verdict" | "filing_item" | "gap_cause";
  evidence_lines: string[];
};

export type TargetRelationship = {
  role: PropagationRole;
  subtype: string;
  tier: PropagationStrengthTier;
  confidence: number;
  evidence_quote: string;
  source_url: string;
  filing_date: string | null;
  via: "forward" | "reverse" | "both";
  evidence_via: "forward" | "reverse";
  edge_ids: string[];
  merged_evidence: Array<{ quote: string; source_url: string; edge_id: string }>;
};

export type Transmission = {
  tier: PropagationTier;
  direction: PropagationDirection;
  matrix_cell: string;
  transmits: "yes" | "weak";
  rule: "same" | "inverse" | "unclear";
  /** Other roles the same entity holds toward the root, folded into this one. */
  also_roles?: PropagationRole[];
  /** Those roles read opposite directions — which is why direction is unclear. */
  role_conflict?: boolean;
};

export type Pricing = {
  status: PricingStatus;
  realized_resid_pct: number | null;
  expected_pct: number | null;
  basis: "residual" | "raw" | "none";
  reference_close_ts: string | null;
  reference_close: number | null;
  last_price: number | null;
  last_price_ts: string | null;
  realized_raw_pct: number | null;
  bench_move_pct: number | null;
  beta: number | null;
  ratio: number | null;
  sessions_elapsed: number | null;
  /** "event" = anchored on the minute print before the event; "close" = prior close. */
  anchor: "event" | "close";
  since_event_pct: number | null;
  first_30m_pct: number | null;
  note: string | null;
};

export type Stage2TargetResult = {
  verdict: Stage2Verdict;
  rationale: string | null;
  direction: PropagationDirection | null;
};

export type Stage2Envelope = {
  model: string;
  prompt_version: string;
  attempts: number;
  latency_ms: number;
  retry_errors: string[];
  failure_reason: string | null;
  skipped_reason: string | null;
  input_tokens: number;
  output_tokens: number;
};

export type PropagationTarget = {
  target: string;
  ticker: string | null;
  label: string;
  tracked: boolean;
  relationship: TargetRelationship;
  transmission: Transmission;
  pricing: Pricing;
  mechanism: string;
  stage2: Stage2TargetResult | null;
};

export type PropagationRunSummary = {
  targets: number;
  open: number;
  partial: number;
  priced: number;
  /** Moved meaningfully against the transmitted direction — never folded into priced. */
  contradicted: number;
  stale: number;
  untracked: number;
  vetoed: number;
  no_edge: boolean;
};

export type PropagationRun = {
  schema_version: number;
  run_id: string;
  incident_id: string;
  request_id: string;
  update_of: string | null;
  graph_version: { generatedAt: string; pipelineVersion: number };
  root_ticker: string;
  event: PropagationEvent;
  targets: PropagationTarget[];
  summary: PropagationRunSummary;
  status: PropagationRunStatus;
  stage2: Stage2Envelope | null;
  overflow: number;
  non_transmitting: number;
  reachable: number;
  trigger: { rules: string[]; priority_band: string };
  produced_at: string;
  superseded_by: string | null;
  update: boolean;
  failure_reason: string | null;
  /** Fixture / synthetic run — never in the live list or the rubric. */
  synthetic: boolean;
};

/** Compact row for the run list (left rail). */
export type PropagationRunListItem = {
  run_id: string;
  incident_id: string;
  root_ticker: string;
  event_label: string;
  event_type: string;
  event_direction: PropagationDirection;
  event_materiality: PropagationMateriality;
  produced_at: string;
  event_ts: string;
  status: PropagationRunStatus;
  summary: PropagationRunSummary;
  superseded: boolean;
  update: boolean;
  stage2_state: "ok" | "failed" | "skipped" | "none";
  /**
   * Mean priced-in progress of the run's tracked targets, 0–1 (see
   * `runAbsorption`); null when nothing is measurable. Optional so fixtures
   * and older callers still type-check — readers fall back to the counts.
   */
  absorption?: number | null;
  /**
   * Mean signed priced-in share of the run's measurable targets (see
   * `runPricedIn`): negative against the call, 1 the whole of it, null when
   * nothing on the run can be measured. Optional so older callers still type.
   */
  priced_in?: number | null;
  synthetic: boolean;
};

export type PropagationBreakerState = {
  status: "closed" | "open";
  consecutive_failures: number;
  open_until: string | null;
  trips: number;
};

export type PropagationMetrics = {
  runs_ok: number;
  runs_stage1_only: number;
  runs_failed: number;
  targets_total: number;
  open_total: number;
  partial_total: number;
  priced_total: number;
  contradicted_total: number;
  untracked_total: number;
  no_edge_runs: number;
  vetoes: number;
  unclear_resolved: number;
  unclear_total: number;
  added_target_rejections: number;
  validation_failures: number;
  transport_failures: number;
  retries: number;
  breaker_trips: number;
  superseded: number;
  cache_hits: number;
  latencies_ms: number[];
  input_tokens: number;
  output_tokens: number;
  by_cell: Record<string, number>;
};

export type PropagationRunCycleSummary = {
  started_at: string;
  finished_at: string;
  messages_scanned: number;
  incidents_replayed: number;
  requests_built: number;
  already_produced: number;
  updates: number;
  no_event: number;
  below_band: number;
  dispatched: number;
  stage2_calls: number;
  stage2_deferred_by_budget: number;
  ok: number;
  stage1_only: number;
  failed: number;
  cache_hits: number;
  skipped: number;
  superseded: number;
  errors: string[];
  dry_run: boolean;
};

export type PropagationStatus = {
  enabled: boolean;
  configured: boolean;
  running: boolean;
  surfacing_enabled: boolean;
  model: string;
  prompt_version: string;
  effort: string;
  timeout_ms: number;
  concurrency: number;
  cycle_interval_ms: number;
  next_cycle_at: string | null;
  breaker: PropagationBreakerState;
  metrics: PropagationMetrics;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  estimated_spend_usd: number;
  budget: { day: string; used: number; remaining: number; daily: number };
  dispatch_min_band: string;
  max_targets: number;
  graph: { generatedAt: string; pipelineVersion: number; edges: number; path: string } | null;
  tracked_tickers: number;
  run_count: number;
  current_count: number;
  open_runs: number;
  permanent_failures: number;
  last_run: PropagationRunCycleSummary | null;
  data_dir: string;
  config_file: string;
};

/** One session of a target's reaction — see `absorptionCurve` in the engine. */
export type AbsorptionPoint = {
  session: number;
  date: string;
  close: number;
  raw_pct: number;
  bench_pct: number | null;
  residual_pct: number;
  multiple: number | null;
};
