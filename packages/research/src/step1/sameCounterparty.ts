/**
 * One edge per filer, counterparty and category.
 *
 * The extractor names one company in several ways in the same filing ("Taiwan
 * Semiconductor Manufacturing Company" and "TSMC" in ADI's 10-K), and the
 * candidate dedupe keys on `normalizeCompanyName`, which strips legal forms
 * but knows no aliases and no tickers. Both spellings then survived as two
 * edges to one company, each judged on its own quotes, with different tiers
 * (important and critical) and a doubled weight in graph traversal.
 *
 * Here edges of one filer are the same counterparty when they share a
 * category and either a listed ticker (the resolver's answer, the identity
 * the graph builder uses) or a canonical name key (`canonicalCounterpartyKey`:
 * legal forms, dotted abbreviations, the alias table). A group whose members
 * resolved to different tickers is left alone: the names agree, the resolver
 * does not, and no merge is safer than a wrong one.
 *
 * Pure: the merged edge keeps the strongest member's strength; the caller
 * judges the merged quotes again.
 */
import { canonicalCounterpartyKey, sanitizeCounterpartyTicker } from "./canonical.js";
import { isNotTheListedEntity } from "./entityResolution.js";
import { evidenceQuoteHash } from "./evidenceGroups.js";
import { normalizeWhitespace } from "./normalize.js";
import { STRENGTH_BY_TIER, disclosedShareOfEdge, isMeasuredStrength } from "./strength.js";
import type { ValidatedEdge } from "./types.js";

/** Most evidence quotes a merged edge keeps (the classifier caps their length again). */
export const MAX_MERGED_EVIDENCE = 6;

/** The ticker an edge may be identified by: sanitised, not the filer's own, not a parent or affiliate name. */
function identityTicker(edge: Pick<ValidatedEdge, "counterparty_name" | "counterparty_ticker" | "root_ticker">): string | null {
  const { ticker } = sanitizeCounterpartyTicker(edge.counterparty_ticker);
  if (!ticker) return null;
  if (ticker === edge.root_ticker.trim().toUpperCase()) return null;
  if (isNotTheListedEntity(edge.counterparty_name)) return null;
  return ticker;
}

/** Identity keys of one edge within its filer: its ticker, and its canonical name key. */
export function counterpartyIdentityKeys(
  edge: Pick<ValidatedEdge, "counterparty_name" | "counterparty_ticker" | "root_ticker" | "category">,
): string[] {
  const keys: string[] = [];
  const ticker = identityTicker(edge);
  if (ticker) keys.push(`${edge.category}|ticker:${ticker}`);
  const name = canonicalCounterpartyKey(edge.counterparty_name);
  if (name) keys.push(`${edge.category}|name:${name}`);
  return keys;
}

/**
 * Groups (indexes into `edges`, in order) of two or more edges to one
 * counterparty in one category. Groups whose members resolved to different
 * tickers are not returned.
 */
export function sameCounterpartyGroups(edges: readonly ValidatedEdge[]): number[][] {
  const parent = edges.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const owner = new Map<string, number>();
  edges.forEach((edge, i) => {
    for (const key of counterpartyIdentityKeys(edge)) {
      const j = owner.get(key);
      if (j === undefined) owner.set(key, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, number[]>();
  edges.forEach((_, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  });
  return [...groups.values()].filter((g) => {
    if (g.length < 2) return false;
    const tickers = new Set(g.map((i) => identityTicker(edges[i]!)).filter((t): t is string => t !== null));
    return tickers.size <= 1;
  });
}

const rankOf = (edge: ValidatedEdge): number =>
  isMeasuredStrength(edge) && edge.strength_tier ? STRENGTH_BY_TIER[edge.strength_tier] : 0;

/**
 * The member whose evidence leads the merged edge: a stated share first, then
 * the stronger measured tier, the higher confidence, more quotes, the earlier.
 */
export function primaryOfGroup(edges: readonly ValidatedEdge[]): number {
  let best = 0;
  const score = (e: ValidatedEdge) => [
    disclosedShareOfEdge(e).disclosed_share_pct != null ? 1 : 0,
    rankOf(e),
    e.confidence ?? 0,
    e.evidence?.length ?? 0,
  ];
  for (let i = 1; i < edges.length; i++) {
    const a = score(edges[i]!);
    const b = score(edges[best]!);
    for (let k = 0; k < a.length; k++) {
      if (a[k]! === b[k]!) continue;
      if (a[k]! > b[k]!) best = i;
      break;
    }
  }
  return best;
}

/** The name the merged edge keeps: the longest spelling that reaches the key without an alias (the full legal form). */
function mergedName(edges: readonly ValidatedEdge[], primary: ValidatedEdge): string {
  const key = canonicalCounterpartyKey(primary.counterparty_name);
  const direct = edges
    .map((e) => e.counterparty_name.trim())
    .filter((n) => canonicalCounterpartyKey(n, { applyAliases: false }) === key);
  if (direct.length === 0) return primary.counterparty_name;
  return direct.sort((a, b) => b.length - a.length || a.localeCompare(b))[0]!;
}

/** One edge from a group: the primary's fields, every distinct quote (primary's first), all subtypes. */
export function mergeEdgeGroup(edges: readonly ValidatedEdge[]): ValidatedEdge {
  const primary = edges[primaryOfGroup(edges)]!;
  const ordered = [primary, ...edges.filter((e) => e !== primary)];

  const evidence: ValidatedEdge["evidence"] = [];
  const seen = new Set<string>();
  for (const e of ordered) {
    for (const ev of e.evidence ?? []) {
      const key = normalizeWhitespace(ev.quote).toLowerCase();
      if (!key || seen.has(key) || evidence.length >= MAX_MERGED_EVIDENCE) continue;
      seen.add(key);
      evidence.push(ev);
    }
  }

  // "joint venture" and "joint_venture" are one subtype.
  const subtypeKey = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  const subtypes: string[] = [];
  for (const e of ordered) {
    const s = (e.subtype ?? "").trim();
    if (s && !subtypes.some((t) => subtypeKey(t) === subtypeKey(s))) subtypes.push(s);
  }

  return {
    ...primary,
    counterparty_name: mergedName(edges, primary),
    counterparty_ticker: primary.counterparty_ticker ?? ordered.find((e) => e.counterparty_ticker)?.counterparty_ticker ?? null,
    subtype: subtypes.join("; "),
    confidence: Math.max(...edges.map((e) => e.confidence ?? 0)),
    evidence,
    shared_evidence_group: `ev_${evidenceQuoteHash(evidence[0]?.quote ?? "")}`,
  };
}

export type SameCounterpartyMerge = {
  /** Index of the merged edge in the returned `edges`. */
  index: number;
  merged: ValidatedEdge;
  from: ValidatedEdge[];
};

/**
 * `edges` with every same-counterparty group folded into one edge, at the
 * position of the group's first member; other edges are returned unchanged
 * (the same objects).
 */
export function mergeSameCounterpartyEdges(edges: readonly ValidatedEdge[]): {
  edges: ValidatedEdge[];
  merges: SameCounterpartyMerge[];
} {
  const groups = sameCounterpartyGroups(edges);
  if (groups.length === 0) return { edges: [...edges], merges: [] };
  const groupOf = new Map<number, number[]>();
  for (const g of groups) for (const i of g) groupOf.set(i, g);
  const out: ValidatedEdge[] = [];
  const merges: SameCounterpartyMerge[] = [];
  edges.forEach((edge, i) => {
    const g = groupOf.get(i);
    if (!g) {
      out.push(edge);
      return;
    }
    if (g[0] !== i) return;
    const from = g.map((j) => edges[j]!);
    const merged = mergeEdgeGroup(from);
    merges.push({ index: out.length, merged, from });
    out.push(merged);
  });
  return { edges: out, merges };
}
