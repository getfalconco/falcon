import type { Direction, LinkEvidence, Relation, SightingsFeed } from "@falcon/ripple";
import { inverseRelation, netDirection, relationPhrase, type Connection } from "./feed";

/**
 * The connection graph the Workspace draws: companies as nodes, filing-backed
 * links as edges. Built from the Sightings feed (event company to each company
 * it hits) and, when the engine's seed graph is served, GET /api/graph.
 */

/** Sector label for companies the feed has not filed under one. */
export const UNCLASSIFIED = "Unclassified";

export type GraphNode = {
  id: string;
  name: string;
  sector: string;
  /** Steps from the nearest seed (portfolio) ticker: 0, 1 or 2. */
  depth: number;
  focus: boolean;
  /** Net direction of today's hits on this company, null with none. */
  net: number | null;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relation: Relation | null;
  evidence: LinkEvidence[];
};

export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

/** What GET /api/graph returns: the neighborhood of the asked tickers. */
export type GraphNeighborhood = {
  nodes: { ticker: string; name: string; sector?: string | null }[];
  edges: {
    source: string;
    target: string;
    relation: Relation | null;
    evidence?: LinkEvidence[];
    /** Only with ?asOf= (lib/workspace/graph-pit.ts): first and last annual report naming the link, and when a later one stopped. */
    firstSeen?: string;
    lastSeen?: string;
    endedAt?: string | null;
  }[];
};

/**
 * What GET /api/graph?all=1 returns: every company and link in the filing
 * graph, compact (scripts/graph-shards.mjs). `n` is [ticker, short name,
 * degree]; `e` is [source index, target index, relation, strength] with
 * relation 0 supplier, 1 customer, 2 competitor, 3 partner and strength
 * 3 critical, 2 important, 1 marginal.
 */
export type GraphAll = {
  /** Sector: from the SEC SIC code (scripts/sic-sectors.mjs); "" when unknown, missing in payloads built before it. */
  n: [ticker: string, name: string, degree: number, sector?: string][];
  e: [source: number, target: number, relation: number, strength: number][];
};

type RawEdge = { source: string; target: string; relation: Relation | null; evidence: LinkEvidence[] };

function edgeKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export type GraphFilter = {
  sectors: Set<string> | null;
  relations: Set<Relation> | null;
};

/**
 * The graph within `maxDepth` steps of the seeds. Filters drop edges by
 * relation and nodes by sector before the walk, so what stays is still
 * connected to a seed.
 */
export function buildGraph(
  feed: SightingsFeed | null,
  extra: GraphNeighborhood | null,
  seeds: readonly string[],
  opts: { maxDepth?: number; filter?: GraphFilter; maxNodes?: number } = {},
): Graph {
  const maxDepth = opts.maxDepth ?? 2;
  const maxNodes = opts.maxNodes ?? 160;
  const names = new Map<string, string>();
  const sectors = new Map<string, string>();
  const hitsBy = new Map<string, { direction: Direction; confidence: "low" | "medium" | "high"; degree: 1 | 2 }[]>();
  const edges = new Map<string, RawEdge>();

  const addEdge = (source: string, target: string, relation: Relation | null, evidence: LinkEvidence[] = []) => {
    if (source === target) return;
    const k = edgeKey(source, target);
    const existing = edges.get(k);
    if (existing) {
      if (!existing.relation && relation) existing.relation = relation;
      for (const e of evidence) if (!existing.evidence.some((x) => x.quote === e.quote)) existing.evidence.push(e);
      return;
    }
    edges.set(k, { source, target, relation, evidence: [...evidence] });
  };

  for (const card of feed?.cards ?? []) {
    const e = card.event;
    names.set(e.ticker, e.companyName);
    if (!sectors.has(e.ticker)) sectors.set(e.ticker, card.sector);
    for (const h of card.hits) {
      if (!names.has(h.ticker)) names.set(h.ticker, h.companyName);
      if (!sectors.has(h.ticker)) sectors.set(h.ticker, card.sector);
      const list = hitsBy.get(h.ticker) ?? [];
      list.push(h);
      hitsBy.set(h.ticker, list);
      if (h.degree === 2 && h.via) {
        const viaHit = card.hits.find((x) => x.ticker === h.via);
        addEdge(e.ticker, h.via, viaHit?.relation ?? null, viaHit?.evidence);
        addEdge(h.via, h.ticker, h.relation, h.evidence);
      } else {
        addEdge(e.ticker, h.ticker, h.relation, h.evidence);
      }
    }
  }

  // The feed's names and sectors win; the seed graph fills in the rest.
  for (const n of extra?.nodes ?? []) {
    if (n.name && !names.has(n.ticker)) names.set(n.ticker, n.name);
    if (n.sector && !sectors.has(n.ticker)) sectors.set(n.ticker, n.sector);
  }
  for (const e of extra?.edges ?? []) addEdge(e.source, e.target, e.relation, e.evidence ?? []);

  const filter = opts.filter;
  const seedSet = new Set(seeds);
  const allowedNode = (id: string) => seedSet.has(id) || !filter?.sectors || filter.sectors.has(sectors.get(id) ?? UNCLASSIFIED);
  const allowedEdge = (e: RawEdge) => !filter?.relations || (e.relation !== null && filter.relations.has(e.relation));

  const adjacency = new Map<string, string[]>();
  for (const e of Array.from(edges.values())) {
    if (!allowedEdge(e) || !allowedNode(e.source) || !allowedNode(e.target)) continue;
    (adjacency.get(e.source) ?? adjacency.set(e.source, []).get(e.source)!).push(e.target);
    (adjacency.get(e.target) ?? adjacency.set(e.target, []).get(e.target)!).push(e.source);
  }

  // Breadth first from the seeds; nearer companies win when the cap is hit.
  const depth = new Map<string, number>();
  let frontier = Array.from(seedSet);
  for (const s of frontier) depth.set(s, 0);
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adjacency.get(id) ?? []) {
        if (depth.has(n) || depth.size >= maxNodes) continue;
        depth.set(n, d);
        next.push(n);
      }
    }
    frontier = next;
  }

  const nodes: GraphNode[] = Array.from(depth.entries()).map(([id, d]) => ({
    id,
    name: names.get(id) ?? id,
    sector: sectors.get(id) ?? UNCLASSIFIED,
    depth: d,
    focus: seedSet.has(id),
    net: netDirection(hitsBy.get(id) ?? []),
  }));
  const kept = new Set(depth.keys());
  const graphEdges: GraphEdge[] = Array.from(edges.values())
    .filter((e) => kept.has(e.source) && kept.has(e.target) && allowedEdge(e))
    .map((e) => ({ id: edgeKey(e.source, e.target), ...e }));
  return { nodes, edges: graphEdges };
}

/**
 * Companies linked to `ticker` in the seed graph, as Ticker tab connections,
 * merged after the feed's own (feed first, quotes deduplicated).
 */
export function withSeedConnections(feedConnections: Connection[], extra: GraphNeighborhood | null, ticker: string): Connection[] {
  const byTicker = new Map<string, Connection>();
  for (const c of feedConnections) byTicker.set(c.ticker, { ...c, evidence: [...c.evidence] });
  const names = new Map((extra?.nodes ?? []).map((n) => [n.ticker, n.name]));
  for (const e of extra?.edges ?? []) {
    if (e.source !== ticker && e.target !== ticker) continue;
    const other = e.source === ticker ? e.target : e.source;
    // `relation` is what target is to source; turn it to what `other` is to `ticker`.
    const relation = e.relation ? (e.source === ticker ? e.relation : inverseRelation(e.relation)) : null;
    const existing = byTicker.get(other);
    if (existing) {
      for (const q of e.evidence ?? []) if (!existing.evidence.some((x) => x.quote === q.quote)) existing.evidence.push(q);
      if (!existing.relation && relation) existing.relation = relation;
      continue;
    }
    byTicker.set(other, {
      ticker: other,
      companyName: names.get(other) ?? other,
      relation,
      phrase: relation ? relationPhrase(relation, ticker) : `Linked to ${ticker}`,
      evidence: [...(e.evidence ?? [])],
      cardIds: [],
    });
  }
  return Array.from(byTicker.values()).sort(
    (a, b) => b.cardIds.length - a.cardIds.length || b.evidence.length - a.evidence.length || a.ticker.localeCompare(b.ticker),
  );
}
