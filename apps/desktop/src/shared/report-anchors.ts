/**
 * Which 8-K item 2.02 filings are earnings reports.
 *
 * Item 2.02 ("results of operations") also carries filings that are not a
 * quarter's report: Tesla files its delivery figures under it two days into
 * each quarter and reports about three weeks later, and HPE filed its October
 * 2025 analyst day outlook under it. Companies report in the same week of the
 * quarter year after year, so a filing far (in days into its calendar quarter)
 * from every day the provider's confirmed reports fell on is not a report.
 *
 * Used by the Stock tab's report history (main/stock-tab-data/report-history.ts)
 * and the read-through event study (main/readthrough/event-study.ts), so both
 * count the same releases.
 *
 * Pure.
 */

import { nyYmdOf } from "./earnings-time";

/** A filing further than this (days into the calendar quarter) from every confirmed report day is not a report. */
export const ANCHOR_DAYS = 14;

/** The fields of a provider quarter the anchors read. */
export type AnchorQuarter = { reportedAt: string | null; reportedYmd: string | null; epsActual: number | null };

function dayMs(ymd: string): number {
  return Date.parse(`${ymd}T12:00:00Z`);
}

/** Days from the start of the date's calendar quarter. */
export function quarterDay(ymd: string): number {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const start = Date.UTC(y, Math.floor((m - 1) / 3) * 3, 1, 12);
  return Math.round((dayMs(ymd) - start) / 86_400_000);
}

/** Distance between two quarter days, around the quarter (a report on Mar 30 and one on Apr 2 are close). */
export function quarterDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 91 - d);
}

/** The New York date a confirmed quarter was reported on; null when it carries none. */
export function reportedDate(q: AnchorQuarter): string | null {
  const ms = q.reportedAt ? Date.parse(q.reportedAt) : NaN;
  return Number.isFinite(ms) ? nyYmdOf(ms) : q.reportedYmd;
}

/**
 * A test for release dates: true when the date sits near a day the
 * provider's confirmed reports fell on. With fewer than two confirmed reports
 * there is nothing to go by and every date passes.
 */
export function nearReportAnchor(quarters: readonly AnchorQuarter[]): (date: string) => boolean {
  const anchors = quarters.flatMap((q) => {
    if (q.epsActual === null) return [];
    const date = reportedDate(q);
    return date ? [quarterDay(date)] : [];
  });
  return (date: string) => anchors.length < 2 || anchors.some((a) => quarterDistance(a, quarterDay(date)) <= ANCHOR_DAYS);
}
