import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import type { LinkEvidence, Relation } from "@falcon/ripple";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { TICKER_PATTERN } from "@/lib/onboarding";
import type { GraphAll, GraphNeighborhood } from "@/lib/workspace/graph";
import { knownAsOf, parseAsOf, type PitAll, type PitShardEdge } from "@/lib/workspace/graph-pit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The neighborhood of some tickers in the engine's filing graph, for the
 * Workspace's Graph and Ticker tabs and the iPhone app's connections.
 *
 *   GET /api/graph?tickers=NVDA,AAPL&depth=2  ->  200 GraphNeighborhood
 *   GET /api/graph?all=1                      ->  200 GraphAll (whole graph, no quotes)
 *   GET /api/graph?tickers=NVDA&asOf=2018-06-30[&ended=1]
 *   GET /api/graph?all=1&asOf=2018-06-30[&ended=1]
 *        point in time: only links whose first annual report was filed on or
 *        before asOf (data/graph/_pit/, lib/workspace/graph-pit.ts), with the
 *        first report's quote as evidence and `firstSeen` / `endedAt` on each
 *        edge; links a later report (filed by asOf) stopped naming are left
 *        out unless ended=1. 400 for a bad date, 404 when not built.
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

let all: string | null = null;

/** The whole graph, compact (data/graph/_all.json, see scripts/graph-shards.mjs); null when not built. */
function wholeGraph(): string | null {
  if (all === null && DIR) {
    try {
      all = fs.readFileSync(path.join(DIR, "_all.json"), "utf8");
    } catch {
      all = null;
    }
  }
  return all;
}

const pitShards = new Map<string, PitShardEdge[]>();

/** A ticker's point-in-time links (data/graph/_pit/<TICKER>.json); none when it has no file. */
function pitShard(ticker: string): PitShardEdge[] {
  const known = pitShards.get(ticker);
  if (known) return known;
  let edges: PitShardEdge[] = [];
  if (DIR && TICKER_PATTERN.test(ticker)) {
    try {
      edges = (JSON.parse(fs.readFileSync(path.join(DIR, "_pit", `${ticker}.json`), "utf8")) as { edges: PitShardEdge[] }).edges;
    } catch {
      edges = [];
    }
  }
  if (pitShards.size >= MAX_CACHED) pitShards.clear();
  pitShards.set(ticker, edges);
  return edges;
}

let pitAll: PitAll | null = null;
function pitWhole(): PitAll | null {
  if (pitAll === null && DIR) {
    try {
      pitAll = JSON.parse(fs.readFileSync(path.join(DIR, "_pit", "_all.json"), "utf8")) as PitAll;
    } catch {
      pitAll = null;
    }
  }
  return pitAll;
}

/** The whole graph as known on `asOf`, in GraphAll's shape (names and sectors from today's file). */
function wholeGraphAsOf(asOf: string, includeEnded: boolean): (GraphAll & { asOf: string; since: string }) | null {
  const pit = pitWhole();
  if (!pit) return null;
  const today = (() => {
    try {
      return JSON.parse(wholeGraph() ?? "") as GraphAll;
    } catch {
      return { n: [], e: [] } as GraphAll;
    }
  })();
  const meta = new Map(today.n.map((n) => [n[0], n]));
  const pairs = new Map<string, [string, string, number, number]>();
  for (const r of pit.e) {
    if (!knownAsOf({ firstSeen: r[4], endedAt: r[6] || null }, asOf, includeEnded)) continue;
    const a = pit.t[r[0]]!;
    const b = pit.t[r[1]]!;
    const key = pairKey(a, b);
    const known = pairs.get(key);
    if (!known || r[3] > known[3]) pairs.set(key, [a, b, r[2], r[3]]);
  }
  const index = new Map<string, number>();
  const n: GraphAll["n"] = [];
  const at = (t: string) => {
    let i = index.get(t);
    if (i === undefined) {
      i = n.length;
      index.set(t, i);
      const m = meta.get(t);
      n.push([t, m?.[1] ?? nameOf(t), 0, m?.[3] ?? ""]);
    }
    return i;
  };
  const e: GraphAll["e"] = [];
  for (const [a, b, rel, strength] of pairs.values()) {
    const i = at(a);
    const j = at(b);
    n[i]![2]++;
    n[j]![2]++;
    e.push([i, j, rel, strength]);
  }
  return { asOf, since: pit.since, n, e };
}

function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export async function GET(request: Request) {
  const limit = rateLimit(`graph:${clientIp(request)}`, { limit: 120, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);

  const params = new URL(request.url).searchParams;
  const asOfRaw = params.get("asOf") ?? params.get("as_of");
  const asOf = asOfRaw ? parseAsOf(asOfRaw) : null;
  if (asOfRaw && !asOf) return NextResponse.json({ error: "asOf must be a date: YYYY-MM-DD, YYYY-MM or YYYY" }, { status: 400 });
  const includeEnded = params.get("ended") === "1";
  if (asOf && params.get("all") === "1") {
    const body = wholeGraphAsOf(asOf, includeEnded);
    if (!body) return NextResponse.json({ error: "Point-in-time graph not built" }, { status: 404 });
    return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=600, stale-while-revalidate=86400" } });
  }
  if (asOf && !pitWhole()) return NextResponse.json({ error: "Point-in-time graph not built" }, { status: 404 });
  if (params.get("all") === "1") {
    const body = wholeGraph();
    if (!body) return NextResponse.json({ error: "Graph not built" }, { status: 404 });
    return new NextResponse(body, {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=600, stale-while-revalidate=86400" },
    });
  }
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
    const steps: { e: ShardEdge & Partial<PitShardEdge>; from: string; turn: number }[] = [];
    for (const ticker of frontier) {
      (asOf ? pitShard(ticker).filter((e) => knownAsOf(e, asOf, includeEnded)) : shard(ticker))
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
      edges.set(key, {
        source: e.from,
        target: e.to,
        relation: RELATION[e.category] ?? null,
        evidence: [evidence],
        ...(asOf && e.firstSeen ? { firstSeen: e.firstSeen, lastSeen: e.lastSeen, endedAt: e.endedAt ?? null } : {}),
      });
    }
    frontier = next;
  }

  // Links between two companies already in the answer, found on the way, stay;
  // links to companies left out by the cap go.
  const body: GraphNeighborhood & { asOf?: string } = {
    ...(asOf ? { asOf } : {}),
    nodes: Array.from(seen).map((ticker) => ({ ticker, name: nameOf(ticker), sector: null })),
    edges: Array.from(edges.values()).filter((e) => seen.has(e.source) && seen.has(e.target)),
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "private, max-age=300" } });
}
