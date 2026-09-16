/**
 * The shapes the Propagation host reports outward: the compact run row the
 * rails render, one cycle's outcome, and the live status block.
 *
 * They live beside the engine rather than in a consumer because the desktop
 * panel and the always-on engine service both read them, and neither owns the
 * definition. Pure types — safe to re-export through `contracts.ts`.
 */

import type {
  BreakerState as PropagationBreakerState,
  PropagationMetrics,
  RunStatus as PropagationRunStatus,
  RunSummary as PropagationRunSummary,
  EventDirection as PropagationDirection,
  Materiality as PropagationMateriality,
} from "./types.js";

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
  /** Event → signal wall-clock per lane, and the missed-fast-path rate (§S3b). */
  lanes: ReturnType<typeof import("./lane.js").summarizeLanes>;
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

