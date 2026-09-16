/**
 * Base Engine contracts — spec v1.2.
 *
 * Base is the deterministic coordination layer between Tracker and the
 * downstream specialist engines: it groups Tracker messages into incidents,
 * scores their priority and routes them. No interpretation, no traversal,
 * no LLM calls (§7).
 */

import type { QuantContext, TrackerMessage, TrackerMessageType } from "../tracker/types.js";
import type { ScreenMessageType, TapeStructureMessage } from "../screen/types.js";

export const BASE_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Messages Base coordinates (§1)
// ---------------------------------------------------------------------------

/**
 * Base is the coordination layer for every producing engine, not just the
 * Tracker. Screen's `tape_structure` (S1) is the second producer: the Tracker's
 * own closed union is untouched, and `TrackerMessage` stays assignable to
 * `BaseMessage`, so every existing caller is unaffected.
 */
export type BaseMessageType = TrackerMessageType | ScreenMessageType;
export type BaseMessage = TrackerMessage | TapeStructureMessage;

// ---------------------------------------------------------------------------
// Message classes (§1)
// ---------------------------------------------------------------------------

/** §1 information messages. */
export const INFORMATION_MESSAGE_TYPES = [
  "news_item",
  "filing_item",
  "insider_filing",
] as const;

/**
 * §1 measurement messages — the only class that extends an incident window
 * (§2). `tape_structure` joins them: a multi-session structure is a
 * measurement of the tape, not a piece of information about the company, so
 * it extends the window and never waits on the no-measurement close rule.
 */
export const MEASUREMENT_MESSAGE_TYPES = [
  "gap_event",
  "volume_anomaly",
  "unexplained_move",
  "drift_event",
  "news_burst",
  "silence_anomaly",
  "filing_overdue",
  "insider_cluster",
  "tape_structure",
] as const;

/** §1 calendar message. */
export const CALENDAR_MESSAGE_TYPES = ["scheduled_event"] as const;

// ---------------------------------------------------------------------------
// Composite tags (§2)
// ---------------------------------------------------------------------------

export type CompositeTag =
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
  | "explained_move"
  | "tape_structure";

/**
 * Canonical emission order. Tags are a set, but the emitted array is ordered
 * so identical message sequences produce byte-identical incidents (§8).
 */
export const COMPOSITE_TAG_ORDER: readonly CompositeTag[] = [
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
  "tape_structure",
];

// ---------------------------------------------------------------------------
// Incident (§2, §6)
// ---------------------------------------------------------------------------

export type UserProximity = "held" | "watchlist" | "tracked";
export type PriorityBand = "P0" | "P1" | "P2" | "P3";
export type TriggerType = "organic" | "scheduled";
export type WindowStatus = "open" | "closed";

/** §4 destinations. "store only" rows produce no request at all, so they are
 *  not a destination — see RoutingOutcome. */
export type RoutingDestination =
  | "classifier"
  | "propagation"
  | "extraction"
  | "analyst"
  | "scheduler";

/** §6 incident as emitted on a routing request. */
export type Incident = {
  incident_id: string;
  ticker: string;
  trigger_type: TriggerType;
  window_start: string;
  window_end: string | null;
  window_status: WindowStatus;
  composite_tags: CompositeTag[];
  priority: number;
  priority_band: PriorityBand;
  degraded_context: boolean;
  /** True when the discovery floor set this priority (§8 observability). */
  discovery_floor_applied: boolean;
  /** True when an earnings release holds this incident open (§2 absorption). */
  earnings_absorption: boolean;
  messages: BaseMessage[];
  quant_context: QuantContext | null;
  user_proximity: UserProximity;
  related_incident_id: string | null;
  /**
   * Classifier §10c: (ticker, article_key, event_type, event_label) for
   * verdicts that are direct, ≥ standard and network-relevant. Data for the
   * future Propagation engine — not a routing input.
   */
  propagation_candidates: PropagationCandidate[];
};

/** See Classifier spec §10c. */
export type PropagationCandidate = {
  ticker: string;
  article_key: string;
  event_type: string;
  event_label: string;
};

/**
 * Incident plus the bookkeeping the window model needs but the wire format
 * does not carry: the measurement anchor and the trigger identities used for
 * related-incident linking (§2).
 */
export type IncidentState = Incident & {
  /** Timestamp of the last window-extending message, null if none yet. */
  last_measurement_at: string | null;
  /** End of the earnings absorption window; null when not absorbing. */
  absorbing_until: string | null;
  /** Sorted identity keys: "8k:<accession>", "sched:<due_at>", "article:<id>". */
  trigger_identities: string[];
};

/** Strip the internal bookkeeping before emitting (§6). */
export function toWireIncident(state: IncidentState): Incident {
  const { last_measurement_at: _a, trigger_identities: _b, absorbing_until: _c, ...wire } = state;
  return wire;
}

// ---------------------------------------------------------------------------
// User context (§3 proximity only)
// ---------------------------------------------------------------------------

export type UserContext = {
  /** Tickers the user holds a position in. */
  held: string[];
  /** Tickers on the user's watchlist. */
  watchlist: string[];
};

export const EMPTY_USER_CONTEXT: UserContext = { held: [], watchlist: [] };

/** held > watchlist > tracked-only. */
export function resolveProximity(ticker: string, context: UserContext): UserProximity {
  const t = ticker.toUpperCase();
  if (context.held.some((x) => x.toUpperCase() === t)) return "held";
  if (context.watchlist.some((x) => x.toUpperCase() === t)) return "watchlist";
  return "tracked";
}

// ---------------------------------------------------------------------------
// Scheduler due-trigger (§2, §4)
// ---------------------------------------------------------------------------

/**
 * Fired by the Scheduler when a previously recorded scheduled_event comes due.
 * It opens its own incident and does not require an open one to exist (§2).
 */
export type SchedulerDueTrigger = {
  id: string;
  ticker: string;
  /** The due_at of the scheduled_event that produced this trigger. */
  due_at: string;
  /** Instant the trigger fired. */
  fired_at: string;
  quant_context?: QuantContext | null;
};

// ---------------------------------------------------------------------------
// Routing (§4, §6)
// ---------------------------------------------------------------------------

export type RoutingOutcome =
  | { action: "route"; destination: RoutingDestination; rule: string }
  | { action: "store_only"; rule: string };

/** §6 emitted request envelope. */
export type RoutingRequest = {
  id: string;
  schema_version: number;
  type: "routing_request";
  source_engine: "base";
  destination: RoutingDestination;
  timestamp: string;
  incident: Incident;
  update: boolean;
  prior_request_id: string | null;
};
