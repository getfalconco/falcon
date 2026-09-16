/**
 * Propagation contracts — spec v1.0.
 *
 * Propagation is the engine of Falcon's core thesis: when a verified,
 * material event hits one company, walk the relationship graph and report
 * which connected companies the shock plausibly reaches next, through what
 * mechanism, and whether the market has already priced it there.
 *
 * Division of labor: Tracker measures, Base coordinates, Classifier labels,
 * Analyst reasons about the primary ticker, Propagation traverses the
 * network. Propagation never diagnoses the root event, never edits the graph,
 * and never names a target that is not in the graph (§1).
 *
 * The model seam (`ModelCaller`), breaker state and metrics shape follow the
 * Analyst's — same conventions, nothing invented.
 */

import type { Direction, EventType, Materiality, ModelCallResult } from "../../classifier/types.js";
import type { GraphEdge } from "../types.js";

export type { BreakerState, ModelCallResult } from "../../classifier/types.js";
export type {
  Direction as EventDirection,
  EventType as PropagationEventType,
  Materiality,
} from "../../classifier/types.js";

export const PROPAGATION_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Closed enums (§4–§7)
// ---------------------------------------------------------------------------

/** §4: forward edge categories as written, plus the reverse-only inversion. */
export const PROPAGATION_ROLES = [
  "supplier",
  "customer",
  "competitor",
  "partner",
  "dependency",
  "depended_on_by",
] as const;
export type PropagationRole = (typeof PROPAGATION_ROLES)[number];

export const STRENGTH_TIERS = ["critical", "important", "marginal"] as const;
export type StrengthTier = (typeof STRENGTH_TIERS)[number];

export const TRANSMITS = ["yes", "weak", "no"] as const;
export type Transmits = (typeof TRANSMITS)[number];

export const DIRECTION_RULES = ["same", "inverse", "unclear"] as const;
export type DirectionRule = (typeof DIRECTION_RULES)[number];

export const PROPAGATION_TIERS = ["strong", "moderate", "weak"] as const;
export type PropagationTier = (typeof PROPAGATION_TIERS)[number];

export const PRICING_STATUSES = ["open", "partial", "priced", "contradicted", "stale", "unknown"] as const;
export type PricingStatus = (typeof PRICING_STATUSES)[number];

export const PRICING_BASES = ["residual", "raw", "none"] as const;
export type PricingBasis = (typeof PRICING_BASES)[number];

export const STAGE2_VERDICTS = ["confirmed", "vetoed", "adjusted"] as const;
export type Stage2Verdict = (typeof STAGE2_VERDICTS)[number];

export const RUN_STATUSES = ["ok", "stage1_only", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const EVENT_SOURCES = ["verdict", "filing_item", "gap_cause"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

// ---------------------------------------------------------------------------
// §3 graph version
// ---------------------------------------------------------------------------

export type GraphVersion = {
  generatedAt: string;
  pipelineVersion: number;
};

// ---------------------------------------------------------------------------
// §2 event fed to a run
// ---------------------------------------------------------------------------

export type PropagationEvent = {
  type: EventType;
  direction: Direction;
  materiality: Materiality;
  /** Display label, control characters stripped. */
  label: string;
  /** Tracker message ids the event was resolved from. */
  source_msg_ids: string[];
  /** Instant the event is anchored on (reference-close selection, §6). */
  event_ts: string;
  source: EventSource;
  /** Evidence lines shipped to stage-2 (headlines / filing lines) — never prices. */
  evidence_lines: string[];
};

// ---------------------------------------------------------------------------
// §4 traversal output
// ---------------------------------------------------------------------------

export type TargetRelationship = {
  role: PropagationRole;
  subtype: string;
  tier: StrengthTier;
  confidence: number;
  evidence_quote: string;
  source_url: string;
  filing_date: string | null;
  /** Which side asserted it: the root's filing, the target's, or both. */
  via: "forward" | "reverse" | "both";
  /** The side whose edge supplies the primary evidence quote (the outranking edge). */
  evidence_via: "forward" | "reverse";
  /** Every graph edge merged into this relationship. */
  edge_ids: string[];
  /** Extra evidence merged from duplicate edges (§4 dedupe). */
  merged_evidence: Array<{ quote: string; source_url: string; edge_id: string }>;
};

/** One reachable counterparty before the matrix / pricing run. */
export type TraversalCandidate = {
  /** Stable identity: the ticker when known, else the graph's name id. */
  target: string;
  ticker: string | null;
  label: string;
  relationship: TargetRelationship;
};

export type TraversalResult = {
  root_ticker: string;
  candidates: TraversalCandidate[];
  /** Forward + reverse edges touched, before dedupe. */
  edges_seen: number;
  /** Forward edges skipped because the counterparty can never carry a price. */
  non_tradable?: number;
};

// ---------------------------------------------------------------------------
// §5 matrix
// ---------------------------------------------------------------------------

export type MatrixCell = {
  transmits: Transmits;
  direction: DirectionRule;
  note?: string;
};

export type TransmissionMatrix = Record<EventType, Record<PropagationRole, MatrixCell>>;

export type Transmission = {
  tier: PropagationTier;
  /** Resolved target direction — `unclear` is a first-class, honest value. */
  direction: Direction;
  matrix_cell: string;
  transmits: Exclude<Transmits, "no">;
  rule: DirectionRule;
  /**
   * Other roles the same entity holds toward the root, folded into this one
   * (§4a). Optional: runs stored before entity collapse have neither field.
   */
  also_roles?: PropagationRole[];
  /**
   * True when those roles read the matrix in opposite directions, which is why
   * `direction` is `unclear` here: one name cannot be both a long and a short
   * off one event, so no direction is called and pricing compares magnitude.
   */
  role_conflict?: boolean;
};

// ---------------------------------------------------------------------------
// §6 pricing
// ---------------------------------------------------------------------------

export type Pricing = {
  status: PricingStatus;
  /** Beta-adjusted residual move from the reference close (raw when basis = raw). */
  realized_resid_pct: number | null;
  /** daily_vol_30d × tier scale. */
  expected_pct: number | null;
  basis: PricingBasis;
  reference_close_ts: string | null;
  /** The math behind the status — for the drawer, never for the model. */
  reference_close: number | null;
  last_price: number | null;
  last_price_ts: string | null;
  realized_raw_pct: number | null;
  bench_move_pct: number | null;
  beta: number | null;
  /** |realized| / expected. */
  ratio: number | null;
  /** Sessions opened since the reference close. */
  sessions_elapsed: number | null;
  /**
   * What the reference is anchored on: "event" = the last minute print before
   * the event instant (the target's own reaction is isolated), "close" = the
   * previous regular close (no minute series reached the event).
   */
  anchor: "event" | "close";
  /** Move from the event instant to the last print — null without minute data. */
  since_event_pct: number | null;
  /** How much of that arrived in the first 30 minutes — the latency check. */
  first_30m_pct: number | null;
  /** Human-readable caveat (low-R² fallback, counter-move, missing vol…). */
  note: string | null;
};

// ---------------------------------------------------------------------------
// §7 stage-2
// ---------------------------------------------------------------------------

export type Stage2TargetResult = {
  verdict: Stage2Verdict;
  rationale: string | null;
  /** Direction the model resolved/adjusted to, when it did. */
  direction: Direction | null;
};

export type Stage2Envelope = {
  model: string;
  prompt_version: string;
  attempts: number;
  latency_ms: number;
  retry_errors: string[];
  /** Validation/transport detail when stage-2 was attempted and lost; null when ok. */
  failure_reason: string | null;
  /** Why stage-2 was not attempted (budget, breaker, unconfigured); null when attempted. */
  skipped_reason: string | null;
  input_tokens: number;
  output_tokens: number;
};

// ---------------------------------------------------------------------------
// §9 output schema
// ---------------------------------------------------------------------------

export type PropagationTarget = {
  target: string;
  ticker: string | null;
  label: string;
  tracked: boolean;
  relationship: TargetRelationship;
  transmission: Transmission;
  pricing: Pricing;
  /** ≤ 200 chars — the stage-1 template until stage-2 replaces it. */
  mechanism: string;
  stage2: Stage2TargetResult | null;
};

export type RunSummary = {
  targets: number;
  open: number;
  partial: number;
  priced: number;
  /**
   * Moved meaningfully AGAINST the transmitted direction (§6). Information,
   * not an error — and never folded into `priced`: a refuted thesis and an
   * absorbed one are different facts. Excluded from the no-edge test for the
   * same reason it is not `open`: nothing is left to absorb in the
   * transmitted direction.
   */
  contradicted: number;
  stale: number;
  untracked: number;
  /** Stage-2 vetoes (kept in the list, excluded from the counts above). */
  vetoed: number;
  /** Every reachable target priced or non-transmitting → the honest result. */
  no_edge: boolean;
};

export type PropagationRun = {
  schema_version: number;
  run_id: string;
  /** The Base incident the run belongs to. */
  incident_id: string;
  /** Deterministic request id (incident × best event). */
  request_id: string;
  /** Run id this run supersedes (§2 consolidation); null for the first run. */
  update_of: string | null;
  graph_version: GraphVersion;
  root_ticker: string;
  event: PropagationEvent;
  targets: PropagationTarget[];
  summary: RunSummary;
  status: RunStatus;
  stage2: Stage2Envelope | null;
  /** Transmitting targets dropped by max_targets (§4 overflow). */
  overflow: number;
  /** Reachable counterparties whose matrix cell was `no`. */
  non_transmitting: number;
  /** Reachable counterparties before any filtering. */
  reachable: number;
  /** Base routing rules / candidate trigger that dispatched the run. */
  trigger: { rules: string[]; priority_band: string };
  produced_at: string;
  /** run_id of the newer run that replaced this one; null while current. */
  superseded_by: string | null;
  update: boolean;
  /** Validation/transport detail for `status: "failed"`; null otherwise. */
  failure_reason: string | null;
  /**
   * True for fixture / synthetic runs (seeded from test fixtures, not from the
   * live Base stream). Kept out of the live run list and the rubric.
   */
  synthetic: boolean;
};

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export type PropagationMetrics = {
  runs_ok: number;
  runs_stage1_only: number;
  runs_failed: number;
  targets_total: number;
  open_total: number;
  partial_total: number;
  priced_total: number;
  /** §11 calibration signal: a high contradicted-rate says the matrix directions are wrong. */
  contradicted_total: number;
  untracked_total: number;
  no_edge_runs: number;
  vetoes: number;
  /** Targets stage-1 left `unclear` that stage-2 resolved. */
  unclear_resolved: number;
  unclear_total: number;
  /** Structural rejections: the model named a target outside the candidate list. */
  added_target_rejections: number;
  validation_failures: number;
  transport_failures: number;
  retries: number;
  breaker_trips: number;
  superseded: number;
  cache_hits: number;
  latencies_ms: number[];
  /**
   * Event → run wall-clock, split by the lane the run took (§S3b). Distinct
   * from `latencies_ms`, which times the model call: this is what a reader
   * experiences, and it is the number the "make it consistent" ask is about.
   */
  fast_path_runs: number;
  cycle_runs: number;
  /** Eligible for the fast path, produced by the cycle anyway — a missed lane. */
  fast_path_missed: number;
  fast_path_latencies_ms: number[];
  cycle_latencies_ms: number[];
  input_tokens: number;
  output_tokens: number;
  /** Counts by "event_type|role|transmits". */
  by_cell: Record<string, number>;
};

/**
 * The one non-deterministic seam. Tests inject a fake; the real one is in
 * anthropic.ts (the Analyst's Fable 5 caller shape).
 */
export type ModelCaller = (input: {
  system: string;
  user: string;
  model: string;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  output_schema: Record<string, unknown>;
  effort: string;
  signal: AbortSignal;
}) => Promise<ModelCallResult>;

export class PropagationBreakerOpenError extends Error {
  constructor(readonly open_until: string) {
    super(`Propagation circuit breaker open until ${open_until}`);
    this.name = "PropagationBreakerOpenError";
  }
}

/** Re-exported so engine consumers do not reach into the legacy types module. */
export type { GraphEdge };
