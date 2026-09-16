/**
 * Base → Propagation request building (§2).
 *
 * Base has no live dispatch loop, so — exactly as the Analyst host does — the
 * Propagation host replays Base over Tracker's recorded stream and turns
 * every qualifying incident into a `PropagationRequest`:
 *
 *   - incidents whose routing reached `destination: propagation` (mapped 8-K,
 *     gap_event with the event_gap composite) — always;
 *   - incidents carrying `propagation_candidates` — when the incident's band
 *     qualifies (`BaseConfig.propagation.dispatchMinBand`, P2+ default).
 *
 * One run per (incident, root_ticker) per day: the request id is
 * deterministic in (incident, best event), so a later qualifying trigger
 * that changes the best event yields `update: true` and supersedes the prior
 * run; an unchanged incident yields the same id (served from the store).
 */

import { createHash } from "node:crypto";
import type { MessageClassification, VerdictLookup } from "../../base/classification.js";
import { etDayOf, type BudgetLedger } from "../../base/classification.js";
import type { BaseConfig } from "../../base/config.js";
import { bandAtLeast } from "../../base/priority.js";
import type { ReplayedIncident } from "../../base/replay.js";
import type { Incident } from "../../base/types.js";
import type { PropagationConfig } from "./config.js";
import { selectBestEvent } from "./event.js";
import type { PropagationEvent, PropagationRun } from "./types.js";

export type PropagationRequest = {
  /** Deterministic: changes exactly when the incident's best event changes. */
  request_id: string;
  incident_id: string;
  root_ticker: string;
  incident: Incident;
  event: PropagationEvent;
  /** Base routing rules that dispatched it (or `candidates` for the candidate path). */
  trigger_rules: string[];
  /** §2 supersession: a newer request for an incident that already has a run. */
  update: boolean;
  prior_run_id: string | null;
  requested_at: string;
  verdicts: Record<string, MessageClassification>;
  /** Fixture / synthetic request — the run is flagged and kept out of the live list. */
  synthetic?: boolean;
};

/** Event identity for the request id: what it is, not how it is labelled. */
export function eventKey(event: PropagationEvent): string {
  return [
    event.type,
    event.direction,
    event.materiality,
    event.source,
    [...event.source_msg_ids].sort().join(","),
  ].join("|");
}

export function propagationRequestId(
  incident: Pick<Incident, "incident_id">,
  rootTicker: string,
  event: PropagationEvent,
): string {
  const digest = createHash("sha1")
    .update(`${rootTicker.toUpperCase()}\n${eventKey(event)}`)
    .digest("hex")
    .slice(0, 10);
  return `pr-${incident.incident_id}-${digest}`;
}

/** Run ids are request-scoped and unique per produce: `<request>-<n>` is overkill; one run per request. */
export function runIdFor(requestId: string): string {
  return `run-${requestId.slice(3)}`;
}

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

export type BuildPropagationRequestsOptions = {
  verdictLookup: VerdictLookup;
  /** Newest run already produced for an incident, if any. */
  latestRun: (incidentId: string) => PropagationRun | null;
  now: string;
  baseConfig: BaseConfig;
  config: PropagationConfig;
};

export type BuiltPropagationRequests = {
  requests: PropagationRequest[];
  /** Incidents whose current request already has a run in the store. */
  already_produced: number;
  /** Requests that update a prior run (§2). */
  updates: number;
  /** Incidents that qualified by trigger but carried no readable event. */
  no_event: number;
  /** Candidate-only incidents below the dispatch band. */
  below_band: number;
};

export function qualifiesForDispatch(
  replayed: Pick<ReplayedIncident, "incident" | "routing">,
  baseConfig: BaseConfig,
): { qualifies: boolean; rules: string[]; reason: "routed" | "candidates" | "below_band" | "none" } {
  const routed = replayed.routing.destinations.find((d) => d.destination === "propagation");
  if (routed) return { qualifies: true, rules: routed.rules, reason: "routed" };
  if (replayed.incident.propagation_candidates.length > 0) {
    if (bandAtLeast(replayed.incident.priority_band, baseConfig.propagation.dispatchMinBand)) {
      return { qualifies: true, rules: ["propagation_candidates"], reason: "candidates" };
    }
    return { qualifies: false, rules: [], reason: "below_band" };
  }
  return { qualifies: false, rules: [], reason: "none" };
}

export function buildPropagationRequests(
  replayed: ReplayedIncident[],
  options: BuildPropagationRequestsOptions,
): BuiltPropagationRequests {
  const requests: PropagationRequest[] = [];
  let alreadyProduced = 0;
  let updates = 0;
  let noEvent = 0;
  let belowBand = 0;
  for (const r of replayed) {
    const q = qualifiesForDispatch(r, options.baseConfig);
    if (!q.qualifies) {
      if (q.reason === "below_band") belowBand += 1;
      continue;
    }
    const incident = r.incident;
    const verdicts = collectVerdicts(incident, options.verdictLookup);
    const event = selectBestEvent(incident, verdicts, { rootTicker: incident.ticker, config: options.config });
    if (!event) {
      noEvent += 1;
      continue;
    }
    const request_id = propagationRequestId(incident, incident.ticker, event);
    const prior = options.latestRun(incident.incident_id);
    if (prior && prior.request_id === request_id && prior.status !== "failed") {
      alreadyProduced += 1;
      continue;
    }
    const update = Boolean(prior && prior.request_id !== request_id);
    if (update) updates += 1;
    requests.push({
      request_id,
      incident_id: incident.incident_id,
      root_ticker: incident.ticker.toUpperCase(),
      incident,
      event,
      trigger_rules: q.rules,
      update,
      prior_run_id: update && prior ? prior.run_id : null,
      requested_at: options.now,
      verdicts,
    });
  }
  return { requests, already_produced: alreadyProduced, updates, no_event: noEvent, below_band: belowBand };
}

// ---------------------------------------------------------------------------
// §11 stage-2 daily budget (Base-owned, ET-midnight reset)
// ---------------------------------------------------------------------------

export function propagationBudgetRemaining(ledger: BudgetLedger | null, now: string, config: BaseConfig): number {
  const day = etDayOf(now);
  const used = ledger && ledger.day === day ? ledger.used : 0;
  return Math.max(0, config.propagation.dailyBudget - used);
}

/**
 * Priority-ordered queueing: higher-priority incidents first; ties by request
 * id for determinism. Stage-1 has no budget — every request runs; the budget
 * decides which of them also get stage-2.
 */
export function orderByPriority(requests: PropagationRequest[]): PropagationRequest[] {
  return [...requests].sort(
    (a, b) => b.incident.priority - a.incident.priority || a.request_id.localeCompare(b.request_id),
  );
}
