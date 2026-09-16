/**
 * Base → Analyst request building (§2).
 *
 * Base has no live dispatch loop yet, so — exactly as the Classifier host
 * does — the Analyst host replays Base over Tracker's recorded stream and
 * turns every incident whose routing reached `destination: analyst` into an
 * `AnalystRequest`. The request id is deterministic in the incident's
 * message set, so an incident that grew since its last output yields a new
 * request (`update: true`, `prior_request_id` = the prior output's request),
 * and an unchanged incident yields the same id (served from the store).
 *
 * Pure functions over (replayed incidents, verdict lookup, existing outputs).
 * The daily budget is Base's (§8): helpers here read `BaseConfig.analyst`.
 */

import { createHash } from "node:crypto";
import type { MessageClassification, VerdictLookup } from "../base/classification.js";
import { etDayOf, type BudgetLedger } from "../base/classification.js";
import type { BaseConfig } from "../base/config.js";
import type { IncidentIdFactory } from "../base/incident.js";
import type { IncidentRouting } from "../base/routing.js";
import type { ReplayedIncident } from "../base/replay.js";
import type { Incident } from "../base/types.js";
import type { AnalystOutput, AnalystRequest, AnalystRequestKind } from "./types.js";

/**
 * Deterministic incident ids for replay-driven Analyst cycles. Base's default
 * is uuid-v4 per replay, which would give the same incident a new id every
 * 15 minutes and defeat the output store, supersession and the budget. This
 * derives a uuid-shaped id from (ticker, window_start) — stable as long as the
 * incident's first message is in the replayed window.
 */
export const stableIncidentId: IncidentIdFactory = (ticker, windowStart) => {
  const hex = createHash("sha1").update(`${ticker.toUpperCase()}|${windowStart}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/**
 * §2 + S3: a Scheduler due-trigger incident is a `scheduled_brief`; an
 * incident whose ONLY reason to reach Analyst is Screen's structure row is a
 * `structure_review`; everything else is an `anomaly_review`.
 *
 * The "only reason" test matters: when a structure message lands in an
 * incident that also carries a real anomaly, the anomaly is the more urgent
 * question and the structure becomes context inside it.
 */
export function analystKindOf(
  incident: Pick<Incident, "trigger_type">,
  routing?: Pick<IncidentRouting, "destinations">,
): AnalystRequestKind {
  if (incident.trigger_type === "scheduled") return "scheduled_brief";
  const analyst = routing?.destinations.find((d) => d.destination === "analyst");
  if (analyst && analyst.rules.length > 0 && analyst.rules.every((r) => r === TAPE_STRUCTURE_RULE)) {
    return "structure_review";
  }
  return "anomaly_review";
}

/** The routing row that makes an incident a structure review. */
export const TAPE_STRUCTURE_RULE = "tape_structure.analyst";

/** Deterministic request id: changes exactly when the incident's message set changes. */
export function analystRequestId(incident: Pick<Incident, "incident_id" | "messages">): string {
  const ids = incident.messages.map((m) => m.id).sort();
  const digest = createHash("sha1").update(ids.join("\n")).digest("hex").slice(0, 10);
  return `an-${incident.incident_id}-${digest}`;
}

/** Resolve the per-message verdicts Base already holds; unclassified messages are omitted. */
export function collectVerdicts(
  incident: Pick<Incident, "messages">,
  lookup: VerdictLookup,
): Record<string, MessageClassification> {
  const out: Record<string, MessageClassification> = {};
  for (const m of incident.messages) {
    const c = lookup(m);
    if (c.state === "unclassified") continue;
    out[m.id] = c;
  }
  return out;
}

export type BuildAnalystRequestsOptions = {
  verdictLookup: VerdictLookup;
  /** Newest output already produced for an incident, if any. */
  latestOutput: (incidentId: string) => AnalystOutput | null;
  now: string;
};

export type BuiltAnalystRequests = {
  requests: AnalystRequest[];
  /** Incidents whose current request already has an ok output in the store. */
  already_produced: number;
  /** Requests that update a prior output (§2). */
  updates: number;
};

export function buildAnalystRequests(
  replayed: ReplayedIncident[],
  options: BuildAnalystRequestsOptions,
): BuiltAnalystRequests {
  const requests: AnalystRequest[] = [];
  let alreadyProduced = 0;
  let updates = 0;
  for (const { incident, routing } of replayed) {
    if (!routing.destinations.some((d) => d.destination === "analyst")) continue;
    const request_id = analystRequestId(incident);
    const prior = options.latestOutput(incident.incident_id);
    if (prior && prior.request_id === request_id && prior.status === "ok") {
      alreadyProduced += 1;
      continue;
    }
    const update = Boolean(prior && prior.request_id !== request_id);
    if (update) updates += 1;
    requests.push({
      request_id,
      incident_id: incident.incident_id,
      kind: analystKindOf(incident, routing),
      incident,
      update,
      prior_request_id: update && prior ? prior.request_id : null,
      requested_at: options.now,
      verdicts: collectVerdicts(incident, options.verdictLookup),
    });
  }
  return { requests, already_produced: alreadyProduced, updates };
}

// ---------------------------------------------------------------------------
// §8 daily budget (Base-owned, ET-midnight reset)
// ---------------------------------------------------------------------------

export { structureBudgetRemaining } from "../base/classification.js";

export function analystBudgetRemaining(ledger: BudgetLedger | null, now: string, config: BaseConfig): number {
  const day = etDayOf(now);
  const used = ledger && ledger.day === day ? ledger.used : 0;
  return Math.max(0, config.analyst.dailyBudget - used);
}

function byPriority(a: AnalystRequest, b: AnalystRequest): number {
  return b.incident.priority - a.incident.priority || a.request_id.localeCompare(b.request_id);
}

/**
 * Priority-ordered budget queueing: higher-priority incidents first; ties by
 * request id for determinism. Returns the requests that fit, and the deferred.
 *
 * S2: `structure_review` requests are served only from what the event-driven
 * ones leave behind, and never more than `structureRemaining` of them. An
 * untested Screen pattern therefore cannot delay or displace an anomaly,
 * whatever its incident priority.
 */
export function applyAnalystBudget(
  requests: AnalystRequest[],
  remaining: number,
  structureRemaining = Number.POSITIVE_INFINITY,
): { dispatch: AnalystRequest[]; deferred: AnalystRequest[] } {
  const total = Math.max(0, remaining);
  const events = requests.filter((r) => r.kind !== "structure_review").sort(byPriority);
  const structures = requests.filter((r) => r.kind === "structure_review").sort(byPriority);

  const dispatchedEvents = events.slice(0, total);
  const structureSlots = Math.max(0, Math.min(structures.length, total - dispatchedEvents.length, Math.max(0, structureRemaining)));
  const dispatchedStructures = structures.slice(0, structureSlots);

  return {
    dispatch: [...dispatchedEvents, ...dispatchedStructures],
    deferred: [...events.slice(dispatchedEvents.length), ...structures.slice(structureSlots)],
  };
}
