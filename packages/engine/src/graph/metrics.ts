/**
 * Pilot measurements for graph extraction: size and shape of a graph, recall
 * against a reference graph (the seed graph's semis edges), a reproducible
 * sample for hand labelling, and precision from those labels. Pure.
 */

import type { EdgeCategory, GraphEdge } from "../graph.ts";
import { namesAgree } from "./resolve.ts";

export type GraphStats = {
  filers: number;
  edges: number;
  /** Edges per filer: mean and median over every filer read (zero-edge filers count). */
  perFiler: { mean: number; median: number; zero: number };
  /** Share of edges with a ticker on both ends. */
  listedShare: number;
  byCategory: Record<string, number>;
  byTier: Record<string, number>;
  withShare: number;
  soleSource: number;
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function count<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

export function graphStats(edges: Array<GraphEdge & { soleSource?: boolean }>, filers: string[]): GraphStats {
  const per = filers.map((f) => edges.filter((e) => e.from === f).length);
  return {
    filers: filers.length,
    edges: edges.length,
    perFiler: { mean: filers.length ? edges.length / filers.length : 0, median: median(per), zero: per.filter((n) => n === 0).length },
    listedShare: edges.length ? edges.filter((e) => e.to !== null).length / edges.length : 0,
    byCategory: count(edges, (e) => e.category),
    byTier: count(edges, (e) => e.tier),
    withShare: edges.filter((e) => e.disclosedSharePct !== null).length,
    soleSource: edges.filter((e) => e.soleSource === true).length,
  };
}

/** Whether two edges link the same pair: same filer, and the same ticker or names that agree. */
export function samePair(a: Pick<GraphEdge, "from" | "to" | "toName">, b: Pick<GraphEdge, "from" | "to" | "toName">): boolean {
  if (a.from !== b.from) return false;
  if (a.to && b.to) return a.to === b.to;
  return namesAgree(a.toName, b.toName);
}

export type Recall = {
  reference: number;
  /** Reference edges whose pair the found graph has, any category. */
  pairs: number;
  /** ... with the same category too. */
  exact: number;
  missed: Array<Pick<GraphEdge, "id" | "from" | "to" | "toName" | "category" | "tier">>;
};

/** Recall of `found` against the reference edges filed by `filers`. */
export function recallAgainst(reference: GraphEdge[], found: GraphEdge[], filers: Set<string>): Recall {
  const ref = reference.filter((e) => filers.has(e.from));
  let pairs = 0;
  let exact = 0;
  const missed: Recall["missed"] = [];
  for (const r of ref) {
    const hits = found.filter((f) => samePair(r, f));
    if (hits.length) pairs++;
    else missed.push({ id: r.id, from: r.from, to: r.to, toName: r.toName, category: r.category, tier: r.tier });
    if (hits.some((h) => h.category === r.category)) exact++;
  }
  return { reference: ref.length, pairs, exact, missed };
}

/** `n` items in a seeded random order (mulberry32), the same every run. */
export function sampleEdges<T>(items: T[], n: number, seed = 20261114): T[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

/**
 * A hand label: what the counterparty really is to the filer per the quote,
 * or "none"; `alt` a second reading the quote also supports (an in-licence
 * is a supplier by the prompt's rule, a partner by industry usage).
 */
export type Label = { id: string; truth: EdgeCategory | "none"; alt?: EdgeCategory; note?: string };

function agrees(l: Label, cat: EdgeCategory): boolean {
  return l.truth === cat || l.alt === cat;
}

export type Precision = {
  labelled: number;
  /** Stage A (checked in code, before stage B): label agrees with the edge's category. */
  stageA: { correct: number; precision: number };
  /** After stage B: among edges it kept, label agrees with the (possibly re-read) category. */
  final: { kept: number; correct: number; precision: number };
  /** Correct stage A edges stage B dropped. */
  droppedCorrect: number;
  /** Wrong stage A edges stage B dropped or fixed. */
  caught: number;
};

/**
 * Precision from labels. `stageA` maps an edge id to its stage A category;
 * `final` maps the same id to the category after stage B, or null when
 * stage B dropped it.
 */
export function precisionFrom(labels: Label[], stageA: Map<string, EdgeCategory>, final: Map<string, EdgeCategory | null>): Precision {
  let a = 0;
  let kept = 0;
  let fin = 0;
  let droppedCorrect = 0;
  let caught = 0;
  const known = labels.filter((l) => stageA.has(l.id));
  for (const l of known) {
    const cat = stageA.get(l.id)!;
    const okA = agrees(l, cat);
    if (okA) a++;
    const after = final.has(l.id) ? final.get(l.id)! : cat;
    if (after === null) {
      if (okA) droppedCorrect++;
      else caught++;
      continue;
    }
    kept++;
    if (agrees(l, after)) fin++;
    if (!okA && agrees(l, after)) caught++;
  }
  return {
    labelled: known.length,
    stageA: { correct: a, precision: known.length ? a / known.length : 0 },
    final: { kept, correct: fin, precision: kept ? fin / kept : 0 },
    droppedCorrect,
    caught,
  };
}
