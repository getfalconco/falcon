import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import type { LinkEvidence, Relation } from "@falcon/ripple";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { TICKER_PATTERN } from "@/lib/onboarding";
import type { GraphNeighborhood } from "@/lib/workspace/graph";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The neighborhood of some tickers in the engine's filing graph, for the
 * Workspace's Graph and Ticker tabs and the iPhone app's connections.
 *
 *   GET /api/graph?tickers=NVDA,AAPL&depth=2  ->  200 GraphNeighborhood
 *
 * The graph (packages/engine/data/graph.json) is split per ticker at build
 * time (scripts/graph-shards.mjs -> data/graph/), so a request reads only the
 * files of the companies it walks through, never the whole graph.
 *
 * Edges in the file are written from the filer's side: `category` is what
 * `to` is to `from`. Here `relation` keeps that meaning (what `target` is to
 * `source`), with "partner" shown as "peer". Depth 1 or 2; the second step
 * follows only critical and important links so the answer stays readable.
 * When the node cap is hit, stronger links win: each step takes critical
 * links before important before marginal, the seeds taking turns, and the
 * edges come back in that order.
 */

type ShardEdge = {
  from: string;
  to: string;
  category: string;
  tier: string;
  disclosedSharePct: number | null;
  quote: string;
  form: string;
  filedAt: string;
  url: string;
};

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

/** data/graph/ beside the app: the working directory in dev and in the deployed function, or the repo root. */
const DIR = [path.join(process.cwd(), "data", "graph"), path.join(process.cwd(), "apps", "web", "data", "graph")].find((d) =>
  fs.existsSync(path.join(d, "_names.json")),
);

let names: Record<string, string> | null = null;
const shards = new Map<string, ShardEdge[]>();
const MAX_CACHED = 2000;

function nameOf(ticker: string): string {
  if (!names) {
    try {
      names = DIR ? (JSON.parse(fs.readFileSync(path.join(DIR, "_names.json"), "utf8")) as Record<string, string>) : {};
    } catch {
      names = {};
    }
  }
  return names[ticker] ?? ticker;
}

/** A ticker's links, strongest first; none when it has no file. */
function shard(ticker: string): ShardEdge[] {
  const known = shards.get(ticker);
  if (known) return known;
  let edges: ShardEdge[] = [];
  if (DIR && TICKER_PATTERN.test(ticker)) {
    try {
      edges = (JSON.parse(fs.readFileSync(path.join(DIR, `${ticker}.json`), "utf8")) as { edges: ShardEdge[] }).edges;
    } catch {
      edges = [];
    }
  }
  if (shards.size >= MAX_CACHED) shards.clear();
  shards.set(ticker, edges);
  return edges;
}

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
    // Every link out of this step's companies, strongest first, the companies taking turns.
    const steps: { e: ShardEdge; from: string; turn: number }[] = [];
    for (const ticker of frontier) {
      shard(ticker)
        .filter((e) => d === 1 || e.tier !== "marginal")
        .forEach((e, turn) => steps.push({ e, from: ticker, turn }));
    }
    steps.sort((a, b) => (TIER_RANK[a.e.tier] ?? 3) - (TIER_RANK[b.e.tier] ?? 3) || a.turn - b.turn);

    const next: string[] = [];
    for (const { e, from } of steps) {
      const other = e.from === from ? e.to : e.from;
      if (!seen.has(other)) {
        if (seen.size >= MAX_NODES) continue;
        seen.add(other);
        next.push(other);
      }
      const key = pairKey(e.from, e.to);
      const evidence: LinkEvidence = { quote: e.quote, form: e.form, filedAt: e.filedAt, url: e.url };
      const existing = edges.get(key);
      if (existing) {
        if (existing.evidence && existing.evidence.length < MAX_QUOTES && !existing.evidence.some((x) => x.quote === e.quote)) {
          existing.evidence.push(evidence);
        }
        continue;
      }
      edges.set(key, { source: e.from, target: e.to, relation: RELATION[e.category] ?? null, evidence: [evidence] });
    }
    frontier = next;
  }

  // Links between two companies already in the answer, found on the way, stay;
  // links to companies left out by the cap go.
  const body: GraphNeighborhood = {
    nodes: Array.from(seen).map((ticker) => ({ ticker, name: nameOf(ticker), sector: null })),
    edges: Array.from(edges.values()).filter((e) => seen.has(e.source) && seen.has(e.target)),
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "private, max-age=300" } });
}
