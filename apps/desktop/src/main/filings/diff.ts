/**
 * Comparing two filings' readings, mechanically.
 *
 *   headingSimilarity  how much of two headings is the same words in the same
 *                      order: 2 x LCS(words) / (words in a + words in b), on
 *                      the normalised text (years and numbers made alike)
 *   topicSimilarity    how much of two headings is the same subject: the
 *                      share of content words (stemmed, no function words,
 *                      no words most headings use) the two have in common
 *   diffHeadings       new, removed and materially reworded risk factors
 *   diffConcentration  customer shares that moved, appeared or went
 *   newSentences       sentences in the latest filing with no close match in
 *                      the previous one (sole or single source passages)
 *   namedIn            whether a company name appears anywhere in a text
 *
 * Pure: no fs, no network.
 */

import { anonymousShare, companyKey, labelKey, LARGEST_CUSTOMER, normalizeHeading, type ConcentrationFact, type RiskHeading } from "./parse";

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

/** At or above this topic similarity, on at least TOPIC_MIN_SHARED words, a heading left unmatched by wording is the same risk factor rewritten. */
export const TOPIC_MIN = 0.4;
export const TOPIC_MIN_SHARED = 2;

const FUNCTION_WORDS = new Set(
  (
    "a an the and or nor but of to in on for by with without its it is are was were be been being can could may might will would shall should must " +
    "if that this these those as at from any such their there other which who whom whose than into onto not no more most including include includes " +
    "our we us also all each both certain various upon over under about between through within have has had do does did " +
    // Risk factor boilerplate: says how bad, not what about.
    "adverse adversely affect affected affects impact impacted impacts negative negatively harm material materially significant significantly " +
    "result results operating operation operations business businesses factor factors change changes ability"
  ).split(" "),
);

/**
 * A word reduced to its stem, roughly: its first six letters, so
 * "regulated", "regulation" and "regulations" are one, as are "operational"
 * and "operations", "competition" and "competitive".
 */
function stem(word: string): string {
  return word.replace(/s$/, "").slice(0, 6);
}

function contentWords(text: string): string[] {
  return normalizeHeading(text)
    .split(" ")
    .map((w) => w.replace(/[^a-z]/g, ""))
    .filter((w) => w.length > 2 && !FUNCTION_WORDS.has(w))
    .map(stem);
}

/**
 * Words too common in a filing's headings to say what one is about: its own
 * name ("JPMorganChase" heads most of them) and "affect". Counted over both
 * lists, only when there are enough headings to tell.
 */
function commonWords(texts: readonly string[]): Set<string> {
  if (texts.length < 10) return new Set();
  const df = new Map<string, number>();
  for (const t of texts) for (const w of new Set(contentWords(t))) df.set(w, (df.get(w) ?? 0) + 1);
  return new Set([...df].filter(([, n]) => n > texts.length * 0.4).map(([w]) => w));
}

/** Content words two headings share: 2 x shared / (words in a + words in b), and how many are shared. */
export function topicSimilarity(a: string, b: string, common: ReadonlySet<string> = new Set()): { score: number; shared: number } {
  const wa = new Set(contentWords(a).filter((w) => !common.has(w)));
  const wb = new Set(contentWords(b).filter((w) => !common.has(w)));
  if (wa.size === 0 || wb.size === 0) return { score: 0, shared: 0 };
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return { score: (2 * shared) / (wa.size + wb.size), shared };
}

/**
 * The pairing of rows to columns with the largest total weight (Hungarian
 * method, O(n^3)); a weight of 0 is no pair. Pairing greedily goes wrong when
 * two headings share a phrase (competition in "the financial services
 * industry", differences in "financial services regulation"): each is then
 * taken by the other's match.
 */
function bestPairs(weight: readonly (readonly number[])[], rows: number, cols: number): [number, number][] {
  const n = Math.max(rows, cols);
  if (n === 0) return [];
  const cost = (i: number, j: number) => (i < rows && j < cols ? 1 - weight[i]![j]! : 1);
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0);
  const way = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Infinity);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else minv[j] = minv[j]! - delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }
  const out: [number, number][] = [];
  for (let j = 1; j <= n; j++) {
    const i = p[j]! - 1;
    if (i >= 0 && i < rows && j - 1 < cols && weight[i]![j - 1]! > 0) out.push([i, j - 1]);
  }
  return out;
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
 * MATCH_MIN; then, among the headings still left, the same subject in new
 * words (a filing that rewrites its whole section, as JPMorgan's 10-K for
 * 2025 did: "Reductions in JPMorganChase's credit ratings may adversely
 * affect its liquidity and cost of funding" became "JPMorganChase's
 * liquidity and cost of funding could be adversely affected by downgrades in
 * its credit ratings"), paired for the most shared subject in all
 * (bestPairs) where topicSimilarity clears TOPIC_MIN on at least
 * TOPIC_MIN_SHARED words. Those are reworded. What is left over is new
 * (latest) or removed (previous).
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
  const restLatest = openLatest.filter((i) => !pairedLatest.has(i));
  const restPrev = openPrev.filter((j) => !usedPrev.has(j));
  if (restLatest.length > 0 && restPrev.length > 0) {
    const common = commonWords([...latest, ...previous].map((x) => x.text));
    const weight = restLatest.map((i) =>
      restPrev.map((j) => {
        const t = topicSimilarity(latest[i]!.text, previous[j]!.text, common);
        return t.score >= TOPIC_MIN && t.shared >= TOPIC_MIN_SHARED ? t.score : 0;
      }),
    );
    for (const [a, b] of bestPairs(weight, restLatest.length, restPrev.length)) {
      const i = restLatest[a]!;
      const j = restPrev[b]!;
      pairedLatest.add(i);
      usedPrev.add(j);
      out.reworded.push({ now: latest[i]!, before: previous[j]!, similarity: Math.round(headingSimilarity(latest[i]!.text, previous[j]!.text) * 100) / 100 });
    }
  }
  for (const i of openLatest) if (!pairedLatest.has(i)) out.added.push(latest[i]!);
  for (const j of openPrev) if (!usedPrev.has(j)) out.removed.push(previous[j]!);
  out.reworded.sort((a, b) => latest.indexOf(a.now) - latest.indexOf(b.now));
  return out;
}

export type ConcentrationChange =
  | { kind: "share"; label: string; pct: number; previousPct: number; basis: ConcentrationFact["basis"]; quote: string; previousQuote: string }
  | { kind: "new"; label: string; pct: number; basis: ConcentrationFact["basis"]; quote: string }
  | { kind: "dropped"; label: string; previousPct: number; basis: ConcentrationFact["basis"]; quote: string };

/** A share that moved by less than this many points is the same share. */
export const SHARE_MOVE_MIN = 1;

const BASES: readonly ConcentrationFact["basis"][] = ["revenue", "receivables"];

function largest(facts: readonly ConcentrationFact[]): ConcentrationFact {
  return facts.reduce((a, b) => (b.pct > a.pct ? b : a));
}

/**
 * Customer concentration across two filings, like with like:
 *   named customers and groups ("Apple", "our ten largest customers") are
 *   matched by who and what the share is of;
 *   unnamed customers ("One customer", "Customer A") are never matched by
 *   label, since a filing's letters need not mean the same customer from one
 *   year to the next: the largest unnamed share is compared with the
 *   previous filing's largest unnamed share of the same basis
 *   (LARGEST_CUSTOMER "28.1%, 20.9% the year before"). An unnamed share is
 *   new, or gone, only when the other filing states no share at all of that
 *   basis: a named one may be the same customer.
 * Revenue shares are compared only with revenue shares, receivables with receivables.
 */
export function diffConcentration(latest: readonly ConcentrationFact[], previous: readonly ConcentrationFact[]): ConcentrationChange[] {
  const key = (f: ConcentrationFact) => `${labelKey(f.label)}|${f.basis}`;
  const namedNow = latest.filter((f) => !anonymousShare(f.label));
  const namedPrev = previous.filter((f) => !anonymousShare(f.label));
  const prev = new Map(namedPrev.map((f) => [key(f), f]));
  const now = new Map(namedNow.map((f) => [key(f), f]));
  const out: ConcentrationChange[] = [];
  for (const f of namedNow) {
    const p = prev.get(key(f));
    if (!p) out.push({ kind: "new", label: f.label, pct: f.pct, basis: f.basis, quote: f.quote });
    else if (Math.abs(f.pct - p.pct) >= SHARE_MOVE_MIN) out.push({ kind: "share", label: f.label, pct: f.pct, previousPct: p.pct, basis: f.basis, quote: f.quote, previousQuote: p.quote });
  }
  for (const p of namedPrev) {
    if (!now.has(key(p))) out.push({ kind: "dropped", label: p.label, previousPct: p.pct, basis: p.basis, quote: p.quote });
  }
  for (const basis of BASES) {
    const l = latest.filter((f) => f.basis === basis && anonymousShare(f.label));
    const p = previous.filter((f) => f.basis === basis && anonymousShare(f.label));
    if (l.length > 0 && p.length > 0) {
      const a = largest(l);
      const b = largest(p);
      if (Math.abs(a.pct - b.pct) >= SHARE_MOVE_MIN) out.push({ kind: "share", label: LARGEST_CUSTOMER, pct: a.pct, previousPct: b.pct, basis, quote: a.quote, previousQuote: b.quote });
    } else if (l.length > 0 && !previous.some((f) => f.basis === basis)) {
      const a = largest(l);
      out.push({ kind: "new", label: l.length === 1 ? a.label : LARGEST_CUSTOMER, pct: a.pct, basis, quote: a.quote });
    } else if (p.length > 0 && !latest.some((f) => f.basis === basis)) {
      const b = largest(p);
      out.push({ kind: "dropped", label: p.length === 1 ? b.label : LARGEST_CUSTOMER, previousPct: b.pct, basis, quote: b.quote });
    }
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
