/**
 * Point-in-time relationship graph (§3).
 *
 * The graph is built from 10-K filings and every edge carries the
 * `filing_date` of the document that asserted it. A strategy that fires on a
 * supplier relationship must only see relationships that had actually been
 * disclosed by the session it fires on — otherwise a 2026 filing would be
 * lighting up trades in 2022, which is the purest form of look-ahead available
 * in this codebase.
 *
 * Edges with no usable date are EXCLUDED, never grandfathered in. An undated
 * edge is one whose disclosure moment is unknown, and admitting it would
 * silently reintroduce exactly the leak this module exists to close.
 */

import { counterpartyKey, edgeTier, indexGraph, STRENGTH_RANK, type GraphIndex } from "../propagation/engine/graph.js";
import type { GraphEdge } from "../propagation/types.js";
import type { StrengthTier } from "../propagation/engine/types.js";

/** The disclosure date of an edge: the filing that asserted it. */
export function edgeDisclosedAt(edge: GraphEdge): string | null {
  const raw = edge.filing_date ?? edge.valid_from ?? null;
  if (typeof raw !== "string" || raw.length < 10) return null;
  const day = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

export type GraphAsOfResult = {
  index: GraphIndex;
  /** Edges kept. */
  kept: number;
  /** Edges dropped because they were disclosed after `asOf`. */
  future: number;
  /** Edges dropped because no disclosure date could be read. */
  undated: number;
};

/**
 * The graph as it stood at the close of `asOf`.
 *
 * Re-indexes rather than filtering in place so `forward`/`reverse`/`roots` all
 * describe the same restricted edge set — a caller must not be able to reach a
 * future edge through one index while another hides it.
 */
export function graphAsOf(index: GraphIndex, asOf: string): GraphAsOfResult {
  let future = 0;
  let undated = 0;
  const kept: GraphEdge[] = [];
  for (const edge of index.edges) {
    const disclosed = edgeDisclosedAt(edge);
    if (disclosed == null) {
      undated++;
      continue;
    }
    if (disclosed > asOf) {
      future++;
      continue;
    }
    kept.push(edge);
  }
  const labels = [...index.labels.entries()].map(([id, label]) => ({ id, label, kind: "name" as const }));
  return {
    index: indexGraph({
      generatedAt: index.version.generatedAt,
      pipelineVersion: index.version.pipelineVersion,
      nodes: labels,
      edges: kept,
    }),
    kept: kept.length,
    future,
    undated,
  };
}

export type Neighbour = {
  ticker: string;
  tier: StrengthTier;
  /** "forward" = the event ticker's filing named this counterparty. */
  via: "forward" | "reverse";
  category: string | null;
  disclosed_at: string;
};

/**
 * Tickered counterparties of `ticker` at or above `minTier`, one hop.
 *
 * Both directions are followed: a filing naming a supplier creates a link that
 * matters in either direction, and only the root company files. Name-only
 * counterparties are dropped — a strategy needs something it can price.
 */
export function neighboursOf(
  index: GraphIndex,
  ticker: string,
  minTier: StrengthTier,
  asOf: string,
): Neighbour[] {
  const root = ticker.toUpperCase();
  const floor = STRENGTH_RANK[minTier];
  const best = new Map<string, Neighbour>();

  const consider = (edge: GraphEdge, other: string, via: "forward" | "reverse"): void => {
    const disclosed = edgeDisclosedAt(edge);
    if (disclosed == null || disclosed > asOf) return;
    const tier = edgeTier(edge);
    if (STRENGTH_RANK[tier] < floor) return;
    const key = other.toUpperCase();
    if (key === root) return;
    const seen = best.get(key);
    // Strongest disclosed link wins; ties keep the earlier disclosure.
    if (seen && (STRENGTH_RANK[seen.tier] > STRENGTH_RANK[tier] || seen.disclosed_at <= disclosed)) return;
    best.set(key, { ticker: key, tier, via, category: edge.category ?? null, disclosed_at: disclosed });
  };

  for (const edge of index.forward.get(root) ?? []) {
    if (!edge.counterparty_ticker) continue;
    consider(edge, counterpartyKey(edge), "forward");
  }
  for (const edge of index.reverse.get(root) ?? []) {
    consider(edge, edge.root_ticker, "reverse");
  }
  return [...best.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}
