/**
 * Ranking v1: what the filing link, the measured record and the event's size
 * say about each hit, turned into its confidence, whether it stays on the
 * card, its score, and the card's place in the feed. The formula and its
 * reasons are in packages/engine/README.md ("Ranking"); keep the two in step.
 *
 * Why (vault: Ripple Engine, Evidence): many links fail and the edge is in
 * the average, so a hit's record has to earn a high rating; a list mention
 * with a record no better than a coin flip says nothing; the effect is
 * stronger in names few analysts follow, so such a hit's score is raised
 * (coverageBoost), and a card with a degree 2 hit is preferred.
 *
 * Pure: nothing here reads a source; coverage figures are passed in.
 */

import type { Confidence, Direction, RippleHistory, RippleHit } from "@falcon/ripple";
import type { DetectedEvent } from "./events.ts";
import type { GraphEdge, Path } from "./graph.ts";

// ---------------------------------------------------------------------------
// Event size

/**
 * How much an event's size counts, 1 to 4. An EPS surprise is measured
 * against a consensus; a monthly revenue change is not (no estimate to
 * beat), so it counts for less per point and at most 2. Pure.
 */
export function magnitudeFactor(ev: Pick<DetectedEvent, "magnitudePct" | "event">): number {
  const m = ev.magnitudePct === null ? 0 : Math.abs(ev.magnitudePct);
  if (ev.event.kind === "filing") return 1 + Math.min(m, 60) / 60;
  return 1 + Math.min(m, 30) / 10;
}

/** The event's size for a hit's score, 0 to 1: (magnitudeFactor - 1) / 3. Pure. */
export function eventSize(ev: Pick<DetectedEvent, "magnitudePct" | "event">): number {
  return (magnitudeFactor(ev) - 1) / 3;
}

// ---------------------------------------------------------------------------
// Link strength, from the filing quotes

/**
 * disclosed: the filing states a share, a sole or exclusive source, or a
 *            customer above 10% of revenue.
 * named:     the filing names the link (a supplier, a customer, a principal
 *            competitor) without a share.
 * list:      the company is one name in a list (the extraction's "marginal").
 */
export type LinkTier = "disclosed" | "named" | "list";

const TIER_RANK: Record<LinkTier, number> = { list: 0, named: 1, disclosed: 2 };
export const LINK_STRENGTH: Record<LinkTier, number> = { disclosed: 1, named: 0.6, list: 0.25 };

const SOLE_SOURCE = /\b(sole|single|exclusive|only)[- ](source|supplier|manufactur\w*|foundry|provider|partner)|\bexclusively (use|used|rel(y|ied)|depend(ed)?)\b/i;
const OVER_TEN_PCT = /\b(more than|over|in excess of|at least) 10\s?%/i;
const SHARE_OF_SALES = /\b\d{2}(\.\d+)?\s?% of (our )?(total |net |consolidated )?(net )?(revenue|sales)/i;

export type EdgeStrength = { tier: LinkTier; why: "share" | "sole_source" | "over_10pct" | "named" | "list" };

/** What one filing quote proves. Pure. */
export function edgeStrength(edge: Pick<GraphEdge, "tier" | "disclosedSharePct" | "quote">): EdgeStrength {
  if (edge.disclosedSharePct !== null) return { tier: "disclosed", why: "share" };
  if (SOLE_SOURCE.test(edge.quote)) return { tier: "disclosed", why: "sole_source" };
  if (OVER_TEN_PCT.test(edge.quote) || SHARE_OF_SALES.test(edge.quote)) return { tier: "disclosed", why: "over_10pct" };
  if (edge.tier === "marginal") return { tier: "list", why: "list" };
  return { tier: "named", why: "named" };
}

/**
 * A path's link strength: degree 1, the strongest quote between the two
 * companies; degree 2, the weaker of its two links (a chain holds as well
 * as its weakest link). Pure.
 */
export function pathStrength(path: Pick<Path, "degree" | "edges">): EdgeStrength {
  const all = path.edges.map(edgeStrength);
  const cmp = (a: EdgeStrength, b: EdgeStrength) => TIER_RANK[a.tier] - TIER_RANK[b.tier];
  const sorted = [...all].sort(cmp);
  return path.degree === 2 ? sorted[0]! : sorted[sorted.length - 1]!;
}

// ---------------------------------------------------------------------------
// The measured record

/** 95% two-sided. */
export const WILSON_Z = 1.96;
/** A record this long or longer whose lower bound does not clear 0.5 is a settled coin flip. */
export const COIN_FLIP_MIN_SAMPLE = 20;
/**
 * The Wilson lower bound a record must clear to be "better than a coin flip"
 * (verdict "supports"): the only record that allows "high" confidence, and
 * the bar a hit must clear to be listed under Opportunities.
 */
export const SUPPORTS_LOWER_BOUND = 0.5;

/** Lower bound of the Wilson score interval for `wins` of `n`. Pure. */
export function wilsonLower(wins: number, n: number, z = WILSON_Z): number {
  if (n <= 0) return 0;
  const p = wins / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

/**
 * none:            no record (under 6 events, an unclear hit, a kind with no history)
 * supports:        the Wilson lower bound is above 0.5: better than a coin flip
 * leans_other_way: at most half went the implied way and the average moved the other way
 * coin_flip:       sample of 20 or more and the lower bound at or under 0.5
 * thin:            anything else: too few events to tell
 */
export type RecordVerdict = "none" | "supports" | "leans_other_way" | "coin_flip" | "thin";

export type RecordRead = { verdict: RecordVerdict; wins: number; sample: number; lower: number };

/** What a hit's record says. Pure. */
export function readRecord(history: RippleHistory | null, direction: Direction): RecordRead {
  if (!history || direction === "unclear") return { verdict: "none", wins: 0, sample: 0, lower: 0 };
  const wins = Math.round(history.hitRate * history.sample);
  const lower = wilsonLower(wins, history.sample);
  const impliedAvg = direction === "down" ? -history.avgMovePct : history.avgMovePct;
  const base = { wins, sample: history.sample, lower };
  if (lower > SUPPORTS_LOWER_BOUND) return { verdict: "supports", ...base };
  if (history.hitRate <= 0.5 && impliedAvg <= 0) return { verdict: "leans_other_way", ...base };
  if (history.sample >= COIN_FLIP_MIN_SAMPLE) return { verdict: "coin_flip", ...base };
  return { verdict: "thin", ...base };
}

/**
 * The record's part of a score, 0 to 1: the Wilson lower bound mapped from
 * 0.3..0.7 to 0..1, halved when the average moved against the implied way.
 * No record counts 0.2, a little under what a long coin-flip record earns
 * (50 events at 54%: lower bound 0.40, 0.25): both say about as little.
 * Pure.
 */
export function recordStrength(r: RecordRead, history: RippleHistory | null, direction: Direction): number {
  if (r.verdict === "none" || !history) return NO_RECORD_STRENGTH;
  const base = Math.min(1, Math.max(0, (r.lower - 0.3) / 0.4));
  const impliedAvg = direction === "down" ? -history.avgMovePct : history.avgMovePct;
  return impliedAvg > 0 ? base : base / 2;
}

// ---------------------------------------------------------------------------
// Confidence

const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const CONF_WEIGHT: Record<Confidence, number> = { low: 1 / 3, medium: 2 / 3, high: 1 };

/** The highest confidence the record allows. Pure. */
export function confidenceCeiling(verdict: RecordVerdict): Confidence {
  if (verdict === "supports") return "high";
  if (verdict === "coin_flip" || verdict === "leans_other_way") return "low";
  return "medium";
}

/** The judge's confidence, capped by the record: the judge is an input, the record a ceiling. Pure. */
export function cappedConfidence(judged: Confidence, verdict: RecordVerdict): Confidence {
  const ceiling = confidenceCeiling(verdict);
  return CONF_RANK[judged] <= CONF_RANK[ceiling] ? judged : ceiling;
}

// ---------------------------------------------------------------------------
// Opportunities

/**
 * Whether a hit may be listed under Opportunities: its record's Wilson lower
 * bound clears SUPPORTS_LOWER_BOUND (the "high" confidence bar), its
 * confidence after the cap is not "low", it has an implied way, and it is
 * not priced in. Pure.
 */
export function opportunityEligible(r: Pick<RecordRead, "verdict" | "lower" | "sample">, confidence: Confidence, direction: Direction, pricedIn: boolean | undefined): boolean {
  return r.verdict !== "none" && r.sample > 0 && r.lower > SUPPORTS_LOWER_BOUND && confidence !== "low" && direction !== "unclear" && pricedIn !== true;
}

// ---------------------------------------------------------------------------
// Coverage (analyst count, Yahoo numberOfAnalystOpinions; src/yahoo.ts)

export type Coverage = { analysts: number | null; marketCapUsd: number | null };

/** Full boost at or under this many analysts. */
export const COVERAGE_FULL_AT = 3;
/** No boost at or over this many analysts. */
export const COVERAGE_NONE_AT = 20;
/** The most a hit's score is raised for low coverage: x1.25. */
export const COVERAGE_BOOST_MAX = 0.25;
/** Without an analyst count, a market value under this counts as CAP_FALLBACK_ANALYSTS analysts. */
export const LOW_COVERAGE_CAP_USD = 10e9;
export const CAP_FALLBACK_ANALYSTS = 10;

/**
 * The analyst count the boost uses: the count, else CAP_FALLBACK_ANALYSTS
 * for a market value under $10 billion, else null (unknown is not low). Pure.
 */
export function effectiveAnalysts(c: Coverage | null | undefined): number | null {
  if (!c) return null;
  if (c.analysts !== null && Number.isFinite(c.analysts)) return Math.max(0, c.analysts);
  return c.marketCapUsd !== null && c.marketCapUsd < LOW_COVERAGE_CAP_USD ? CAP_FALLBACK_ANALYSTS : null;
}

/**
 * The hit score's coverage multiplier, 1 to 1.25:
 *   1 + 0.25 * clamp((20 - a) / (20 - 3), 0, 1)
 * a the effective analyst count; 1 when it is unknown. Pure.
 */
export function coverageBoost(c: Coverage | null | undefined): number {
  const a = effectiveAnalysts(c);
  if (a === null) return 1;
  const t = Math.min(1, Math.max(0, (COVERAGE_NONE_AT - a) / (COVERAGE_NONE_AT - COVERAGE_FULL_AT)));
  return 1 + COVERAGE_BOOST_MAX * t;
}

/** A hit the market is less likely to have priced at once: degree 2 (coverage now raises the hit's own score). Pure. */
export function isNonObvious(hit: Pick<RippleHit, "degree">): boolean {
  return hit.degree === 2;
}

// ---------------------------------------------------------------------------
// Scores

export const WEIGHTS = { link: 0.25, record: 0.45, judge: 0.15, size: 0.15 } as const;
export const NO_RECORD_STRENGTH = 0.2;
/** An unclear hit has no implied way, so no record can back it. */
export const UNCLEAR_FACTOR = 0.5;
/** Card score: the best hit, then half the second, a quarter of the third. */
export const CARD_HIT_WEIGHTS = [1, 0.5, 0.25] as const;
export const NON_OBVIOUS_BONUS = 1.25;
export const PENDING_ACQUISITION_FACTOR = 0.3;

/**
 * A hit's score, 0 to 100:
 *   min(100, 100 * D * B * (0.25 L + 0.45 R + 0.15 C + 0.15 S))
 * L link strength, R record strength, C the confidence after the record's
 * cap (1/3, 2/3, 1; the judge's call, never raised), S the event's size,
 * D 0.5 for an unclear direction, B the coverage boost (1 to 1.25).
 * Pure.
 */
export function hitScore(p: { link: LinkTier; record: number; confidence: Confidence; size: number; direction: Direction; boost?: number }): number {
  const raw = WEIGHTS.link * LINK_STRENGTH[p.link] + WEIGHTS.record * p.record + WEIGHTS.judge * CONF_WEIGHT[p.confidence] + WEIGHTS.size * p.size;
  const score = Math.round(1000 * raw * (p.direction === "unclear" ? UNCLEAR_FACTOR : 1) * (p.boost ?? 1)) / 10;
  return Math.min(100, score);
}

/** A card's score from its kept hits' scores. Pure. */
export function cardScoreOf(hitScores: number[], opts: { nonObvious: boolean; pendingAcquisition: boolean }): number {
  const top = [...hitScores].sort((a, b) => b - a).slice(0, CARD_HIT_WEIGHTS.length);
  const sum = top.reduce((s, x, i) => s + x * CARD_HIT_WEIGHTS[i]!, 0);
  const out = sum * (opts.nonObvious ? NON_OBVIOUS_BONUS : 1) * (opts.pendingAcquisition ? PENDING_ACQUISITION_FACTOR : 1);
  return Math.round(out * 10) / 10;
}

// ---------------------------------------------------------------------------
// Reasons (one plain sentence; information only, no advice words)

function linkPhrase(s: EdgeStrength, path: Pick<Path, "degree" | "via" | "relation" | "edges">): string {
  if (path.degree === 2) {
    const weaker = s.tier === "disclosed" ? "stated outright" : s.tier === "named" ? "named in a filing" : "only a list mention";
    return `Two links out via ${path.via}, the weaker one ${weaker}`;
  }
  switch (s.why) {
    case "share": {
      const pct = path.edges.map((e) => e.disclosedSharePct).find((x) => x !== null);
      return `A filing states a ${pct}% share for this link`;
    }
    case "sole_source":
      return "A filing names a sole or exclusive source on this link";
    case "over_10pct":
      return "A filing puts this link above 10% of revenue";
    case "list":
      return "Named only in a list in a filing";
    default:
      return path.relation === "competitor" ? "A filing names it a principal competitor" : path.relation === "peer" ? "A filing names this partnership" : "A filing names this supply link";
  }
}

function recordPhrase(r: RecordRead, direction: Direction): string {
  if (direction === "unclear") return "no implied way to measure a record";
  const times = `went the implied way ${r.wins} of ${r.sample} times`;
  switch (r.verdict) {
    case "none":
      return "no measured record yet";
    case "supports":
      return `${times}, better than a coin flip`;
    case "coin_flip":
      return `${times}, no better than a coin flip`;
    case "leans_other_way":
      return `${times} and the other way on average`;
    default:
      return `${times}, too few to tell`;
  }
}

function coveragePhrase(c: Coverage | null | undefined): string | null {
  if (coverageBoost(c) <= 1) return null;
  if (c!.analysts !== null) return `${c!.analysts} analyst${c!.analysts === 1 ? "" : "s"} cover it`;
  return "market value under $10 billion";
}

/** The hit's score reason, one sentence. Pure. */
export function scoreReasonOf(s: EdgeStrength, path: Pick<Path, "degree" | "via" | "relation" | "edges">, r: RecordRead, direction: Direction, coverage: Coverage | null | undefined): string {
  const parts = [linkPhrase(s, path), recordPhrase(r, direction), coveragePhrase(coverage)].filter((x): x is string => Boolean(x));
  return `${parts.join("; ")}.`;
}

// ---------------------------------------------------------------------------
// One card

export type RankedHits = {
  /** Kept hits, best first, with score, scoreReason and the capped confidence. */
  hits: Array<{ hit: RippleHit; path: Path }>;
  dropped: Array<{ ticker: string; why: string }>;
  capped: Array<{ ticker: string; from: Confidence; to: Confidence; why: string }>;
  /** Whether a kept hit is degree 2. */
  nonObvious: boolean;
  score: number;
};

const VERDICT_WHY: Record<RecordVerdict, string> = {
  none: "no measured record",
  supports: "record better than a coin flip",
  leans_other_way: "record leans the other way",
  coin_flip: "record no better than a coin flip",
  thin: "record too short to tell",
};

/**
 * Caps, filters, scores and orders one card's hits (their history filled
 * in). A hit is dropped when its link is a list mention only and its record
 * does not beat a coin flip (Wilson lower bound at or under 0.5, any sample).
 * The card keeps `maxHits` at most; with none left, it has no score. Pure.
 */
export function rankHits(
  ev: Pick<DetectedEvent, "magnitudePct" | "event" | "pendingAcquisition">,
  hits: Array<{ hit: RippleHit; path: Path }>,
  coverage: (ticker: string) => Coverage | null | undefined,
  maxHits = 5,
): RankedHits {
  const size = eventSize(ev);
  const dropped: RankedHits["dropped"] = [];
  const capped: RankedHits["capped"] = [];
  const kept: Array<{ hit: RippleHit; path: Path; score: number }> = [];
  for (const { hit, path } of hits) {
    const strength = pathStrength(path);
    const r = readRecord(hit.history, hit.direction);
    if (strength.tier === "list" && r.verdict !== "none" && r.verdict !== "supports") {
      dropped.push({ ticker: hit.ticker, why: `list mention only, and the record does not beat a coin flip (${r.wins} of ${r.sample}, lower bound ${r.lower.toFixed(2)})` });
      continue;
    }
    const judged = hit.confidence;
    const confidence = cappedConfidence(judged, r.verdict);
    if (confidence !== judged) {
      const rec = r.verdict === "none" ? "" : ` (${r.wins} of ${r.sample}, lower bound ${r.lower.toFixed(2)})`;
      capped.push({ ticker: hit.ticker, from: judged, to: confidence, why: `${VERDICT_WHY[r.verdict]}${rec}` });
    }
    const cov = coverage(hit.ticker);
    const score = hitScore({ link: strength.tier, record: recordStrength(r, hit.history, hit.direction), confidence, size, direction: hit.direction, boost: coverageBoost(cov) });
    kept.push({
      path,
      score,
      hit: {
        ...hit,
        confidence,
        score,
        scoreReason: scoreReasonOf(strength, path, r, hit.direction, cov),
        opportunityEligible: opportunityEligible(r, confidence, hit.direction, hit.pricedIn),
        analysts: cov?.analysts ?? null,
      },
    });
  }
  kept.sort((a, b) => b.score - a.score || a.hit.degree - b.hit.degree || a.hit.ticker.localeCompare(b.hit.ticker));
  const top = kept.slice(0, maxHits);
  for (const x of kept.slice(maxHits)) dropped.push({ ticker: x.hit.ticker, why: `past the ${maxHits} best hits (score ${x.score})` });
  const nonObvious = top.some((x) => isNonObvious(x.hit));
  const score = top.length ? cardScoreOf(top.map((x) => x.score), { nonObvious, pendingAcquisition: ev.pendingAcquisition }) : 0;
  return { hits: top.map(({ hit, path }) => ({ hit, path })), dropped, capped, nonObvious, score };
}
