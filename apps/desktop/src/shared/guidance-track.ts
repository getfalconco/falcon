/**
 * Guidance track record: the comparison, from checked releases
 * (shared/guidance-verify.ts) to the rows and the pattern lines the Stock
 * tab shows.
 *
 *   rows      one per guided figure and period: the last guide the company
 *             gave for that period before reporting it, the reported figure,
 *             where it landed (above the top of the guide, inside it, below
 *             the bottom), the gap to the guide's midpoint, and whether that
 *             guide raised, cut or kept an earlier one for the same period
 *   patterns  per guided figure, over the quarters with both a guide and a
 *             result: how often it landed above, inside and below, how often
 *             at or above the midpoint, and the median gap. Never under
 *             MIN_PATTERN quarters
 *
 * A single-figure guide ("approximately $9.2 billion") counts as met when
 * the result rounds to it at the precision it was printed with; a range
 * counts its ends as inside. Money gaps are a share of the midpoint, percent
 * gaps are percentage points.
 *
 * Pure: no fs, no network, no clock.
 */

import {
  GUIDANCE_METRICS,
  type ActualFigure,
  type FiscalPeriod,
  type GuidanceBasis,
  type GuidanceMetric,
  type GuidancePattern,
  type GuidancePosition,
  type GuidanceRelease,
  type GuidanceRevision,
  type GuidanceRow,
  type GuidanceTrack,
  type GuideFigure,
} from "./guidance-types";
import { periodKey, samePeriod } from "./guidance-verify";

/** No pattern line under this many quarters. */
export const MIN_PATTERN = 3;
/** Quarters a pattern looks back over at most. */
export const PATTERN_WINDOW = 8;

const METRIC_ORDER = new Map<GuidanceMetric, number>(GUIDANCE_METRICS.map((m, i) => [m, i]));
const BASIS_ORDER: Record<GuidanceBasis | "both", number> = { unspecified: 0, both: 1, gaap: 2, non_gaap: 3 };

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** How far a result may sit from a single-figure guide and still be that figure: half its printed step. */
function tolerance(low: number, high: number, step: number): number {
  return low === high ? step / 2 : 1e-9 * Math.max(1, Math.abs(low), Math.abs(high));
}

export function positionOf(actual: number, low: number, high: number, step: number): GuidancePosition {
  const tol = tolerance(low, high, step);
  if (actual > high + tol) return "above";
  if (actual < low - tol) return "below";
  return "inside";
}

export function gapOf(actual: number, mid: number, unit: GuideFigure["unit"]): number | null {
  if (unit === "percent") return round6(actual - mid);
  if (mid === 0) return null;
  return round6((actual - mid) / Math.abs(mid));
}

export function revisionOf(prior: { low: number; high: number }, next: { low: number; high: number }): GuidanceRevision {
  const a = (prior.low + prior.high) / 2;
  const b = (next.low + next.high) / 2;
  if (nearlyEqual(a, b)) return "kept";
  return b > a ? "raised" : "cut";
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Bases a guide's result may be read under: its own, and GAAP and unlabelled for each other. */
function basesFor(basis: GuidanceBasis): GuidanceBasis[] {
  if (basis === "unspecified") return ["unspecified", "gaap"];
  if (basis === "gaap") return ["gaap", "unspecified"];
  return ["non_gaap"];
}

type Sourced<T> = { fig: T; release: GuidanceRelease };

/** The release that reports a period: the quarter's own, or for a whole year the release of its fourth quarter. */
function reportingRelease(period: FiscalPeriod, releases: readonly GuidanceRelease[]): GuidanceRelease | null {
  const want: FiscalPeriod = period.fq === null ? { fy: period.fy, fq: 4 } : period;
  return releases.find((r) => r.reported && samePeriod(r.reported, want)) ?? null;
}

function actualFor(guide: GuideFigure, releases: readonly GuidanceRelease[]): Sourced<ActualFigure> | null {
  for (const basis of basesFor(guide.basis)) {
    for (const release of releases) {
      const fig = release.actuals.find(
        (a) => a.metric === guide.metric && a.basis === basis && a.unit === guide.unit && samePeriod(a.period, guide.period),
      );
      if (fig) return { fig, release };
    }
  }
  return null;
}

/** Every guided figure and period, matched to its result. Before the GAAP and non-GAAP twins are folded. */
export function guidanceRows(releases: readonly GuidanceRelease[]): GuidanceRow[] {
  const ordered = [...releases].sort((a, b) => a.filedAt.localeCompare(b.filedAt) || a.accession.localeCompare(b.accession));
  const groups = new Map<string, Sourced<GuideFigure>[]>();
  for (const release of ordered) {
    for (const fig of release.guides) {
      const key = `${fig.metric}|${fig.basis}|${periodKey(fig.period)}`;
      const list = groups.get(key) ?? [];
      list.push({ fig, release });
      groups.set(key, list);
    }
  }
  const rows: GuidanceRow[] = [];
  for (const list of groups.values()) {
    const period = list[0]!.fig.period;
    const reporting = reportingRelease(period, ordered);
    // Only what was said before the period was reported is guidance for it.
    const eligible = reporting ? list.filter((g) => g.release.filedAt < reporting.filedAt) : list;
    const last = eligible[eligible.length - 1];
    if (!last) continue;
    const before = eligible.length > 1 ? eligible[eligible.length - 2]! : null;
    const g = last.fig;
    const mid = (g.low + g.high) / 2;
    const found = actualFor(g, reporting ? [reporting, ...ordered.filter((r) => r !== reporting)] : ordered);
    const actual = found ? found.fig.value : null;
    rows.push({
      period: g.period,
      metric: g.metric,
      basis: g.basis,
      unit: g.unit,
      currency: g.currency,
      low: g.low,
      high: g.high,
      mid,
      point: g.low === g.high,
      state: actual !== null ? "resolved" : reporting ? "missing" : "open",
      actual,
      position: actual !== null ? positionOf(actual, g.low, g.high, g.step) : null,
      gap: actual !== null ? gapOf(actual, mid, g.unit) : null,
      revision: before ? revisionOf(before.fig, g) : null,
      prior: before ? { low: before.fig.low, high: before.fig.high, filedAt: before.release.filedAt } : null,
      guide: { quote: g.quote, url: last.release.url, filedAt: last.release.filedAt },
      reported: found ? { quote: found.fig.quote, url: found.release.url, filedAt: found.release.filedAt } : null,
    });
  }
  return rows;
}

function sameFigures(a: GuidanceRow, b: GuidanceRow): boolean {
  return (
    nearlyEqual(a.low, b.low) &&
    nearlyEqual(a.high, b.high) &&
    a.state === b.state &&
    (a.actual === null ? b.actual === null : b.actual !== null && nearlyEqual(a.actual, b.actual)) &&
    a.revision === b.revision
  );
}

/** GAAP and non-GAAP rows of one period with the same guide and the same result, as one "both" row. */
export function foldTwins(rows: readonly GuidanceRow[]): GuidanceRow[] {
  const out: GuidanceRow[] = [];
  const dropped = new Set<GuidanceRow>();
  for (const row of rows) {
    if (dropped.has(row)) continue;
    if (row.basis === "gaap") {
      const twin = rows.find((r) => r.basis === "non_gaap" && r.metric === row.metric && samePeriod(r.period, row.period) && !dropped.has(r));
      if (twin && sameFigures(row, twin)) {
        dropped.add(twin);
        out.push({ ...row, basis: "both" });
        continue;
      }
    }
    out.push(row);
  }
  return out;
}

export function sortRows(rows: readonly GuidanceRow[]): GuidanceRow[] {
  return [...rows].sort(
    (a, b) =>
      periodKey(b.period) - periodKey(a.period) ||
      (METRIC_ORDER.get(a.metric) ?? 99) - (METRIC_ORDER.get(b.metric) ?? 99) ||
      BASIS_ORDER[a.basis] - BASIS_ORDER[b.basis],
  );
}

/** Per guided figure, over its last PATTERN_WINDOW resolved quarters; none under MIN_PATTERN. */
export function guidancePatterns(rows: readonly GuidanceRow[]): GuidancePattern[] {
  const groups = new Map<string, GuidanceRow[]>();
  for (const r of rows) {
    if (r.state !== "resolved" || r.period.fq === null || r.position === null || r.basis === "both") continue;
    const key = `${r.metric}|${r.basis}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const patterns: GuidancePattern[] = [];
  for (const list of groups.values()) {
    const window = list.sort((a, b) => periodKey(a.period) - periodKey(b.period)).slice(-PATTERN_WINDOW);
    if (window.length < MIN_PATTERN) continue;
    const first = window[0]!;
    const gaps = window.map((r) => r.gap).filter((g): g is number => g !== null);
    patterns.push({
      metric: first.metric,
      basis: first.basis,
      n: window.length,
      above: window.filter((r) => r.position === "above").length,
      inside: window.filter((r) => r.position === "inside").length,
      below: window.filter((r) => r.position === "below").length,
      atOrAboveMid: window.filter(atOrAboveMid).length,
      medianGap: gaps.length === window.length ? round6(median(gaps)!) : null,
      gapKind: first.unit === "percent" ? "points" : "relative",
      point: window.every((r) => r.point),
    });
  }
  return foldPatternTwins(patterns).sort(
    (a, b) => (METRIC_ORDER.get(a.metric) ?? 99) - (METRIC_ORDER.get(b.metric) ?? 99) || BASIS_ORDER[a.basis] - BASIS_ORDER[b.basis],
  );
}

/** At or above the midpoint; a single-figure guide met at its printed precision counts as at it. */
function atOrAboveMid(r: GuidanceRow): boolean {
  if (r.actual === null) return false;
  if (r.point) return r.position !== "below";
  return r.actual >= r.mid || nearlyEqual(r.actual, r.mid);
}

function foldPatternTwins(patterns: GuidancePattern[]): GuidancePattern[] {
  const out: GuidancePattern[] = [];
  const dropped = new Set<GuidancePattern>();
  for (const p of patterns) {
    if (dropped.has(p)) continue;
    if (p.basis === "gaap") {
      const twin = patterns.find((q) => q.basis === "non_gaap" && q.metric === p.metric);
      if (
        twin &&
        twin.n === p.n &&
        twin.above === p.above &&
        twin.inside === p.inside &&
        twin.below === p.below &&
        twin.atOrAboveMid === p.atOrAboveMid &&
        (twin.medianGap === null ? p.medianGap === null : p.medianGap !== null && Math.abs(twin.medianGap - p.medianGap) < 1e-6)
      ) {
        dropped.add(twin);
        out.push({ ...p, basis: "both" });
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

/** The whole track record for one company, from its checked releases. */
export function buildTrack(ticker: string, releases: readonly GuidanceRelease[]): GuidanceTrack {
  const raw = guidanceRows(releases);
  const latest = releases.reduce<string | null>((max, r) => (max === null || r.filedAt > max ? r.filedAt : max), null);
  return {
    ticker,
    releases: releases.length,
    latest,
    rows: sortRows(foldTwins(raw)),
    patterns: guidancePatterns(raw),
  };
}

/**
 * The one sentence a pattern leads with: where the figure landed most often.
 * Ties go to inside, then above.
 */
export function dominantPosition(p: GuidancePattern): GuidancePosition {
  if (p.inside >= p.above && p.inside >= p.below) return "inside";
  return p.above >= p.below ? "above" : "below";
}
