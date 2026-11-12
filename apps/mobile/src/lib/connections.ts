import { useEffect, useState } from "react";
import type { LinkEvidence, Relation, RippleCard } from "@falcon/ripple";
import { appApiUrl } from "./env";

/**
 * A company's filing-backed links: the engine's filing graph
 * (GET /api/graph?tickers=X&depth=1 on the app host) and, when that can't be
 * reached, the links today's Sightings cards carry.
 */

/** One linked company and the filing quotes behind the link. */
export type Connection = {
  ticker: string;
  name: string;
  /** What the linked company is to the ticker (its supplier, its customer, ...); null when the filing doesn't say. */
  relation: Relation | null;
  evidence: LinkEvidence[];
};

export type ConnectionsState = {
  status: "loading" | "ready";
  connections: Connection[];
  /** The ticker's company name as the graph knows it. */
  name: string | null;
};

type GraphNeighborhood = {
  nodes: { ticker: string; name: string }[];
  edges: { source: string; target: string; relation: Relation | null; evidence?: LinkEvidence[] }[];
};

const INVERSE: Record<Relation, Relation> = {
  customer: "supplier",
  supplier: "customer",
  competitor: "competitor",
  peer: "peer",
};

const TIMEOUT_MS = 8000;
const cache = new Map<string, { connections: Connection[]; name: string | null }>();

function isNeighborhood(body: unknown): body is GraphNeighborhood {
  if (!body || typeof body !== "object") return false;
  const b = body as Partial<GraphNeighborhood>;
  return Array.isArray(b.nodes) && Array.isArray(b.edges);
}

/** The graph's links of one ticker, seen from its side. */
function fromGraph(ticker: string, graph: GraphNeighborhood): { connections: Connection[]; name: string | null } {
  const names = new Map(graph.nodes.map((n) => [n.ticker.toUpperCase(), n.name]));
  const byTicker = new Map<string, Connection>();
  for (const edge of graph.edges) {
    const source = edge.source.toUpperCase();
    const target = edge.target.toUpperCase();
    if (source !== ticker && target !== ticker) continue;
    // `relation` is what target is to source.
    const other = source === ticker ? target : source;
    const relation = edge.relation ? (source === ticker ? edge.relation : INVERSE[edge.relation]) : null;
    const evidence = (edge.evidence ?? []).filter((e) => e && typeof e.quote === "string" && e.quote.trim() !== "");
    const seen = byTicker.get(other);
    if (seen) {
      for (const e of evidence) if (!seen.evidence.some((x) => x.quote === e.quote)) seen.evidence.push(e);
      continue;
    }
    byTicker.set(other, { ticker: other, name: names.get(other) ?? other, relation, evidence });
  }
  return { connections: Array.from(byTicker.values()), name: names.get(ticker) ?? null };
}

/** The links today's cards carry for one ticker (direct links only). */
export function connectionsFromCards(ticker: string, cards: RippleCard[]): Connection[] {
  const t = ticker.toUpperCase();
  const byTicker = new Map<string, Connection>();
  const add = (other: string, name: string, relation: Relation | null, evidence: LinkEvidence[]) => {
    const key = other.toUpperCase();
    if (key === t) return;
    const seen = byTicker.get(key);
    if (seen) {
      for (const e of evidence) if (!seen.evidence.some((x) => x.quote === e.quote)) seen.evidence.push(e);
      return;
    }
    byTicker.set(key, { ticker: key, name, relation, evidence: [...evidence] });
  };
  for (const card of cards) {
    const eventTicker = card.event.ticker.toUpperCase();
    for (const hit of card.hits) {
      if (hit.degree !== 1) continue;
      // hit.relation is what the hit company is to the event company.
      if (eventTicker === t) add(hit.ticker, hit.companyName, hit.relation, hit.evidence);
      else if (hit.ticker.toUpperCase() === t)
        add(eventTicker, card.event.companyName, INVERSE[hit.relation] ?? null, hit.evidence);
    }
  }
  return Array.from(byTicker.values());
}

async function requestGraph(ticker: string): Promise<GraphNeighborhood> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(appApiUrl(`/api/graph?tickers=${encodeURIComponent(ticker)}&depth=1`), {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`graph ${res.status}`);
    const body: unknown = await res.json();
    if (!isNeighborhood(body)) throw new Error("graph: unexpected body");
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One ticker's connections. The graph answer is kept for the session; the
 * cards' links fill in when the graph has none or can't be reached.
 */
export function useConnections(ticker: string, cards: RippleCard[]): ConnectionsState {
  const t = ticker.toUpperCase();
  const [graph, setGraph] = useState(() => cache.get(t) ?? null);
  const [settled, setSettled] = useState(() => cache.has(t));

  useEffect(() => {
    const cached = cache.get(t);
    if (cached) {
      setGraph(cached);
      setSettled(true);
      return;
    }
    let live = true;
    setGraph(null);
    setSettled(false);
    requestGraph(t)
      .then((body) => {
        const result = fromGraph(t, body);
        cache.set(t, result);
        if (live) setGraph(result);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setSettled(true);
      });
    return () => {
      live = false;
    };
  }, [t]);

  if (!settled) return { status: "loading", connections: [], name: null };
  const fromFeed = connectionsFromCards(t, cards);
  if (!graph || graph.connections.length === 0) return { status: "ready", connections: fromFeed, name: graph?.name ?? null };
  // Links from today's cards that the graph doesn't have yet come after it.
  const known = new Set(graph.connections.map((c) => c.ticker));
  return {
    status: "ready",
    connections: [...graph.connections, ...fromFeed.filter((c) => !known.has(c.ticker))],
    name: graph.name,
  };
}
