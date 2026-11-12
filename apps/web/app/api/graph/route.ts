import { NextResponse } from "next/server";
import type { LinkEvidence, Relation } from "@falcon/ripple";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { TICKER_PATTERN } from "@/lib/onboarding";
import type { GraphNeighborhood } from "@/lib/workspace/graph";
// The Ripple Engine's seed graph (packages/engine, scripts/build-graph.ts),
// bundled into this route at build time.
import seed from "../../../../../packages/engine/data/graph.json";

export const dynamic = "force-dynamic";

/**
 * The neighborhood of some tickers in the engine's filing graph, for the
 * Workspace's Graph and Ticker tabs.
 *
 *   GET /api/graph?tickers=NVDA,AAPL&depth=2  ->  200 GraphNeighborhood
 *
 * Edges in the file are written from the filer's side: `category` is what
 * `to` is to `from`. Here `relation` keeps that meaning (what `target` is to
 * `source`), with "partner" shown as "peer". Depth 1 or 2; the second step
 * follows only critical and important links so the answer stays readable.
 */

type SeedEdge = {
  from: string;
  to: string | null;
  toName: string;
  category: string;
  tier: string;
  quote: string;
  form: string;
  filedAt: string;
  url: string;
};

type Seed = { names: Record<string, string>; edges: SeedEdge[] };

const MAX_TICKERS = 30;
const MAX_NODES = 160;
const MAX_QUOTES = 3;

const RELATION: Record<string, Relation> = {
  supplier: "supplier",
  customer: "customer",
  competitor: "competitor",
  partner: "peer",
};

const TIER_RANK: Record<string, number> = { critical: 0, important: 1, marginal: 2 };

const graph = seed as unknown as Seed;

/** Listed edges by ticker, strongest first. Built once per server instance. */
const byTicker = (() => {
  const map = new Map<string, SeedEdge[]>();
  for (const e of graph.edges) {
    if (!e.to || e.to === e.from) continue;
    for (const t of [e.from, e.to]) {
      const list = map.get(t) ?? [];
      list.push(e);
      map.set(t, list);
    }
  }
  map.forEach((list) => list.sort((a, b) => (TIER_RANK[a.tier] ?? 3) - (TIER_RANK[b.tier] ?? 3)));
  return map;
})();

function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export async function GET(request: Request) {
  const limit = rateLimit(`graph:${clientIp(request)}`, { limit: 120, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);

  const params = new URL(request.url).searchParams;
  const seeds = Array.from(
    new Set(
      (params.get("tickers") ?? "")
        .split(",")
        .map((t) => t.trim().toUpperCase())
        .filter((t) => TICKER_PATTERN.test(t)),
    ),
  ).slice(0, MAX_TICKERS);
  const depth = params.get("depth") === "1" ? 1 : 2;

  const seen = new Set<string>(seeds);
  const edges = new Map<string, GraphNeighborhood["edges"][number]>();
  let frontier = seeds;

  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const ticker of frontier) {
      for (const e of byTicker.get(ticker) ?? []) {
        if (d > 1 && e.tier === "marginal") continue;
        const other = e.from === ticker ? e.to! : e.from;
        if (!seen.has(other)) {
          if (seen.size >= MAX_NODES) continue;
          seen.add(other);
          next.push(other);
        }
        const key = pairKey(e.from, e.to!);
        const evidence: LinkEvidence = { quote: e.quote, form: e.form, filedAt: e.filedAt, url: e.url };
        const existing = edges.get(key);
        if (existing) {
          if (existing.evidence && existing.evidence.length < MAX_QUOTES && !existing.evidence.some((x) => x.quote === e.quote)) {
            existing.evidence.push(evidence);
          }
          continue;
        }
        edges.set(key, { source: e.from, target: e.to!, relation: RELATION[e.category] ?? null, evidence: [evidence] });
      }
    }
    frontier = next;
  }

  // Links between two companies already in the answer, found on the way, stay;
  // links to companies left out by the cap go.
  const body: GraphNeighborhood = {
    nodes: Array.from(seen).map((ticker) => ({ ticker, name: graph.names[ticker] ?? ticker, sector: null })),
    edges: Array.from(edges.values()).filter((e) => seen.has(e.source) && seen.has(e.target)),
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "private, max-age=300" } });
}
