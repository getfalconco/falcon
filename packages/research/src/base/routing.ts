/**
 * §4 routing table — a literal transcription of the spec table as data, with
 * a first-match-wins evaluator. Conditions read thresholds, item codes and
 * form lists from BaseConfig; nothing is hardcoded here.
 */

import type {
  FilingItemPayload,
} from "../tracker/types.js";
import type { BaseConfig } from "./config.js";
import { bandAtLeast } from "./priority.js";
import type {
  BaseMessage,
  BaseMessageType,
  CompositeTag,
  Incident,
  RoutingDestination,
  RoutingOutcome,
} from "./types.js";

export type RoutingContext = {
  message: BaseMessage;
  incident: Pick<Incident, "composite_tags" | "priority_band" | "trigger_type">;
  config: BaseConfig;
};

export type RoutingRule = {
  /** Stable id, reported on the outcome so dispatch decisions are auditable. */
  id: string;
  type: BaseMessageType;
  /** The spec table's Condition column, verbatim-ish. */
  condition: string;
  /** null = unconditional row. */
  when: ((ctx: RoutingContext) => boolean) | null;
  /** null = the table's "store only" rows. */
  destination: RoutingDestination | ((config: BaseConfig) => RoutingDestination) | null;
};

function filing(ctx: RoutingContext): FilingItemPayload {
  return ctx.message.payload as FilingItemPayload;
}

function isEightK(ctx: RoutingContext): boolean {
  return ctx.config.routing.eightKFormTypes.includes(filing(ctx).form_type);
}

function hasMappedItemCode(ctx: RoutingContext): boolean {
  const mapped = ctx.config.routing.mapped8kItemCodes;
  return filing(ctx).item_codes.some((code) => mapped.includes(code));
}

function meetsAnalystBand(ctx: RoutingContext): boolean {
  return bandAtLeast(ctx.incident.priority_band, ctx.config.routing.analystMinBand);
}

function hasTag(ctx: RoutingContext, tag: CompositeTag): boolean {
  return ctx.incident.composite_tags.includes(tag);
}

/** S2: the Screen → Analyst channel, gated by its own flag and its own band. */
function meetsTapeStructureBand(ctx: RoutingContext): boolean {
  return (
    ctx.config.routing.screenToAnalystEnabled &&
    bandAtLeast(ctx.incident.priority_band, ctx.config.routing.tapeStructureMinBand)
  );
}

/** §4, in table order. First match wins. */
export const ROUTING_TABLE: RoutingRule[] = [
  { id: "news_item", type: "news_item", condition: "always", when: null, destination: "classifier" },
  {
    id: "filing_item.8k.mapped",
    type: "filing_item",
    condition: "8-K, item code mapped",
    when: (ctx) => isEightK(ctx) && hasMappedItemCode(ctx),
    destination: "propagation",
  },
  {
    id: "filing_item.8k.unmapped",
    type: "filing_item",
    condition: "8-K, item code unmapped",
    when: isEightK,
    destination: "classifier",
  },
  {
    id: "filing_item.periodic",
    type: "filing_item",
    condition: "10-K / 10-Q",
    when: (ctx) => ctx.config.routing.extractionForms.includes(filing(ctx).form_type),
    destination: "extraction",
  },
  {
    id: "filing_item.other",
    type: "filing_item",
    condition: "any other form (config fallback)",
    when: null,
    destination: (config) => config.routing.otherFilingDestination,
  },
  {
    id: "insider_filing",
    type: "insider_filing",
    condition: "always (feeds insider_cluster)",
    when: null,
    destination: null,
  },
  {
    id: "scheduled_event",
    type: "scheduled_event",
    condition: "always",
    when: null,
    destination: "scheduler",
  },
  {
    id: "unexplained_move.analyst",
    type: "unexplained_move",
    condition: "priority >= P1",
    when: meetsAnalystBand,
    destination: "analyst",
  },
  {
    id: "unexplained_move.store",
    type: "unexplained_move",
    condition: "below P1",
    when: null,
    destination: null,
  },
  {
    id: "drift_event.analyst",
    type: "drift_event",
    condition: "priority >= P1",
    when: meetsAnalystBand,
    destination: "analyst",
  },
  { id: "drift_event.store", type: "drift_event", condition: "below P1", when: null, destination: null },
  {
    id: "insider_cluster.analyst",
    type: "insider_cluster",
    condition: "priority >= P1",
    when: meetsAnalystBand,
    destination: "analyst",
  },
  {
    id: "insider_cluster.store",
    type: "insider_cluster",
    condition: "below P1",
    when: null,
    destination: null,
  },
  {
    id: "gap_event.propagation",
    type: "gap_event",
    condition: "with event_gap tag",
    when: (ctx) => hasTag(ctx, "event_gap"),
    destination: "propagation",
  },
  {
    id: "gap_event.analyst",
    type: "gap_event",
    condition: "without event_gap tag",
    when: null,
    destination: "analyst",
  },
  { id: "volume_anomaly.store", type: "volume_anomaly", condition: "alone", when: null, destination: null },
  { id: "news_burst.store", type: "news_burst", condition: "alone", when: null, destination: null },
  {
    id: "silence_anomaly.analyst",
    type: "silence_anomaly",
    condition: "with pre_earnings_silence tag",
    when: (ctx) => hasTag(ctx, "pre_earnings_silence"),
    destination: "analyst",
  },
  {
    id: "silence_anomaly.store",
    type: "silence_anomaly",
    condition: "otherwise",
    when: null,
    destination: null,
  },
  {
    id: "filing_overdue.analyst",
    type: "filing_overdue",
    condition: "with disclosure_risk tag",
    when: (ctx) => hasTag(ctx, "disclosure_risk"),
    destination: "analyst",
  },
  {
    id: "filing_overdue.store",
    type: "filing_overdue",
    condition: "otherwise",
    when: null,
    destination: null,
  },
  {
    id: "tape_structure.analyst",
    type: "tape_structure",
    condition: "screenToAnalystEnabled and priority >= tapeStructureMinBand (P2)",
    when: meetsTapeStructureBand,
    destination: "analyst",
  },
  {
    id: "tape_structure.store",
    type: "tape_structure",
    condition: "flag off or below the band",
    when: null,
    destination: null,
  },
];

/** Route one message in the context of its incident. */
export function routeMessage(
  message: BaseMessage,
  incident: RoutingContext["incident"],
  config: BaseConfig,
): RoutingOutcome {
  const ctx: RoutingContext = { message, incident, config };
  for (const rule of ROUTING_TABLE) {
    if (rule.type !== message.type) continue;
    if (rule.when && !rule.when(ctx)) continue;
    if (rule.destination === null) return { action: "store_only", rule: rule.id };
    const destination =
      typeof rule.destination === "function" ? rule.destination(config) : rule.destination;
    return { action: "route", destination, rule: rule.id };
  }
  return { action: "store_only", rule: "unmatched" };
}

export type IncidentRouting = {
  /** One entry per distinct destination, in first-match order. */
  destinations: Array<{ destination: RoutingDestination; rules: string[]; message_ids: string[] }>;
  /** True when the incident produced no routed destination at all. */
  store_only: boolean;
  per_message: Array<{ message_id: string; outcome: RoutingOutcome }>;
};

/**
 * Route a whole incident. A Scheduler due-trigger incident goes straight to
 * the Analyst row of the table regardless of its constituent messages (§4).
 */
export function routeIncident(
  incident: Pick<
    Incident,
    "composite_tags" | "priority_band" | "trigger_type" | "messages"
  >,
  config: BaseConfig,
): IncidentRouting {
  const per_message: IncidentRouting["per_message"] = [];
  const grouped = new Map<RoutingDestination, { rules: string[]; message_ids: string[] }>();

  // A due-trigger incident is guaranteed the Analyst (§4 last row) — but that
  // is in addition to, not instead of, what its constituent messages route
  // to. An absorbing earnings incident carries the 8-K 2.02, and Propagation
  // must still see it; returning Analyst alone silently dropped that.
  if (incident.trigger_type === "scheduled") {
    grouped.set(config.routing.scheduledTriggerDestination, {
      rules: ["scheduler.due_trigger"],
      message_ids: [],
    });
  }

  for (const message of incident.messages) {
    const outcome = routeMessage(message, incident, config);
    per_message.push({ message_id: message.id, outcome });
    if (outcome.action !== "route") continue;
    const entry = grouped.get(outcome.destination) ?? { rules: [], message_ids: [] };
    if (!entry.rules.includes(outcome.rule)) entry.rules.push(outcome.rule);
    entry.message_ids.push(message.id);
    grouped.set(outcome.destination, entry);
  }
  const destinations = [...grouped.entries()].map(([destination, v]) => ({ destination, ...v }));
  return { destinations, store_only: destinations.length === 0, per_message };
}
