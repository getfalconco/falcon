/**
 * Desktop-side mirror of the Risk Engine contracts so the renderer and main
 * process don't import the Node-only research package directly.
 * Keep in sync with packages/research/src/risk/{types,config}.ts.
 */

export type RiskComponentKey = "concentration" | "market" | "volatility" | "network" | "event" | "sharpe";
export const RISK_COMPONENT_KEYS: RiskComponentKey[] = ["concentration", "market", "volatility", "network", "event", "sharpe"];

export type RiskBand = "low" | "moderate" | "elevated" | "high";
export type RiskStrengthTier = "critical" | "important" | "marginal";
export type RiskAnomalyKind = "insider_cluster" | "unexplained_move" | "drift" | "filing_overdue";
export type RiskTriggerReason = "startup" | "manual" | "position_change" | "close_run" | "band_change" | "horizon_change" | "demo";

export type RiskWeight = { ticker: string; weight: number; market_value: number; side: "long" | "short" };

export type RiskDegraded = {
  ticker: string;
  field: "beta" | "vol" | "spy_vol" | "price" | "graph" | "quant" | "history" | "sharpe";
  substitute: number | string;
};

export type NetworkLink = {
  a: string;
  b: string;
  via: "direct" | "shared";
  category: string;
  tier: RiskStrengthTier;
  link: number;
  edge_id: string;
  edge_id_b: string | null;
  counterparty: string | null;
  counterparty_label: string | null;
  pair_weight: number;
  evidence_quote: string;
};

export type EventContributor = {
  ticker: string;
  kind: "incident" | RiskAnomalyKind | "earnings_window";
  detail: string;
  contribution: number;
  weighted: number;
};

export type RiskComponents = {
  concentration: { score: number; hhi: number; top: Array<{ ticker: string; weight: number }> };
  market: { score: number; beta_eff: number; beta_port: number };
  volatility: { score: number; port_vol_daily_pct: number; spy_vol_daily_pct: number; systematic_share: number };
  network: { score: number; linked_fraction: number; pair_count: number; excluded: string[]; top_links: NetworkLink[] };
  event: { score: number; raw: number; contributors: EventContributor[] };
  /**
   * §3.6. `score` and `sharpe` are null when the window is too short: the
   * component then leaves the blend and `blend_weights` renormalises over what
   * is left, rather than a neutral score being invented for it.
   */
  sharpe: {
    score: number | null;
    sharpe: number | null;
    sessions: number;
    ann_return_pct: number;
    ann_vol_pct: number;
    risk_free_pct: number;
    excluded: string[];
  };
};

export type RiskDriver = { component: RiskComponentKey; sentence: string; contribution: number };

export type RiskSnapshot = {
  schema_version: number;
  computed_at: string;
  account: "paper";
  trigger: RiskTriggerReason[];
  invested_fraction: number;
  position_count: number;
  score: number | null;
  band: RiskBand | null;
  components: RiskComponents | null;
  driver: RiskDriver | null;
  weights: RiskWeight[];
  blend_weights: Record<RiskComponentKey, number>;
  degraded: RiskDegraded[];
  graph_version: { generatedAt: string; pipelineVersion: number } | null;
  empty: boolean;
};

// RiskHistoryItem moved to @meridian/research/risk with the host; re-exported below.


/** What the renderer pushes to main whenever the paper account changes (§5). */
// RiskAccountPush moved to @meridian/research/risk with the host; re-exported below.


// RiskStatus moved to @meridian/research/risk with the host; re-exported below.


/** §8 card contract: the card reads the latest snapshot only. */
// RiskLatest moved to @meridian/research/risk with the host; re-exported below.

/**
 * Host-facing shapes moved to the engine package when the Risk host did — the
 * desktop panel and the always-on engine service both read them. Re-exported
 * here so the renderer keeps one import path.
 */
export type {
  RiskAccountPush,
  RiskHistoryItem,
  RiskLatest,
  RiskStatus,
} from "@meridian/research/risk";
