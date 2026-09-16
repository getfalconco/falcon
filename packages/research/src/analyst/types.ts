/**
 * Analyst contracts — spec v1.0.
 *
 * Analyst is the reasoning engine for primary-ticker anomalies. Given an
 * incident that Base routed to it, it produces a structured assessment: what
 * caused this (or that the cause is unknown), through what mechanism, whether
 * an information edge remains, and what specific trigger to watch next.
 *
 * Division of labor: Tracker measures, Base coordinates, Classifier labels,
 * Analyst reasons about the primary ticker, Propagation traverses the
 * network. Analyst never assigns directional claims to any ticker other than
 * the incident's own (§1).
 *
 * The model seam (`ModelCaller`), the breaker state and the metrics shape are
 * the Classifier's — same conventions, nothing invented.
 */

import type { MessageClassification } from "../base/classification.js";
import type { Incident } from "../base/types.js";
import type { Direction, Materiality } from "../classifier/types.js";

export type { BreakerState, ModelCallResult } from "../classifier/types.js";
import type { ModelCallResult } from "../classifier/types.js";

export const ANALYST_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Closed enums (§2, §4, §5)
// ---------------------------------------------------------------------------

export const ANALYST_REQUEST_KINDS = ["anomaly_review", "scheduled_brief", "structure_review"] as const;
export type AnalystRequestKind = (typeof ANALYST_REQUEST_KINDS)[number];

export const CAUSES = ["identified", "partially_identified", "unidentified"] as const;
export type Cause = (typeof CAUSES)[number];

export const EDGE_STATUSES = ["no_edge", "potential_edge", "watch"] as const;
export type EdgeStatus = (typeof EDGE_STATUSES)[number];

export const REACTION_BASES = ["residual", "move", "incomputable"] as const;
export type ReactionBasis = (typeof REACTION_BASES)[number];

export const COMPARISONS = ["exceeded", "consistent", "short_of", "n_a"] as const;
export type Comparison = (typeof COMPARISONS)[number];

export const EDGE_DEFAULTS = ["no_edge", "watch", "undetermined"] as const;
export type EdgeDefault = (typeof EDGE_DEFAULTS)[number];

export const OUTPUT_STATUSES = ["ok", "failed"] as const;
export type OutputStatus = (typeof OUTPUT_STATUSES)[number];

// ---------------------------------------------------------------------------
// §2 request
// ---------------------------------------------------------------------------

/**
 * What Base hands Analyst: the §6 routing envelope's identity and update
 * fields, the incident, and the per-message Classifier verdicts Base already
 * resolved (keyed by message id; messages without a verdict are absent).
 * Never user identity, holdings, watchlist or priority — assembly (§3) drops
 * the priority fields the wire incident carries before anything reaches the
 * prompt.
 */
export type AnalystRequest = {
  /** The Base routing_request id. */
  request_id: string;
  incident_id: string;
  kind: AnalystRequestKind;
  incident: Incident;
  /** §2 supersession: a newer request for an incident that already had one. */
  update: boolean;
  prior_request_id: string | null;
  requested_at: string;
  verdicts: Record<string, MessageClassification>;
};

// ---------------------------------------------------------------------------
// §4 reaction_state
// ---------------------------------------------------------------------------

export type BestCause = {
  message_id: string;
  article_key: string;
  event_type: string;
  materiality: Materiality;
  direction: Direction;
  headline: string;
};

export type ReactionState = {
  basis: ReactionBasis;
  realized_pct: number | null;
  realized_z: number | null;
  /** Highest-materiality direct verdict in the incident, if any. */
  best_cause: BestCause | null;
  tier_expectation_z: number | null;
  comparison: Comparison;
  edge_default: EdgeDefault;
};

// ---------------------------------------------------------------------------
// §5 output schema
// ---------------------------------------------------------------------------

/** What the model is asked to produce: the output minus the envelope Analyst fills in. */
export type ModelOutput = {
  cause: Cause;
  cause_summary: string;
  mechanism: string | null;
  /** Message ids (resolved from the prompt's short refs) — every one exists in the incident. */
  evidence: string[];
  edge_status: EdgeStatus;
  edge_rationale: string | null;
  watch_trigger: string | null;
};

export type AnalystOutput = ModelOutput & {
  schema_version: number;
  prompt_version: string;
  model: string;
  incident_id: string;
  request_id: string;
  kind: AnalystRequestKind;
  ticker: string;
  status: OutputStatus;
  /** The deterministic pre-computation the model interpreted (§4). */
  reaction_state: ReactionState;
  /** edge_status differs from a decisive edge_default (§4 — soft in Phase A). */
  edge_deviation: boolean;
  /** §5: cause downgraded to unidentified after repeated grounding failures. */
  grounding_failed: boolean;
  /** Validation/transport detail for `status: "failed"`; null when ok. */
  failure_reason: string | null;
  produced_at: string;
  /** §2: request_id of the newer output that replaced this one; null while current. */
  superseded_by: string | null;
  update: boolean;
  prior_request_id: string | null;
  attempts: number;
  latency_ms: number;
  /** Validator/transport errors of the attempts that were retried (§11 observability). */
  retry_errors: string[];
};

// ---------------------------------------------------------------------------
// Service surface (§8, §11)
// ---------------------------------------------------------------------------

export type AnalystMetrics = {
  outputs_ok: number;
  outputs_failed: number;
  /** Attempts that failed validation (each retry counted). */
  validation_failures: number;
  /** Attempts that failed on transport (each retry counted). */
  transport_failures: number;
  retries: number;
  breaker_trips: number;
  /** Outputs downgraded to unidentified after grounding failures (§5). */
  grounding_failed: number;
  /** Outputs whose edge_status deviated from a decisive edge_default (§4). */
  edge_deviations: number;
  /** Outputs marked superseded_by a newer one (§2). */
  superseded: number;
  /** Requests served from the store without a call (already produced). */
  cache_hits: number;
  /** Rolling window of call latencies in ms (bounded). */
  latencies_ms: number[];
  input_tokens: number;
  output_tokens: number;
  /** Counts by "kind|cause|edge_status". */
  by_cell: Record<string, number>;
};

/**
 * The one non-deterministic seam. Tests inject a fake; the real one is in
 * anthropic.ts. Same shape as the Classifier's caller plus `effort` — Fable 5
 * rejects sampling parameters, so the real caller does not forward
 * `temperature` (kept on the input for fixture logging and older models).
 */
export type ModelCaller = (input: {
  system: string;
  user: string;
  model: string;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  /** JSON schema the output must conform to (structured output mode). */
  output_schema: Record<string, unknown>;
  /** Reasoning depth for adaptive-thinking models (low … max). */
  effort: string;
  signal: AbortSignal;
}) => Promise<ModelCallResult>;

export class AnalystTransportError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AnalystTransportError";
  }
}

export class AnalystBreakerOpenError extends Error {
  constructor(readonly open_until: string) {
    super(`Analyst circuit breaker open until ${open_until}`);
    this.name = "AnalystBreakerOpenError";
  }
}
