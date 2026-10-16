/**
 * Backfill of `disclosed_share_pct` / `disclosed_share_quote` onto step1
 * results and graph files written before those fields existed.
 *
 * Sources, both from stored extraction data (no model call):
 *   1. a validated edge whose `strength_basis` is "disclosed" (strength is
 *      pct / 100 there);
 *   2. the cached extraction candidates of the same filing: a candidate with
 *      the same counterparty and category whose quote is one of the edge's
 *      evidence quotes and which carried a percentage.
 * Either way the share is kept only when an evidence quote states the number
 * (`disclosedShareFromEvidence`). Additive: existing fields are never changed,
 * and an edge that already carries the field is left as it is.
 */
import { normalizeCompanyName, normalizeWhitespace } from "./normalize.js";
import { STRENGTH_BY_TIER, disclosedShareFromEvidence, disclosedShareOfEdge, resolveEdgeStrength, type DisclosedShare } from "./strength.js";
import type { StrengthBasis, StrengthTier, ValidatedEdge } from "./types.js";

/** The fields of a cached extraction candidate the backfill reads. */
export type CachedCandidateLike = {
  counterparty_name?: unknown;
  category?: unknown;
  disclosed_revenue_dependency_pct?: unknown;
  evidence_quote?: unknown;
};

export type RootBackfill = {
  edges: ValidatedEdge[];
  /** Edges that had no field and got one (number or null). */
  stamped: number;
  /** Of those, edges given a share from a disclosed strength. */
  fromStrength: number;
  /** Of those, edges given a share from a cached candidate. */
  fromCandidates: number;
  /** Disclosed-strength edges whose quotes do not state the number (left null). */
  unverified: number;
};

function quoteKey(q: string): string {
  return normalizeWhitespace(q).toLowerCase();
}

/** Insert `extra` into `obj` right after `afterKey` (or at the end), keeping key order for a readable diff. */
export function insertAfter<T extends object>(obj: T, afterKey: string, extra: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [k, v] of Object.entries(obj)) {
    if (k in extra) continue;
    out[k] = v;
    if (k === afterKey) {
      Object.assign(out, extra);
      placed = true;
    }
  }
  if (!placed) Object.assign(out, extra);
  return out as T;
}

function shareFromCandidates(edge: ValidatedEdge, candidates: readonly CachedCandidateLike[]): DisclosedShare | null {
  const name = normalizeCompanyName(edge.counterparty_name);
  const quotes = edge.evidence.map((e) => e.quote);
  const keys = new Set(quotes.map(quoteKey));
  for (const c of candidates) {
    const pct = c.disclosed_revenue_dependency_pct;
    if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
    if (typeof c.counterparty_name !== "string" || normalizeCompanyName(c.counterparty_name) !== name) continue;
    if (c.category !== edge.category) continue;
    if (typeof c.evidence_quote !== "string" || !keys.has(quoteKey(c.evidence_quote))) continue;
    const share = disclosedShareFromEvidence(pct, quotes);
    if (share.disclosed_share_pct != null) return share;
  }
  return null;
}

/** Stamp the fields on one root's validated edges. */
export function backfillRootEdges(
  edges: readonly ValidatedEdge[],
  candidates: readonly CachedCandidateLike[] | null = null,
): RootBackfill {
  let stamped = 0;
  let fromStrength = 0;
  let fromCandidates = 0;
  let unverified = 0;
  const out = edges.map((edge) => {
    if (edge.disclosed_share_pct !== undefined) return edge;
    let share = disclosedShareOfEdge(edge);
    if (share.disclosed_share_pct != null) fromStrength++;
    else if (edge.strength_basis === "disclosed") unverified++;
    if (share.disclosed_share_pct == null && candidates?.length) {
      const fromCache = shareFromCandidates(edge, candidates);
      if (fromCache) {
        share = fromCache;
        fromCandidates++;
      }
    }
    stamped++;
    return insertAfter(edge, "strength_basis", { ...share });
  });
  return { edges: out, stamped, fromStrength, fromCandidates, unverified };
}

export type EdgeStrength = { strength: number; strength_tier: StrengthTier; strength_basis: StrengthBasis };

/**
 * Edges whose strength does not follow the rule that a percentage sets the
 * tier only when a quote states it as the current share (`disclosed_share_pct`):
 *   fromShare   a verified share whose strength or tier is not the share's:
 *               resolved here, from the share;
 *   reclassify  a "disclosed" strength with no verified share (the tier came
 *               from a percentage no quote states, CAH to OptumRx at 17%):
 *               the classifier has to judge it from the words, with no pct.
 * Indexes into `edges`. Pure.
 */
export function tierRecomputePlan(edges: readonly ValidatedEdge[]): {
  fromShare: Array<{ index: number; resolved: EdgeStrength }>;
  reclassify: number[];
} {
  const fromShare: Array<{ index: number; resolved: EdgeStrength }> = [];
  const reclassify: number[] = [];
  edges.forEach((edge, index) => {
    const pct = disclosedShareOfEdge(edge).disclosed_share_pct;
    if (pct != null) {
      const resolved = resolveEdgeStrength({ disclosed_revenue_dependency_pct: pct });
      if (edge.strength_tier !== resolved.strength_tier || edge.strength !== resolved.strength || edge.strength_basis !== resolved.strength_basis) {
        fromShare.push({ index, resolved });
      }
    } else if (edge.strength_basis === "disclosed") {
      reclassify.push(index);
    }
  });
  return { fromShare, reclassify };
}

/**
 * Edges whose tier may be a silent default rather than a judgement, to be
 * classified again (`--only-defaulted`):
 *   unclassified  `strength_basis: "unclassified"`: the classifier gave no tier
 *                 (always selected);
 *   legacy        with `legacy`, edges written before that marker existed that
 *                 carry exactly what the old silent default wrote: basis
 *                 "classified", tier "important", strength 0.6, no verified
 *                 share. A real "important" judgement looks the same in stored
 *                 data (no rationale is kept), so this is the whole pool a
 *                 default can hide in, not only defaulted edges.
 * Indexes into `edges`. Pure.
 */
export function defaultedStrengthPlan(
  edges: readonly ValidatedEdge[],
  opts: { legacy?: boolean } = {},
): { unclassified: number[]; legacy: number[] } {
  const unclassified: number[] = [];
  const legacy: number[] = [];
  edges.forEach((edge, index) => {
    if (edge.strength_basis === "unclassified") {
      unclassified.push(index);
      return;
    }
    if (!opts.legacy) return;
    if (edge.strength_basis !== "classified" || edge.strength_tier !== "important") return;
    if (typeof edge.strength !== "number" || Math.abs(edge.strength - STRENGTH_BY_TIER.important) > 1e-9) return;
    if (disclosedShareOfEdge(edge).disclosed_share_pct != null) return;
    legacy.push(index);
  });
  return { unclassified, legacy };
}

/** `edge` with a new strength, tier and basis, in place in the key order (a readable diff). */
export function withStrength(edge: ValidatedEdge, s: EdgeStrength): ValidatedEdge {
  return { ...edge, strength: s.strength, strength_tier: s.strength_tier, strength_basis: s.strength_basis };
}

/** The key a graph edge and the validated edge it was built from share. */
export function edgeMatchKey(e: {
  root_ticker?: unknown;
  counterparty_name?: unknown;
  category?: unknown;
  subtype?: unknown;
  evidence_quote?: unknown;
}): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return [s(e.root_ticker).toUpperCase(), s(e.counterparty_name), s(e.category), s(e.subtype), quoteKey(s(e.evidence_quote))].join("|");
}

export type GraphBackfill = {
  /** Graph edges (in `edges`) that got the fields. */
  stamped: number;
  /** Of those, with a share. */
  withShare: number;
  /** Graph edges with no matching validated edge (left without the fields). */
  unmatched: number;
  /** Graph edges that already carried the field. */
  alreadySet: number;
};

type GraphLike = { edges?: unknown; reverseIndex?: unknown };

/**
 * Stamp the fields on a graph file's edges (and their copies in
 * `reverseIndex`) from the validated edges they were built from. Mutates and
 * returns `graph`.
 */
export function backfillGraph<G extends GraphLike>(graph: G, validated: readonly ValidatedEdge[]): { graph: G; report: GraphBackfill } {
  const byKey = new Map<string, DisclosedShare | "conflict">();
  for (const v of validated) {
    const key = edgeMatchKey({ ...v, evidence_quote: v.evidence[0]?.quote ?? "" });
    const share = disclosedShareOfEdge(v);
    const known = byKey.get(key);
    if (known === undefined) byKey.set(key, share);
    else if (known !== "conflict" && known.disclosed_share_pct !== share.disclosed_share_pct) byKey.set(key, "conflict");
  }

  const report: GraphBackfill = { stamped: 0, withShare: 0, unmatched: 0, alreadySet: 0 };
  const byId = new Map<string, DisclosedShare>();
  const stamp = (e: Record<string, unknown>, count: boolean): Record<string, unknown> => {
    if (e.disclosed_share_pct !== undefined) {
      if (count) report.alreadySet++;
      return e;
    }
    const id = typeof e.id === "string" ? e.id : null;
    let share = id ? byId.get(id) : undefined;
    if (!share) {
      const found = byKey.get(edgeMatchKey(e));
      if (found && found !== "conflict") share = found;
    }
    if (!share) {
      if (count) report.unmatched++;
      return e;
    }
    if (id) byId.set(id, share);
    if (count) {
      report.stamped++;
      if (share.disclosed_share_pct != null) report.withShare++;
    }
    return insertAfter(e, "strength_tier", { ...share });
  };

  if (Array.isArray(graph.edges)) {
    graph.edges = (graph.edges as Record<string, unknown>[]).map((e) => (e && typeof e === "object" ? stamp(e, true) : e));
  }
  if (graph.reverseIndex && typeof graph.reverseIndex === "object") {
    const index = graph.reverseIndex as Record<string, unknown>;
    for (const k of Object.keys(index)) {
      const list = index[k];
      if (Array.isArray(list)) {
        index[k] = list.map((e) => (e && typeof e === "object" ? stamp(e as Record<string, unknown>, false) : e));
      }
    }
  }
  return { graph, report };
}

/**
 * Serialise `value` the way `raw` was written (indent, line endings, trailing
 * newline), so rewriting a tracked file shows only the added lines.
 */
export function stringifyLike(raw: string, value: unknown): string {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const indentMatch = /^[[{]\r?\n([ \t]+)/.exec(raw);
  const indent = indentMatch ? indentMatch[1]! : "  ";
  let out = JSON.stringify(value, null, indent);
  if (eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  if (/\r?\n$/.test(raw)) out += eol;
  return out;
}
