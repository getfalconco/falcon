/**
 * Stage-1 runner — the complete, shippable, deterministic run (§4–§6).
 *
 *   traverse → matrix (drop `no`, resolve direction) → strength tier → cap →
 *   pricing check per tracked target → template mechanism → summary.
 *
 * The only non-pure input is the Tracker quant snapshot per target, injected
 * through `QuantSource` so tests run on recorded snapshots. Honest outputs are
 * first-class: no reachable target, nothing transmitting, or everything
 * priced all produce a complete `no_edge` run.
 */

import type { PropagationConfig } from "./config.js";
import type { GraphIndex } from "./graph.js";
import { transmissionFor } from "./matrix.js";
import { templateMechanism } from "./mechanism.js";
import { computePricing, UNKNOWN_PRICING, type TargetQuantSnapshot } from "./pricing.js";
import type { PropagationRequest } from "./requests.js";
import { runIdFor } from "./requests.js";
import { capCandidates, traverse } from "./traverse.js";
import {
  PROPAGATION_SCHEMA_VERSION,
  type EventDirection,
  type PropagationRole,
  type PropagationRun,
  type PropagationTarget,
  type RunSummary,
  type TraversalCandidate,
} from "./types.js";

export type QuantSource = {
  /** Whether the Tracker follows this ticker (pricing is only computed for tracked targets). */
  isTracked(ticker: string): boolean;
  /** Quant snapshot for a tracked ticker; null when unavailable. */
  snapshot(ticker: string): Promise<TargetQuantSnapshot | null>;
};

/** A QuantSource that tracks nothing — every target ships `pricing: unknown`. */
export const NO_QUANT: QuantSource = {
  isTracked: () => false,
  snapshot: async () => null,
};

export type Stage1Options = {
  graph: GraphIndex;
  request: PropagationRequest;
  config: PropagationConfig;
  quant: QuantSource;
  now: string;
};

const DIRECTION_SIGN: Record<EventDirection, number> = {
  positive: 1,
  negative: -1,
  mixed: 0,
  unclear: 0,
};

type Transmitting = {
  candidate: TraversalCandidate;
  transmission: NonNullable<ReturnType<typeof transmissionFor>>;
};

/**
 * §4a one entity, one call.
 *
 * A counterparty can hold two roles toward the root at once — COP is both a
 * Chevron JV partner and an E&P competitor — and the matrix reads those two
 * cells in opposite directions. Emitted as separate targets that is a long and
 * a short on the same ticker off a single event, which is not a signal.
 *
 * So the entity collapses to one target: the strongest relationship survives
 * (the list arrives in traversal order — tier, then confidence), the other
 * roles are recorded on it, and when the roles disagree on sign no direction
 * is called at all. `unclear` is already a first-class value here: the pricing
 * check falls back to comparing magnitude, which is exactly what is known.
 * Roles that agree (or that carry no sign) just merge — one row, strongest tier.
 */
export function collapseEntities(list: Transmitting[]): {
  kept: Transmitting[];
  collapsed: number;
  conflicts: number;
} {
  const byEntity = new Map<string, Transmitting[]>();
  const order: string[] = [];
  for (const item of list) {
    const key = item.candidate.ticker ?? item.candidate.target;
    const bucket = byEntity.get(key);
    if (bucket) bucket.push(item);
    else {
      byEntity.set(key, [item]);
      order.push(key);
    }
  }

  const kept: Transmitting[] = [];
  let collapsed = 0;
  let conflicts = 0;
  for (const key of order) {
    const bucket = byEntity.get(key)!;
    const [primary, ...rest] = bucket;
    if (rest.length === 0) {
      kept.push(primary);
      continue;
    }
    collapsed += rest.length;
    const signs = new Set(bucket.map((b) => DIRECTION_SIGN[b.transmission.direction]));
    const conflict = signs.has(1) && signs.has(-1);
    if (conflict) conflicts += 1;
    const alsoRoles: PropagationRole[] = [];
    for (const other of rest) {
      const role = other.candidate.relationship.role;
      if (role !== primary.candidate.relationship.role && !alsoRoles.includes(role)) {
        alsoRoles.push(role);
      }
    }
    kept.push({
      candidate: primary.candidate,
      transmission: {
        ...primary.transmission,
        direction: conflict ? "unclear" : primary.transmission.direction,
        rule: conflict ? "unclear" : primary.transmission.rule,
        also_roles: alsoRoles,
        role_conflict: conflict,
      },
    });
  }
  return { kept, collapsed, conflicts };
}

/** §9 summary — vetoed targets are kept in the list but excluded from the counts. */
export function summarize(targets: PropagationTarget[]): RunSummary {
  let open = 0;
  let partial = 0;
  let priced = 0;
  let contradicted = 0;
  let stale = 0;
  let untracked = 0;
  let vetoed = 0;
  let counted = 0;
  for (const t of targets) {
    if (t.stage2?.verdict === "vetoed") {
      vetoed += 1;
      continue;
    }
    counted += 1;
    if (!t.tracked) untracked += 1;
    switch (t.pricing.status) {
      case "open":
        open += 1;
        break;
      case "partial":
        partial += 1;
        break;
      case "priced":
        priced += 1;
        break;
      case "contradicted":
        contradicted += 1;
        break;
      case "stale":
        stale += 1;
        break;
      default:
        break;
    }
  }
  // No edge: nothing left that is open or partial (untracked/unknown does not
  // count as an edge either — it is a universe-expansion signal, not a trade;
  // neither does contradicted — that thesis is refuted, not unabsorbed).
  const no_edge = open === 0 && partial === 0;
  return { targets: counted, open, partial, priced, contradicted, stale, untracked, vetoed, no_edge };
}

export async function runStage1(options: Stage1Options): Promise<PropagationRun> {
  const { graph, request, config, quant, now } = options;
  const root = request.root_ticker.toUpperCase();
  const event = request.event;

  const traversal = traverse(graph, root);
  const reachable = traversal.candidates.length;

  // Matrix: drop non-transmitting cells, resolve direction and tier.
  const transmitting: Transmitting[] = [];
  let nonTransmitting = 0;
  for (const candidate of traversal.candidates) {
    const transmission = transmissionFor(config, event, candidate.relationship);
    if (!transmission) {
      nonTransmitting += 1;
      continue;
    }
    transmitting.push({ candidate, transmission });
  }

  // One entity, one call — before the cap, so a collapsed duplicate frees a
  // slot for a name the run would otherwise have dropped as overflow.
  const entities = collapseEntities(transmitting);

  // Cap after the matrix so `no` rows never crowd out transmitting ones.
  const { kept, overflow } = capCandidates(entities.kept, config.maxTargets);

  const targets: PropagationTarget[] = [];
  for (const { candidate, transmission } of kept) {
    const tracked = candidate.ticker !== null && quant.isTracked(candidate.ticker);
    let pricing = UNKNOWN_PRICING;
    if (tracked && candidate.ticker) {
      const snapshot = await quant.snapshot(candidate.ticker).catch(() => null);
      pricing = computePricing({
        snapshot,
        eventTs: event.event_ts,
        now,
        tier: transmission.tier,
        direction: transmission.direction,
        config: config.pricing,
      });
    }
    const mechanism = templateMechanism(
      {
        root,
        eventLabel: event.label,
        target: candidate.ticker ?? candidate.label,
        role: candidate.relationship.role,
        tier: candidate.relationship.tier,
        subtype: candidate.relationship.subtype,
        evidence_via: candidate.relationship.evidence_via,
        transmission,
      },
      config.fieldCaps.mechanism,
    );
    targets.push({
      target: candidate.target,
      ticker: candidate.ticker,
      label: candidate.label,
      tracked,
      relationship: candidate.relationship,
      transmission,
      pricing,
      mechanism,
      stage2: null,
    });
  }

  return {
    schema_version: PROPAGATION_SCHEMA_VERSION,
    run_id: runIdFor(request.request_id),
    incident_id: request.incident_id,
    request_id: request.request_id,
    update_of: request.prior_run_id,
    graph_version: graph.version,
    root_ticker: root,
    event,
    targets,
    summary: summarize(targets),
    status: "stage1_only",
    stage2: null,
    overflow,
    non_transmitting: nonTransmitting,
    reachable,
    trigger: { rules: request.trigger_rules, priority_band: request.incident.priority_band },
    produced_at: now,
    superseded_by: null,
    update: request.update,
    failure_reason: null,
    synthetic: Boolean(request.synthetic),
  };
}
