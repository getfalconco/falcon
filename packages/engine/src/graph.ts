/**
 * The filing graph: company links that a 10-K or 20-F states, each with the
 * quote that states it. Loaded from data/graph.json (built by
 * scripts/build-graph.ts) and walked one or two links out from a company.
 *
 * An edge is written from the filer's side: `from` is the company whose
 * filing says it, `to` the company it names, `category` what `to` is to
 * `from` ("NVDA supplier TSM": NVIDIA's 10-K names TSMC as a supplier).
 */

import fs from "node:fs";
import path from "node:path";
import type { LinkEvidence, Relation } from "@falcon/ripple";
import { ENGINE_ROOT } from "./http.ts";

export type EdgeCategory = "supplier" | "customer" | "competitor" | "partner";
export type StrengthTier = "critical" | "important" | "marginal";

export type GraphEdge = {
  id: string;
  /** Ticker of the filer. */
  from: string;
  /** Ticker of the company named, or null when it has no US listing we use. */
  to: string | null;
  /** The name as the filing writes it. */
  toName: string;
  category: EdgeCategory;
  /** critical / important / marginal, as classified at extraction. */
  tier: StrengthTier;
  /** Share the filing states (revenue share, purchase share), percent; null when none. */
  disclosedSharePct: number | null;
  quote: string;
  form: string;
  filedAt: string;
  url: string;
  /** Where the edge came from: the old step1 extraction or a later manual read. */
  origin: string;
};

export type Graph = {
  generatedAt: string;
  names: Record<string, string>;
  edges: GraphEdge[];
};

export const GRAPH_PATH = path.join(ENGINE_ROOT, "data", "graph.json");

let cached: Graph | null = null;

export function loadGraph(file = GRAPH_PATH): Graph {
  if (cached && file === GRAPH_PATH) return cached;
  const g = JSON.parse(fs.readFileSync(file, "utf8")) as Graph;
  if (file === GRAPH_PATH) cached = g;
  return g;
}

/** What the other company is to `self`, read from an edge either way round. Pure. */
export function relationFrom(edge: Pick<GraphEdge, "from" | "category">, self: string): Relation {
  const own = edge.from === self;
  switch (edge.category) {
    case "supplier":
      return own ? "supplier" : "customer";
    case "customer":
      return own ? "customer" : "supplier";
    case "competitor":
      return "competitor";
    default:
      return "peer";
  }
}

export type Link = {
  /** The other company's ticker. */
  other: string;
  /** What `other` is to the company the walk stands on. */
  relation: Relation;
  edge: GraphEdge;
};

/** Every listed company one link from `ticker`, with the edge that links them. Pure. */
export function linksOf(graph: Graph, ticker: string): Link[] {
  const out: Link[] = [];
  for (const edge of graph.edges) {
    if (edge.from === ticker && edge.to && edge.to !== ticker) {
      out.push({ other: edge.to, relation: relationFrom(edge, ticker), edge });
    } else if (edge.to === ticker && edge.from !== ticker) {
      out.push({ other: edge.from, relation: relationFrom(edge, ticker), edge });
    }
  }
  return out;
}

export type Path = {
  ticker: string;
  degree: 1 | 2;
  /** Degree 2: the company in between. */
  via?: string;
  /** Degree 1: what `ticker` is to the event company. Degree 2: what it is to `via`. */
  relation: Relation;
  /** Degree 2: what `via` is to the event company. */
  viaRelation?: Relation;
  edges: GraphEdge[];
};

const TIER_WEIGHT: Record<StrengthTier, number> = { critical: 3, important: 2, marginal: 1 };

export function edgeWeight(edge: GraphEdge): number {
  return TIER_WEIGHT[edge.tier] + (edge.disclosedSharePct !== null ? 1 : 0);
}

/**
 * Companies one and two links out from `ticker`. Degree 1 first; a company
 * reached directly is not listed again at degree 2. Several edges between the
 * same two companies (a competitor that is also a supplier) stay together.
 * Degree 2 keeps only paths whose both links are supply-chain links
 * (customer or supplier) or whose first link is one: two competitor hops say
 * little. Pure.
 */
export function walk(graph: Graph, ticker: string, maxDegree: 1 | 2 = 2): Path[] {
  const direct = new Map<string, Path>();
  for (const link of linksOf(graph, ticker)) {
    const known = direct.get(link.other);
    if (known) {
      known.edges.push(link.edge);
      // A supply-chain relation says more than "competitor" or "peer".
      if (rank(link.relation) > rank(known.relation)) known.relation = link.relation;
    } else {
      direct.set(link.other, { ticker: link.other, degree: 1, relation: link.relation, edges: [link.edge] });
    }
  }
  const out = [...direct.values()];
  if (maxDegree === 1) return out;
  const second = new Map<string, Path>();
  for (const mid of direct.values()) {
    if (mid.relation !== "customer" && mid.relation !== "supplier") continue;
    for (const link of linksOf(graph, mid.ticker)) {
      if (link.other === ticker || direct.has(link.other)) continue;
      if (link.relation === "peer") continue;
      const candidate: Path = {
        ticker: link.other,
        degree: 2,
        via: mid.ticker,
        relation: link.relation,
        viaRelation: mid.relation,
        edges: [strongest(mid.edges), link.edge],
      };
      const known = second.get(link.other);
      if (!known || pathWeight(candidate) > pathWeight(known)) second.set(link.other, candidate);
    }
  }
  return [...out, ...second.values()];
}

function rank(r: Relation): number {
  return r === "customer" || r === "supplier" ? 2 : r === "competitor" ? 1 : 0;
}

function strongest(edges: GraphEdge[]): GraphEdge {
  return [...edges].sort((a, b) => edgeWeight(b) - edgeWeight(a))[0]!;
}

export function pathWeight(p: Path): number {
  const best = Math.max(...p.edges.map(edgeWeight));
  const rel = rank(p.relation) + 1;
  return p.degree === 1 ? best * rel : (Math.min(...p.edges.map(edgeWeight)) * rel) / 2;
}

export function evidenceOf(edge: GraphEdge): LinkEvidence {
  return { quote: edge.quote, form: edge.form, filedAt: edge.filedAt, url: edge.url };
}

export function nameOf(graph: Graph, ticker: string): string {
  return graph.names[ticker] ?? ticker;
}
