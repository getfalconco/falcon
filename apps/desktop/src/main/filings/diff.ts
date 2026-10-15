/**
 * Comparing two filings' readings, mechanically.
 *
 *   headingSimilarity  how much of two headings is the same words in the same
 *                      order: 2 x LCS(words) / (words in a + words in b), on
 *                      the normalised text (years and numbers made alike)
 *   diffHeadings       new, removed and materially reworded risk factors
 *   diffConcentration  customer shares that moved, appeared or went
 *   newSentences       sentences in the latest filing with no close match in
 *                      the previous one (sole or single source passages)
 *   namedIn            whether a company name appears anywhere in a text
 *
 * Pure: no fs, no network.
 */

import { companyKey, labelKey, normalizeHeading, type ConcentrationFact, type RiskHeading } from "./parse";

/** At or above this, two headings are the same risk factor. */
export const MATCH_MIN = 0.5;
/**
 * At or above this, a matched heading is the same text with small edits
 * ("fiscal 2025" to "fiscal 2026", a word added); below it the heading was
 * materially reworded.
 */
export const REWORD_BELOW = 0.85;

function tokens(text: string): string[] {
  return normalizeHeading(text).split(" ").filter(Boolean);
}

function lcs(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** 1 for the same words in the same order, 0 for nothing in common. */
export function headingSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;
  return (2 * lcs(ta, tb)) / (ta.length + tb.length);
}

export type HeadingDiff = {
  added: RiskHeading[];
  removed: RiskHeading[];
  reworded: { now: RiskHeading; before: RiskHeading; similarity: number }[];
  /** Headings found in both, verbatim or with small edits. */
  kept: number;
};

/**
 * Pairs each latest heading with the previous filing's: exact (normalised)
 * matches first, then the closest remaining pair, greedily, while it clears
 * MATCH_MIN. What is left over is new (latest) or removed (previous).
 */
export function diffHeadings(latest: readonly RiskHeading[], previous: readonly RiskHeading[]): HeadingDiff {
  const out: HeadingDiff = { added: [], removed: [], reworded: [], kept: 0 };
  const prevByKey = new Map<string, number[]>();
  previous.forEach((h, i) => {
    const k = normalizeHeading(h.text);
    prevByKey.set(k, [...(prevByKey.get(k) ?? []), i]);
  });
  const usedPrev = new Set<number>();
  const openLatest: number[] = [];
  latest.forEach((h, i) => {
    const hit = prevByKey.get(normalizeHeading(h.text))?.find((j) => !usedPrev.has(j));
    if (hit !== undefined) {
      usedPrev.add(hit);
      out.kept++;
    } else openLatest.push(i);
  });
  const openPrev = previous.map((_, j) => j).filter((j) => !usedPrev.has(j));

  const pairs: { i: number; j: number; sim: number }[] = [];
  for (const i of openLatest) {
    for (const j of openPrev) {
      const sim = headingSimilarity(latest[i]!.text, previous[j]!.text);
      if (sim >= MATCH_MIN) pairs.push({ i, j, sim });
    }
  }
  pairs.sort((a, b) => b.sim - a.sim || a.i - b.i || a.j - b.j);
  const pairedLatest = new Set<number>();
  for (const p of pairs) {
    if (pairedLatest.has(p.i) || usedPrev.has(p.j)) continue;
    pairedLatest.add(p.i);
    usedPrev.add(p.j);
    if (p.sim >= REWORD_BELOW) out.kept++;
    else out.reworded.push({ now: latest[p.i]!, before: previous[p.j]!, similarity: Math.round(p.sim * 100) / 100 });
  }
  for (const i of openLatest) if (!pairedLatest.has(i)) out.added.push(latest[i]!);
  for (const j of openPrev) if (!usedPrev.has(j)) out.removed.push(previous[j]!);
  out.reworded.sort((a, b) => latest.indexOf(a.now) - latest.indexOf(b.now));
  return out;
}

export type ConcentrationChange =
  | { kind: "share"; label: string; pct: number; previousPct: number; basis: ConcentrationFact["basis"]; quote: string }
  | { kind: "new"; label: string; pct: number; basis: ConcentrationFact["basis"]; quote: string }
  | { kind: "dropped"; label: string; previousPct: number; basis: ConcentrationFact["basis"]; quote: string };

/** A share that moved by less than this many points is the same share. */
export const SHARE_MOVE_MIN = 1;

/**
 * Customer concentration across two filings, matched by who (name or the
 * filing's own label) and what the share is of.
 */
export function diffConcentration(latest: readonly ConcentrationFact[], previous: readonly ConcentrationFact[]): ConcentrationChange[] {
  const key = (f: ConcentrationFact) => `${labelKey(f.label)}|${f.basis}`;
  const prev = new Map(previous.map((f) => [key(f), f]));
  const now = new Map(latest.map((f) => [key(f), f]));
  const out: ConcentrationChange[] = [];
  for (const f of latest) {
    const p = prev.get(key(f));
    if (!p) out.push({ kind: "new", label: f.label, pct: f.pct, basis: f.basis, quote: f.quote });
    else if (Math.abs(f.pct - p.pct) >= SHARE_MOVE_MIN) out.push({ kind: "share", label: f.label, pct: f.pct, previousPct: p.pct, basis: f.basis, quote: f.quote });
  }
  for (const p of previous) {
    if (!now.has(key(p))) out.push({ kind: "dropped", label: p.label, previousPct: p.pct, basis: p.basis, quote: p.quote });
  }
  return out;
}

/** Sentences of `latest` with no sentence in `previous` at or above `min` similarity. */
export function newSentences(latest: readonly string[], previous: readonly string[], min = 0.6): string[] {
  return latest.filter((s) => {
    const k = normalizeHeading(s);
    return !previous.some((p) => normalizeHeading(p) === k || headingSimilarity(s, p) >= min);
  });
}

/** The text reduced the way `companyKey` reduces a name, padded so a whole-word search is a substring search. */
export function searchableText(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[^a-z0-9&]+/g, " ")
    .replace(/\s+/g, " ")} `;
}

/**
 * Whether the filing names the company anywhere: "Apple Inc." is found as
 * "apple". A name that reduces to fewer than three letters is not searched
 * (it would match by accident) and counts as named.
 */
export function namedIn(name: string, searchable: string): boolean {
  const key = companyKey(name);
  if (key.replace(/[^a-z]/g, "").length < 3) return true;
  return searchable.includes(` ${key} `);
}
