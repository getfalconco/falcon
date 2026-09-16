/**
 * §3.4 Network concentration — the Falcon-unique component. Pairwise link
 * scores over held tickers from the relationship graph, read through the
 * Propagation engine's `GraphIndex` (no second reader):
 *
 *   direct  — an edge i↔j in either direction, any category: l = tier weight,
 *             max over multiple edges;
 *   shared  — i and j both hold supplier/dependency edges (tier ≥ sharedMinTier)
 *             to the same counterparty: l_shared = factor × min(tier weights);
 *   l_ij = max(l_direct, l_shared).
 *
 *   linked_fraction = Σ_{i<j} w_i w_j l_ij / Σ_{i<j} w_i w_j   (0 with < 2 pairs)
 *
 * Tickers the graph does not know (neither a root nor a counterparty) are
 * excluded from the pairs and reported so the caller can record `degraded`.
 */

import type { GraphEdge } from "../propagation/types.js";
import { STRENGTH_RANK, counterpartyKey, edgeTier, type GraphIndex } from "../propagation/engine/graph.js";
import type { RiskConfig } from "./config.js";
import type { NetworkLink, RiskStrengthTier, RiskWeight } from "./types.js";

type DirectCandidate = { edge: GraphEdge; tier: RiskStrengthTier; weight: number };

function tierWeight(tier: RiskStrengthTier, config: RiskConfig): number {
  return config.tierWeights[tier] ?? 0;
}

/** Higher tier wins; confidence breaks ties; edge id keeps it deterministic. */
function betterDirect(a: DirectCandidate | null, b: DirectCandidate): DirectCandidate {
  if (!a) return b;
  if (b.weight !== a.weight) return b.weight > a.weight ? b : a;
  if (b.edge.confidence !== a.edge.confidence) return b.edge.confidence > a.edge.confidence ? b : a;
  return b.edge.id < a.edge.id ? b : a;
}

/** Whether the graph knows the ticker at all (as a root or as a counterparty). */
export function graphKnowsTicker(graph: GraphIndex, ticker: string): boolean {
  const t = ticker.toUpperCase();
  return graph.roots.has(t) || graph.reverse.has(t);
}

/** Direct edges between a and b, in either direction. */
export function directEdges(graph: GraphIndex, a: string, b: string): GraphEdge[] {
  const A = a.toUpperCase();
  const B = b.toUpperCase();
  const out: GraphEdge[] = [];
  for (const edge of graph.forward.get(A) ?? []) if (counterpartyKey(edge) === B) out.push(edge);
  for (const edge of graph.forward.get(B) ?? []) if (counterpartyKey(edge) === A) out.push(edge);
  return out;
}

/**
 * Counterparties the ticker depends on (supplier/dependency edges it filed, at
 * or above the configured minimum tier), with the best edge per counterparty.
 */
export function dependencyMap(graph: GraphIndex, ticker: string, config: RiskConfig): Map<string, DirectCandidate> {
  const out = new Map<string, DirectCandidate>();
  const minRank = STRENGTH_RANK[config.sharedMinTier];
  const categories = new Set(config.dependencyCategories);
  for (const edge of graph.forward.get(ticker.toUpperCase()) ?? []) {
    if (!categories.has(edge.category)) continue;
    const tier = edgeTier(edge);
    if (STRENGTH_RANK[tier] < minRank) continue;
    const key = counterpartyKey(edge);
    if (key === ticker.toUpperCase()) continue;
    const candidate: DirectCandidate = { edge, tier, weight: tierWeight(tier, config) };
    out.set(key, betterDirect(out.get(key) ?? null, candidate));
  }
  return out;
}

export type PairLink = Omit<NetworkLink, "pair_weight">;

/** The pairwise link l_ab and the evidence behind it (null when unlinked). */
export function pairLink(graph: GraphIndex, a: string, b: string, config: RiskConfig): PairLink | null {
  const A = a.toUpperCase();
  const B = b.toUpperCase();
  let direct: DirectCandidate | null = null;
  for (const edge of directEdges(graph, A, B)) {
    const tier = edgeTier(edge);
    direct = betterDirect(direct, { edge, tier, weight: tierWeight(tier, config) });
  }

  let shared: { key: string; a: DirectCandidate; b: DirectCandidate; link: number } | null = null;
  const depsA = dependencyMap(graph, A, config);
  if (depsA.size > 0) {
    const depsB = dependencyMap(graph, B, config);
    for (const [key, candA] of depsA) {
      const candB = depsB.get(key);
      if (!candB) continue;
      if (key === A || key === B) continue;
      const link = config.sharedDependencyFactor * Math.min(candA.weight, candB.weight);
      if (!shared || link > shared.link || (link === shared.link && key < shared.key)) {
        shared = { key, a: candA, b: candB, link };
      }
    }
  }

  const directLink = direct ? direct.weight : 0;
  const sharedLink = shared ? shared.link : 0;
  if (directLink <= 0 && sharedLink <= 0) return null;

  if (direct && directLink >= sharedLink) {
    const rootIsA = direct.edge.root_ticker.toUpperCase() === A;
    return {
      a: rootIsA ? A : B,
      b: rootIsA ? B : A,
      via: "direct",
      category: direct.edge.category,
      tier: direct.tier,
      link: directLink,
      edge_id: direct.edge.id,
      edge_id_b: null,
      counterparty: null,
      counterparty_label: null,
      evidence_quote: direct.edge.evidence_quote ?? "",
    };
  }
  const s = shared!;
  const weaker = s.a.weight <= s.b.weight ? s.a : s.b;
  return {
    a: A,
    b: B,
    via: "shared",
    category: weaker.edge.category,
    tier: weaker.tier,
    link: sharedLink,
    edge_id: s.a.edge.id,
    edge_id_b: s.b.edge.id,
    counterparty: s.key,
    counterparty_label: graph.labels.get(s.key) ?? s.a.edge.counterparty_name ?? s.key,
    evidence_quote: weaker.edge.evidence_quote ?? "",
  };
}

export type LinkedFractionResult = {
  linked_fraction: number;
  pair_count: number;
  excluded: string[];
  links: NetworkLink[];
};

/** linked_fraction over the held weights; links sorted by weighted link, descending. */
export function linkedFraction(weights: RiskWeight[], graph: GraphIndex | null, config: RiskConfig): LinkedFractionResult {
  if (!graph) {
    return { linked_fraction: 0, pair_count: 0, excluded: weights.map((w) => w.ticker), links: [] };
  }
  const known = weights.filter((w) => graphKnowsTicker(graph, w.ticker));
  const excluded = weights.filter((w) => !graphKnowsTicker(graph, w.ticker)).map((w) => w.ticker);
  let numerator = 0;
  let denominator = 0;
  let pairs = 0;
  const links: NetworkLink[] = [];
  for (let i = 0; i < known.length; i++) {
    for (let j = i + 1; j < known.length; j++) {
      const wi = known[i];
      const wj = known[j];
      const pairWeight = wi.weight * wj.weight;
      denominator += pairWeight;
      pairs += 1;
      const link = pairLink(graph, wi.ticker, wj.ticker, config);
      if (!link) continue;
      numerator += pairWeight * link.link;
      links.push({ ...link, pair_weight: pairWeight });
    }
  }
  links.sort((x, y) => y.pair_weight * y.link - x.pair_weight * x.link || y.link - x.link || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return {
    linked_fraction: denominator > 0 ? numerator / denominator : 0,
    pair_count: pairs,
    excluded,
    links,
  };
}
