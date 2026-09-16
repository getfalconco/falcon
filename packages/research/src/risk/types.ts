/**
 * Risk Engine — contracts (spec v1.0).
 *
 * A deterministic portfolio risk index (0–100, higher = riskier) for the
 * user's paper account, decomposed into five named components with the top
 * driver expressed as one plain sentence. Description of posture, not advice:
 * every number traces to Tracker state, the relationship graph, the paper
 * account, or the incident replay. No LLM, no external fetches.
 */

import type { GraphIndex } from "../propagation/engine/graph.js";
import type { RiskBar } from "./sharpe.js";

export type { RiskBar } from "./sharpe.js";

export const RISK_SCHEMA_VERSION = 1;

export const RISK_COMPONENT_KEYS = ["concentration", "market", "volatility", "network", "event", "sharpe"] as const;
export type RiskComponentKey = (typeof RISK_COMPONENT_KEYS)[number];

export const RISK_BANDS = ["low", "moderate", "elevated", "high"] as const;
export type RiskBand = (typeof RISK_BANDS)[number];

export type RiskStrengthTier = "critical" | "important" | "marginal";
export type RiskPriorityBand = "P0" | "P1" | "P2" | "P3";

export const RISK_ANOMALY_KINDS = ["insider_cluster", "unexplained_move", "drift", "filing_overdue"] as const;
export type RiskAnomalyKind = (typeof RISK_ANOMALY_KINDS)[number];

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One paper-account position as the engine receives it. */
export type RiskPositionInput = {
  ticker: string;
  /** Signed: positive long, negative short. */
  shares: number;
  /** Signed cash basis (paper-account convention). */
  cost_usd: number;
  /**
   * Market value when the caller already knows it; null lets the engine price
   * the position from Tracker's last price (cost basis as the degraded
   * fallback).
   */
  market_value: number | null;
};

export type RiskAccountInput = {
  account: "paper";
  cash: number;
  positions: RiskPositionInput[];
  /** When the account snapshot was taken (renderer push time); null = unknown. */
  as_of: string | null;
};

/** Per-ticker quant as persisted by the Tracker close-run (null = not tracked). */
export type RiskQuantInput = {
  beta: number | null;
  r2: number | null;
  /** Robust 30-session daily vol as a fraction (0.02 = 2%). */
  daily_vol: number | null;
  /** Mean |1-day earnings move| as a fraction; null when < 2 observations. */
  earnings_rhythm: number | null;
  /** Last price the Tracker knows for the ticker; used to value positions. */
  last_price: number | null;
};

export type RiskOpenIncident = {
  ticker: string;
  band: RiskPriorityBand;
  incident_id: string;
};

export type RiskAnomaly = {
  ticker: string;
  kind: RiskAnomalyKind;
};

export type RiskScheduledEarnings = {
  ticker: string;
  due_at: string;
  /** Trading sessions from today's NY date to the due date (0 = today). */
  sessions_until: number;
  fiscal_period: string | null;
};

export type RiskLiveInput = {
  open_incidents: RiskOpenIncident[];
  anomalies: RiskAnomaly[];
  earnings: RiskScheduledEarnings[];
};

export type RiskInputs = {
  /** Evaluation instant (ISO). */
  now: string;
  account: RiskAccountInput;
  /** Keyed by upper-case ticker; null/missing = Tracker has no state for it. */
  quant: Record<string, RiskQuantInput | null>;
  /** Benchmark (SPY) robust daily vol as a fraction. */
  spy_daily_vol: number | null;
  /** Median daily vol across the tracked universe (the vol substitute). */
  universe_median_vol: number | null;
  graph: GraphIndex | null;
  live: RiskLiveInput;
  /**
   * Daily closes per held ticker (§3.6). Only the Sharpe component reads them;
   * everything else works off the Tracker's precomputed quant.
   */
  bars: Record<string, RiskBar[]>;
};

// ---------------------------------------------------------------------------
// Snapshot (output)
// ---------------------------------------------------------------------------

export type RiskWeight = {
  ticker: string;
  /** Share of invested (absolute) market value. */
  weight: number;
  market_value: number;
  side: "long" | "short";
};

export type RiskDegraded = {
  ticker: string;
  field: "beta" | "vol" | "spy_vol" | "price" | "graph" | "quant" | "history" | "sharpe";
  /** What the engine used instead (number, or a label such as "excluded"). */
  substitute: number | string;
};

export type ConcentrationPayload = {
  score: number;
  hhi: number;
  top: Array<{ ticker: string; weight: number }>;
};

export type MarketPayload = {
  score: number;
  /** Σ w·β × invested_fraction (absolute value, shorts reduce it). */
  beta_eff: number;
  /** Σ w·β over invested value only (signed). */
  beta_port: number;
};

export type VolatilityPayload = {
  score: number;
  /** σ_p in daily percent (2.1 = 2.1%). */
  port_vol_daily_pct: number;
  spy_vol_daily_pct: number;
  /** Systematic and idiosyncratic shares of σ_p² (sum to 1 when σ_p > 0). */
  systematic_share: number;
};

export type NetworkLinkVia = "direct" | "shared";

export type NetworkLink = {
  a: string;
  b: string;
  via: NetworkLinkVia;
  category: string;
  tier: RiskStrengthTier;
  /** Pairwise link score l_ij in [0,1]. */
  link: number;
  /** Direct: the filing edge. Shared: the a-side edge (b-side in `edge_id_b`). */
  edge_id: string;
  edge_id_b: string | null;
  /** Shared counterparty key/label when via = shared. */
  counterparty: string | null;
  counterparty_label: string | null;
  /** Position-weight product w_a·w_b — how much of the book this pair is. */
  pair_weight: number;
  evidence_quote: string;
};

export type NetworkPayload = {
  score: number;
  linked_fraction: number;
  /** Pairs actually scored (both tickers present in the graph). */
  pair_count: number;
  /** Tickers excluded because the graph does not know them. */
  excluded: string[];
  top_links: NetworkLink[];
};

export type EventContributorKind = "incident" | RiskAnomalyKind | "earnings_window";

export type EventContributor = {
  ticker: string;
  kind: EventContributorKind;
  /** Human detail: "P1", "2 sessions", "sell cluster". */
  detail: string;
  /** Unweighted contribution (config points). */
  contribution: number;
  /** w_i × contribution. */
  weighted: number;
};

export type EventPayload = {
  score: number;
  /** Σ w_i × contrib_i before the anchor map. */
  raw: number;
  contributors: EventContributor[];
};

export type SharpePayload = {
  /**
   * null when the window is too short (a fresh ticker, a fresh install) — the
   * component then drops out of the blend and the remaining weights are
   * renormalised, rather than a neutral score being invented for it.
   */
  score: number | null;
  /** Annualised Sharpe of the current allocation over `sessions` sessions. */
  sharpe: number | null;
  sessions: number;
  ann_return_pct: number;
  ann_vol_pct: number;
  /** The config's risk-free assumption, carried so it can be seen. */
  risk_free_pct: number;
  /** Held tickers left out for want of aligned history (weights renormalised). */
  excluded: string[];
};

export type RiskComponents = {
  concentration: ConcentrationPayload;
  market: MarketPayload;
  volatility: VolatilityPayload;
  network: NetworkPayload;
  event: EventPayload;
  sharpe: SharpePayload;
};

export type RiskDriver = {
  component: RiskComponentKey;
  sentence: string;
  /** score × weight, the value the driver was picked on. */
  contribution: number;
};

export const RISK_TRIGGER_REASONS = [
  "startup",
  "manual",
  "position_change",
  "close_run",
  "band_change",
  "horizon_change",
  /** Ad-hoc snapshot for the renderer's demo (Ctrl+P) portfolio — never persisted. */
  "demo",
] as const;
export type RiskTriggerReason = (typeof RISK_TRIGGER_REASONS)[number];

export type RiskSnapshot = {
  schema_version: number;
  computed_at: string;
  account: "paper";
  /** Why this snapshot was computed. */
  trigger: RiskTriggerReason[];
  invested_fraction: number;
  position_count: number;
  /** Present when empty = false. */
  score: number | null;
  band: RiskBand | null;
  components: RiskComponents | null;
  driver: RiskDriver | null;
  weights: RiskWeight[];
  /**
   * The weights actually used, renormalised over the components that produced
   * a score — so score = Σ component × blend_weight exactly, whatever dropped
   * out.
   */
  blend_weights: Record<RiskComponentKey, number>;
  degraded: RiskDegraded[];
  graph_version: { generatedAt: string; pipelineVersion: number } | null;
  empty: boolean;
};

/** Trimmed row for the history list / trend sparkline. */
export type RiskHistoryItem = {
  computed_at: string;
  score: number | null;
  band: RiskBand | null;
  driver_component: RiskComponentKey | null;
  driver_sentence: string | null;
  trigger: RiskTriggerReason[];
  empty: boolean;
};
