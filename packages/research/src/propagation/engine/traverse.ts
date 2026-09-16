/**
 * §4 traversal — deterministic, one hop, pure.
 *
 * Forward edges (root_ticker = R) keep their category as the role. Reverse
 * edges (counterparty_ticker = R) invert it: X lists R as supplier → X is R's
 * customer; X lists R as customer → X is R's supplier; competitor and partner
 * are symmetric; X lists R as dependency → X is `depended_on_by` R. The same
 * (target, role) asserted from both sides is one relationship: the higher
 * strength tier wins, evidence is merged. Multi-hop is v2.
 */

import type { GraphEdge } from "../types.js";
import { STRENGTH_RANK, counterpartyKey, edgeTier, type GraphIndex } from "./graph.js";
import type { PropagationRole, TargetRelationship, TraversalCandidate, TraversalResult } from "./types.js";

const FORWARD_ROLES: Record<string, PropagationRole> = {
  supplier: "supplier",
  customer: "customer",
  competitor: "competitor",
  partner: "partner",
  dependency: "dependency",
};

/** Role of X relative to R when X's filing lists R under `category`. */
export const REVERSE_ROLES: Record<string, PropagationRole> = {
  supplier: "customer",
  customer: "supplier",
  competitor: "competitor",
  partner: "partner",
  dependency: "depended_on_by",
};

export function forwardRole(category: string): PropagationRole | null {
  return FORWARD_ROLES[category] ?? null;
}

/**
 * Whether a counterparty edge can ever produce a priceable target.
 *
 * `counterparty_type` comes from the step1 extractor, which already separates
 * companies from governments, products and commodities. Only a public company
 * can carry a ticker, so only a public company can be scored — the rest are
 * kept in the graph (they are true, and they explain the root's exposure) but
 * never compete for a target slot.
 *
 * An edge written before the field existed has `undefined` here, and is
 * admitted: an older graph must keep behaving exactly as it did.
 */
export function isTradableCounterparty(edge: Pick<GraphEdge, "counterparty_type">): boolean {
  const kind = edge.counterparty_type;
  if (kind === undefined || kind === null) return true;
  return kind === "public_company";
}

export function reverseRole(category: string): PropagationRole | null {
  return REVERSE_ROLES[category] ?? null;
}

type Seed = {
  target: string;
  ticker: string | null;
  label: string;
  role: PropagationRole;
  edge: GraphEdge;
  via: "forward" | "reverse";
};

function relationshipFrom(seed: Seed): TargetRelationship {
  const e = seed.edge;
  return {
    role: seed.role,
    subtype: e.subtype ?? "",
    tier: edgeTier(e),
    confidence: typeof e.confidence === "number" ? e.confidence : 0,
    evidence_quote: e.evidence_quote ?? "",
    source_url: e.source_url ?? "",
    filing_date: e.filing_date ?? e.valid_from ?? null,
    via: seed.via,
    evidence_via: seed.via,
    edge_ids: [e.id],
    merged_evidence: [],
  };
}

/** Higher tier wins; ties by confidence; then forward over reverse (the root's own filing). */
function outranks(a: Seed, b: Seed): boolean {
  const ta = STRENGTH_RANK[edgeTier(a.edge)];
  const tb = STRENGTH_RANK[edgeTier(b.edge)];
  if (ta !== tb) return ta > tb;
  const ca = a.edge.confidence ?? 0;
  const cb = b.edge.confidence ?? 0;
  if (ca !== cb) return ca > cb;
  if (a.via !== b.via) return a.via === "forward";
  return a.edge.id < b.edge.id;
}

/**
 * Every counterparty one hop from `root`, deduped per (target, role), ordered
 * by strength tier desc, confidence desc, target id asc. The cap is applied
 * later (after the matrix) so non-transmitting roles never crowd out
 * transmitting ones — see stage1.ts.
 */
export function traverse(graph: GraphIndex, rootTicker: string): TraversalResult {
  const root = rootTicker.trim().toUpperCase();
  const seeds: Seed[] = [];

  let nonTradable = 0;
  for (const edge of graph.forward.get(root) ?? []) {
    const role = forwardRole(edge.category);
    if (!role) continue;
    const key = counterpartyKey(edge);
    if (key === root) continue; // self-loop in the graph; not a target
    // A regulator, an agency, a product or a private company is a real
    // relationship and never a tradable target: it can hold no price, so it
    // can only ever ship `pricing: unknown` while occupying a slot under the
    // §4 cap that a priceable name would have used. Measured on the
    // 2026-08-26 graph this is 371 of 1,001 edges. Edges predating this field
    // carry `undefined` and are admitted, so an un-rebuilt graph is unchanged.
    if (!isTradableCounterparty(edge)) {
      nonTradable += 1;
      continue;
    }
    seeds.push({
      target: key,
      ticker: edge.counterparty_ticker ? edge.counterparty_ticker.toUpperCase() : null,
      label: graph.labels.get(key) ?? edge.counterparty_name ?? key,
      role,
      edge,
      via: "forward",
    });
  }
  for (const edge of graph.reverse.get(root) ?? []) {
    const role = reverseRole(edge.category);
    if (!role) continue;
    const key = edge.root_ticker.toUpperCase();
    if (key === root) continue;
    seeds.push({
      target: key,
      ticker: key,
      label: graph.labels.get(key) ?? key,
      role,
      edge,
      via: "reverse",
    });
  }

  // Dedupe per (target, role): keep the outranking edge, merge the rest.
  const byKey = new Map<string, { primary: Seed; others: Seed[] }>();
  for (const seed of seeds) {
    const k = `${seed.target}|${seed.role}`;
    const entry = byKey.get(k);
    if (!entry) {
      byKey.set(k, { primary: seed, others: [] });
      continue;
    }
    if (outranks(seed, entry.primary)) {
      entry.others.push(entry.primary);
      entry.primary = seed;
    } else {
      entry.others.push(seed);
    }
  }

  const candidates: TraversalCandidate[] = [];
  for (const { primary, others } of byKey.values()) {
    const relationship = relationshipFrom(primary);
    const vias = new Set<"forward" | "reverse">([primary.via]);
    for (const o of others) {
      vias.add(o.via);
      relationship.edge_ids.push(o.edge.id);
      if (o.edge.evidence_quote && o.edge.evidence_quote !== relationship.evidence_quote) {
        relationship.merged_evidence.push({
          quote: o.edge.evidence_quote,
          source_url: o.edge.source_url ?? "",
          edge_id: o.edge.id,
        });
      }
    }
    relationship.via = vias.size === 2 ? "both" : primary.via;
    candidates.push({ target: primary.target, ticker: primary.ticker, label: primary.label, relationship });
  }

  candidates.sort(compareCandidates);
  return { root_ticker: root, candidates, edges_seen: seeds.length, non_tradable: nonTradable };
}

export function compareCandidates(a: TraversalCandidate, b: TraversalCandidate): number {
  const t = STRENGTH_RANK[b.relationship.tier] - STRENGTH_RANK[a.relationship.tier];
  if (t !== 0) return t;
  const c = b.relationship.confidence - a.relationship.confidence;
  if (c !== 0) return c;
  // A tickered target before a name-only one at equal rank: it can be priced.
  if ((a.ticker === null) !== (b.ticker === null)) return a.ticker === null ? 1 : -1;
  const id = a.target.localeCompare(b.target);
  if (id !== 0) return id;
  return a.relationship.role.localeCompare(b.relationship.role);
}

/** §4 cap: the first `max` by the traversal order; the rest counted, not dropped silently. */
export function capCandidates<T>(list: T[], max: number): { kept: T[]; overflow: number } {
  const n = Math.max(0, Math.floor(max));
  return { kept: list.slice(0, n), overflow: Math.max(0, list.length - n) };
}
