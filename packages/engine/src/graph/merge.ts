/**
 * The live graph (data/graph.json) = the seed graph (data/graph-seed.json:
 * the old step1 links and the ones read by hand, built by
 * scripts/build-graph.ts) + the whole-market extraction
 * (data/graph-v1.json, scripts/graph-extract.ts), in the seed's shape.
 *
 *   - Every seed edge stays, unless the extraction contradicts it with a
 *     quote: the same filer names the same company, on a filing at least as
 *     new, only under other relations, and one of those was first read as
 *     the seed's relation and changed by the second read of its quote.
 *   - Extracted edges join when their relation is shipped (`relations`), the
 *     second read did not reject them, and (by default) both ends have a
 *     ticker: `walk()` and the web route skip the rest, which stay in
 *     graph-v1.json for later resolvers.
 *   - Never an exchange-traded fund's market makers: a quote naming
 *     Authorized Participants or trading counterparties (the quality gate
 *     found these read as links).
 *   - The same edge id in both: the seed's (read by hand or checked against
 *     the seed's own filing) wins.
 *
 * Pure.
 */

import type { EdgeCategory, Graph, GraphEdge } from "../graph.ts";

/** Quotes about who creates, redeems or trades a fund's shares: not a business link. */
export const MARKET_MAKER_QUOTE = /\bAuthori[sz]ed Participants?\b|\btrading counterpart(y|ies)\b|\bParticipant Agreements?\b/i;

type Fresh = GraphEdge & { verified?: boolean; extractedAs?: EdgeCategory };

export type MergeResult = {
  graph: Graph;
  stats: { seed: number; seedKept: number; fresh: number; freshKept: number; freshSameId: number; byRelation: Record<string, number> };
  contradicted: Array<{ seed: GraphEdge; by: GraphEdge[] }>;
};

export function mergeGraphs(seed: Graph, fresh: Graph, opts: { relations: ReadonlySet<EdgeCategory>; keepUnresolved?: boolean; generatedAt?: string }): MergeResult {
  const freshEdges = fresh.edges as Fresh[];
  const pair = (e: Pick<GraphEdge, "from" | "to">) => `${e.from}|${e.to}`;
  const freshByPair = new Map<string, Fresh[]>();
  for (const e of freshEdges) {
    if (!e.to) continue;
    const list = freshByPair.get(pair(e)) ?? [];
    list.push(e);
    freshByPair.set(pair(e), list);
  }

  const contradicted: MergeResult["contradicted"] = [];
  const kept: GraphEdge[] = [];
  for (const s of seed.edges) {
    const same = s.to ? (freshByPair.get(pair(s)) ?? []) : [];
    const newer = same.filter((e) => e.filedAt >= s.filedAt);
    if (newer.length && !newer.some((e) => e.category === s.category) && newer.some((e) => e.extractedAs === s.category)) {
      contradicted.push({ seed: s, by: newer });
      continue;
    }
    kept.push(s);
  }

  const ids = new Set(kept.map((e) => e.id));
  const seedIds = new Set(seed.edges.map((e) => e.id));
  let freshSameId = 0;
  const added: GraphEdge[] = [];
  for (const e of freshEdges) {
    if (!opts.relations.has(e.category)) continue;
    if (e.verified === false) continue;
    if (MARKET_MAKER_QUOTE.test(e.quote)) continue;
    if (!e.to && !opts.keepUnresolved) continue;
    if (seedIds.has(e.id)) {
      freshSameId++;
      continue;
    }
    if (ids.has(e.id)) continue;
    ids.add(e.id);
    added.push(e);
  }

  const edges = [...kept, ...added];
  const used = new Set(edges.flatMap((e) => [e.from, e.to ?? ""]));
  const names: Record<string, string> = {};
  for (const [t, n] of Object.entries(fresh.names)) if (used.has(t)) names[t] = n;
  Object.assign(names, seed.names);
  const byRelation: Record<string, number> = {};
  for (const e of edges) byRelation[e.category] = (byRelation[e.category] ?? 0) + 1;
  return {
    graph: { generatedAt: opts.generatedAt ?? new Date().toISOString(), names, edges },
    stats: { seed: seed.edges.length, seedKept: kept.length, fresh: freshEdges.length, freshKept: added.length, freshSameId, byRelation },
    contradicted,
  };
}
