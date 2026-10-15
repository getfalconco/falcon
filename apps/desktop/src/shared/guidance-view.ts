/**
 * Guidance track record: how the rows and the pattern lines read, in the
 * reader's language. The words come from the message tables (`guidance.*`)
 * through `say`; this file picks the line and formats the figures.
 *
 * Pure: no React, no clock.
 */

import type { FiscalPeriod, GuidanceBasis, GuidancePattern, GuidanceRow, GuidanceUnit } from "./guidance-types";
import { dominantPosition } from "./guidance-track";

export type Say = (key: string, params?: Record<string, string | number>) => string;

/** Rows shown before "Show all". */
export const ROWS_SHOWN = 12;

/** Pattern lines shown at most: the first guided figures in table order (revenue, margins, expenses, EPS). */
export const PATTERN_LINES = 4;

export function shownPatterns(patterns: readonly GuidancePattern[]): GuidancePattern[] {
  return patterns.slice(0, PATTERN_LINES);
}

export function periodText(p: FiscalPeriod, say: Say): string {
  return p.fq === null ? say("guidance.period.year", { fy: p.fy }) : say("guidance.period.quarter", { q: p.fq, fy: p.fy });
}

export function metricText(metric: GuidanceRow["metric"], basis: GuidanceBasis | "both", say: Say): string {
  const name = say(`guidance.metric.${metric}`);
  return basis === "unspecified" ? name : say(`guidance.basis.${basis}`, { metric: name });
}

function currencyOrUsd(currency: string): string {
  return /^[A-Z]{3}$/.test(currency) ? currency : "USD";
}

/** One figure: money in short form ($108.0B), per share to the cent, percent to the printed decimals. */
export function figureText(value: number, unit: GuidanceUnit, currency: string, lang: string): string {
  if (unit === "percent") {
    return new Intl.NumberFormat(lang, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(value / 100);
  }
  if (unit === "per_share") {
    return new Intl.NumberFormat(lang, { style: "currency", currency: currencyOrUsd(currency), minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  }
  return new Intl.NumberFormat(lang, {
    style: "currency",
    currency: currencyOrUsd(currency),
    notation: "compact",
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  }).format(value);
}

/** The guide as a range ("$105.84B to $110.16B") or a single figure. */
export function guideText(row: Pick<GuidanceRow, "low" | "high" | "unit" | "currency">, lang: string, say: Say): string {
  const low = figureText(row.low, row.unit, row.currency, lang);
  if (row.low === row.high) return low;
  return say("guidance.range", { low, high: figureText(row.high, row.unit, row.currency, lang) });
}

/** The gap to the midpoint: "+4.8%" of it for money, "+0.6 pts" for percent figures. */
export function gapText(gap: number, kind: GuidancePattern["gapKind"], lang: string, say: Say): string {
  if (kind === "points") {
    const value = new Intl.NumberFormat(lang, { signDisplay: "exceptZero", minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(gap);
    return say("guidance.gap.points", { value });
  }
  return new Intl.NumberFormat(lang, { style: "percent", signDisplay: "exceptZero", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(gap);
}

/** The result word of a row: where the figure landed, or why there is none. */
export function resultKey(row: Pick<GuidanceRow, "state" | "position" | "point">): string {
  if (row.state === "open") return "guidance.result.open";
  if (row.state === "missing" || row.position === null) return "guidance.result.missing";
  if (row.position === "inside") return row.point ? "guidance.result.met" : "guidance.result.inside";
  return `guidance.result.${row.position}`;
}

/**
 * The pattern as one or two sentences: where the figure landed most often,
 * then how often it was at or above the midpoint and the median gap. A guide
 * given as single figures has no range, so the second sentence is the gap alone.
 */
export function patternText(p: GuidancePattern, lang: string, say: Say): string {
  const metric = metricText(p.metric, p.basis, say);
  const where = dominantPosition(p);
  const count = where === "above" ? p.above : where === "below" ? p.below : p.inside;
  const lead = say(`guidance.pattern.${p.point ? "point" : ""}${p.point ? where[0]!.toUpperCase() + where.slice(1) : where}`, { metric, count, n: p.n });
  const gap = p.medianGap !== null ? gapText(p.medianGap, p.gapKind, lang, say) : null;
  if (p.point) return gap ? `${lead} ${say("guidance.pattern.pointGap", { gap })}` : lead;
  const mid = gap
    ? say("guidance.pattern.mid", { mid: p.atOrAboveMid, n: p.n, gap })
    : say("guidance.pattern.midNoGap", { mid: p.atOrAboveMid, n: p.n });
  return `${lead} ${mid}`;
}

/** Rows worth a line: a figure the period's release did not state carries no comparison. */
export function visibleRows(rows: readonly GuidanceRow[]): GuidanceRow[] {
  return rows.filter((r) => r.state !== "missing");
}
