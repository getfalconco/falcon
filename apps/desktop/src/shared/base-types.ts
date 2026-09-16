/**
 * Desktop-side mirror of the Base Engine contracts so the renderer and main
 * process don't import the Node-only research package directly.
 * Keep in sync with packages/research/src/base/{types,replay}.ts.
 */

import type { TrackerMessage, TrackerQuantContext } from "./tracker-types";

export const BASE_SCHEMA_VERSION = 1;

export type BaseCompositeTag =
  | "earnings_surprise"
  | "insider_confirmation"
  | "silent_accumulation"
  | "insider_divergence"
  | "insider_distribution"
  | "standalone_insider_cluster"
  | "disclosure_risk"
  | "unexplained_activity"
  | "pre_earnings_silence"
  | "volume_without_price"
  | "event_gap"
  | "explained_move";

export const BASE_COMPOSITE_TAGS: BaseCompositeTag[] = [
  "earnings_surprise",
  "insider_confirmation",
  "silent_accumulation",
  "insider_divergence",
  "insider_distribution",
  "standalone_insider_cluster",
  "disclosure_risk",
  "unexplained_activity",
  "pre_earnings_silence",
  "volume_without_price",
  "event_gap",
  "explained_move",
];

export type BasePriorityBand = "P0" | "P1" | "P2" | "P3";
export const BASE_PRIORITY_BANDS: BasePriorityBand[] = ["P0", "P1", "P2", "P3"];

export type BaseRoutingDestination =
  | "classifier"
  | "propagation"
  | "extraction"
  | "analyst"
  | "scheduler";

export type BaseDestinationKey = BaseRoutingDestination | "store_only";
export const BASE_DESTINATIONS: BaseDestinationKey[] = [
  "analyst",
  "propagation",
  "classifier",
  "extraction",
  "scheduler",
  "store_only",
];

export type BaseUserProximity = "held" | "watchlist" | "tracked";

export type BaseIncident = {
  incident_id: string;
  ticker: string;
  trigger_type: "organic" | "scheduled";
  window_start: string;
  window_end: string | null;
  window_status: "open" | "closed";
  composite_tags: BaseCompositeTag[];
  priority: number;
  priority_band: BasePriorityBand;
  degraded_context: boolean;
  /** True when the discovery floor set this priority (§8 observability). */
  discovery_floor_applied: boolean;
  messages: TrackerMessage[];
  quant_context: TrackerQuantContext | null;
  user_proximity: BaseUserProximity;
  related_incident_id: string | null;
  /** Classifier §10c accumulation (direct, ≥ standard, network-relevant). */
  propagation_candidates: Array<{
    ticker: string;
    article_key: string;
    event_type: string;
    event_label: string;
  }>;
};

export type BaseRoutingOutcome =
  | { action: "route"; destination: BaseRoutingDestination; rule: string }
  | { action: "store_only"; rule: string };

export type BaseIncidentRouting = {
  destinations: Array<{
    destination: BaseRoutingDestination;
    rules: string[];
    message_ids: string[];
  }>;
  store_only: boolean;
  per_message: Array<{ message_id: string; outcome: BaseRoutingOutcome }>;
};

export type BaseReplayedIncident = {
  incident: BaseIncident;
  routing: BaseIncidentRouting;
};

export type BaseReplaySummary = {
  message_count: number;
  incident_count: number;
  ticker_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
  open_incidents: number;
  closed_incidents: number;
  degraded_incidents: number;
  discovery_floor_promotions: number;
  dedupe: {
    news_messages: number;
    distinct_articles: number;
    classifier_requests: number;
    requests_saved: number;
    syndicated_articles: number;
    by_key_source: { article_id: number; url: number; headline: number };
  };
  by_band: Record<BasePriorityBand, number>;
  by_destination: Record<BaseDestinationKey, number>;
  by_tag: Record<BaseCompositeTag, number>;
  by_ticker: Array<{ ticker: string; incidents: number; messages: number }>;
  classification: {
    rescore_applied: boolean;
    classifier_bound_messages: number;
    messages_with_verdict: number;
    messages_classified: number;
    messages_failed: number;
    messages_unassessed: number;
    incidents_promoted: number;
    incidents_demoted: number;
    propagation_candidates: number;
  };
};

export type BaseArticleGroup = {
  key: { key: string; source: "article_id" | "url" | "headline" };
  lead_message_id: string;
  message_ids: string[];
  tickers: string[];
  syndicated: boolean;
};

export type BaseReplayResult = {
  summary: BaseReplaySummary;
  incidents: BaseReplayedIncident[];
  article_groups: BaseArticleGroup[];
};

/** The subset of BaseConfig the panel displays. */
export type BaseConfigSummary = {
  measurementSilenceMs: number;
  hardCapMs: number;
  relatedLookbackMs: number;
  bands: { P0: number; P1: number; P2: number };
  proximityMultipliers: Record<BaseUserProximity, number>;
  tagWeights: Record<BaseCompositeTag, number>;
  positiveBonusCap: number;
  configFile: string;
  /** Classifier Phase B switch (B9). */
  rescoreEnabled: boolean;
};
