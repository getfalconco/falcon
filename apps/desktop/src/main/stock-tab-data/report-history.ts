/**
 * Stock tab, earnings: the last reports on record, and what linked companies
 * reported first this season.
 *
 * Yahoo keeps four quarters (EPS actual and consensus, the release instant,
 * reported revenue). Two more sources stretch that toward eight:
 *
 *   - the quarters this tab has read before, kept per stock on disk: Yahoo
 *     drops the oldest quarter as each new one lands, the copy here does not
 *   - EDGAR: each 8-K with item 2.02 (results of operations) is a report on
 *     record with its acceptance instant, which gives the date and the hour
 *     (and so the session that first traded it) for reports Yahoo no longer
 *     lists. Those rows carry the date and the move only: no EPS is read from
 *     a filing, since a filing's GAAP figure is not the one the consensus is for
 *
 * The move is the Tracker's own rule (`earningsReactionMoves`): after the
 * close reads the next session, anything else the same one.
 *
 * Pure: no fs, no network, no clock.
 */

import { filingAcceptedMs } from "@meridian/research/edgar-time";
import { earningsReactionMoves } from "@meridian/research/tracker";
import type { EarningsTime } from "../../shared/earnings-types";
import type { LeadReport, ReportRow } from "../../shared/stock-tab-data";
import { nyYmdOf, timeOfRelease } from "../../shared/earnings-time";
import { fiscalLabel, type YahooQuarter } from "../earnings/earnings-sources";

export const REPORT_ROWS = 8;
/** Quarters kept per stock on disk: more than the table needs, so a re-dated quarter cannot push a real one out. */
export const STORED_QUARTERS = 12;
/** A filing this close to a quarter's release date is the same report. */
const MATCH_DAYS = 3;
/** Two item 2.02 filings closer than this are one report (an amendment, a re-filed exhibit). */
const SAME_REPORT_DAYS = 20;
/**
 * A filing-only release this far (days into its calendar quarter) from every
 * day Yahoo's confirmed reports fell on is not an earnings report: Tesla files
 * its delivery figures under item 2.02 two days into the quarter and reports
 * about three weeks later. Companies report in the same week year after year.
 */
const ANCHOR_DAYS = 14;

export type Bar = { d: string; c: number };

/**
 * An 8-K item 2.02 on EDGAR. `acceptedAt` is the true instant when
 * `acceptedAtUtc` is set (read at fetch time), else SEC's raw stamp, not
 * always UTC: read through `filingAcceptedMs`.
 */
export type ReleaseFiling = { acceptedAt: string | null; acceptedAtUtc?: boolean; filedAt: string; url: string | null };

function dayMs(ymd: string): number {
  return Date.parse(`${ymd}T12:00:00Z`);
}

function apart(a: string, b: string): number {
  return Math.abs(dayMs(a) - dayMs(b)) / 86_400_000;
}

/** The stored quarters with a fresh read laid over them, by period end, oldest first. */
export function mergeQuarters(stored: readonly YahooQuarter[], fresh: readonly YahooQuarter[]): YahooQuarter[] {
  const byEnd = new Map<string, YahooQuarter>();
  for (const q of stored) if (q.periodEnd) byEnd.set(q.periodEnd, q);
  for (const q of fresh) {
    if (!q.periodEnd) continue;
    const old = byEnd.get(q.periodEnd);
    // A fresh read without the actual (Yahoo's half-updated report day) does not wipe one on record.
    byEnd.set(q.periodEnd, old && q.epsActual === null && old.epsActual !== null ? old : q);
  }
  return [...byEnd.values()].sort((a, b) => (a.periodEnd ?? "").localeCompare(b.periodEnd ?? "")).slice(-STORED_QUARTERS);
}

type Report = {
  date: string;
  hour: EarningsTime | null;
  quarter: YahooQuarter | null;
  url: string | null;
};

function releaseOf(f: ReleaseFiling): { date: string; hour: EarningsTime | null } {
  const ms = filingAcceptedMs(f);
  if (ms !== null) return { date: nyYmdOf(ms), hour: timeOfRelease(ms) };
  return { date: f.filedAt, hour: null };
}

/** One report per release: Yahoo's quarters, matched to their filing where there is one, then the filings left over. */
export function collectReports(quarters: readonly YahooQuarter[], filings: readonly ReleaseFiling[]): Report[] {
  // The days into the calendar quarter the confirmed reports fell on; a release far from all of them is not earnings.
  const anchors = quarters.flatMap((q) => {
    if (q.epsActual === null) return [];
    const ms = q.reportedAt ? Date.parse(q.reportedAt) : NaN;
    const date = Number.isFinite(ms) ? nyYmdOf(ms) : q.reportedYmd;
    return date ? [quarterDay(date)] : [];
  });
  const nearAnchor = (date: string) => anchors.length < 2 || anchors.some((a) => quarterDistance(a, quarterDay(date)) <= ANCHOR_DAYS);
  const releases = filings
    .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.filedAt))
    .map((f) => ({ ...releaseOf(f), url: f.url }))
    .filter((r) => nearAnchor(r.date))
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((r, i, all) => i === 0 || apart(r.date, all[i - 1]!.date) >= SAME_REPORT_DAYS);
  const used = new Set<number>();
  const out: Report[] = [];
  for (const q of quarters) {
    if (q.epsActual === null) continue;
    const ms = q.reportedAt ? Date.parse(q.reportedAt) : NaN;
    const date = Number.isFinite(ms) ? nyYmdOf(ms) : q.reportedYmd;
    if (!date) continue;
    const idx = releases.findIndex((r, i) => !used.has(i) && apart(r.date, date) <= MATCH_DAYS);
    if (idx >= 0) used.add(idx);
    const filing = idx >= 0 ? releases[idx]! : null;
    out.push({
      date,
      hour: Number.isFinite(ms) ? timeOfRelease(ms) : (filing?.hour ?? null),
      quarter: q,
      url: filing?.url ?? null,
    });
  }
  releases.forEach((r, i) => {
    if (used.has(i)) return;
    // A filing within a few days of a listed report is that report under another date.
    if (out.some((o) => apart(o.date, r.date) < SAME_REPORT_DAYS)) return;
    out.push({ date: r.date, hour: r.hour, quarter: null, url: r.url });
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Days from the start of the date's calendar quarter. */
function quarterDay(ymd: string): number {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const start = Date.UTC(y, Math.floor((m - 1) / 3) * 3, 1, 12);
  return Math.round((dayMs(ymd) - start) / 86_400_000);
}

/** Distance between two quarter days, around the quarter (a report on Mar 30 and one on Apr 2 are close). */
function quarterDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 91 - d);
}

function surprise(actual: number | null, estimate: number | null): number | null {
  if (actual === null || estimate === null || estimate === 0) return null;
  return Math.round(((actual - estimate) / Math.abs(estimate)) * 10_000) / 100;
}

/** The last `limit` reports, newest first, each with the move of the session that first traded it. */
export function assembleReports(
  quarters: readonly YahooQuarter[],
  filings: readonly ReleaseFiling[],
  bars: readonly Bar[],
  today: string,
  limit = REPORT_ROWS,
): ReportRow[] {
  const reports = collectReports(quarters, filings).filter((r) => r.date <= today).slice(-limit);
  const moves = earningsReactionMoves(
    bars,
    reports.map((r) => ({ date: r.date, hour: r.hour })),
  );
  const byDate = new Map(moves.map((m) => [m.date, m] as const));
  return reports
    .map((r): ReportRow => {
      const m = byDate.get(r.date);
      // A session still under way is not a move yet.
      const done = m && m.reactionDay < today ? m : null;
      const q = r.quarter;
      return {
        date: r.date,
        time: r.hour ?? "unknown",
        fiscalPeriod: q?.fiscalQuarter ? (fiscalLabel(q.fiscalQuarter) ?? q.fiscalQuarter) : null,
        periodEnd: q?.periodEnd ?? null,
        epsActual: q?.epsActual ?? null,
        epsEstimate: q?.epsEstimate ?? null,
        surprisePct: surprise(q?.epsActual ?? null, q?.epsEstimate ?? null),
        revenueActual: q?.revenueActual ?? null,
        move: done ? Math.round(done.move * 1e6) / 1e6 : null,
        reactionDay: done ? done.reactionDay : null,
        source: q ? { kind: "yahoo", url: r.url } : { kind: "filing", url: r.url },
      };
    })
    .reverse();
}

// ---------------------------------------------------------------------------
// Lead reports
// ---------------------------------------------------------------------------

/** How far back a season reaches when the stock's own last report is older or unknown. */
export const SEASON_MAX_DAYS = 100;

/** The season the lead reports are drawn from: after the stock's last report, at most SEASON_MAX_DAYS back, up to today or its next report. */
export function seasonWindow(lastReport: string | null, next: string | null, today: string): { from: string; to: string } {
  const floorMs = dayMs(today) - SEASON_MAX_DAYS * 86_400_000;
  const floor = new Date(floorMs).toISOString().slice(0, 10);
  const afterLast = lastReport ? new Date(dayMs(lastReport) + 86_400_000).toISOString().slice(0, 10) : floor;
  const from = afterLast > floor ? afterLast : floor;
  const to = next && next < today ? next : today;
  return { from, to };
}

export type LinkedCompany = {
  ticker: string;
  category: string;
  direction: "names" | "named";
  filingUrl: string | null;
  quarters: readonly YahooQuarter[];
  /** The reaction moves on record for it (earnings-reactions), by report date. */
  moves: ReadonlyArray<{ date: string; reactionDay: string; move: number }>;
};

/** Each linked company's latest report inside the window, newest first. */
export function leadReports(linked: readonly LinkedCompany[], window: { from: string; to: string }, today: string): LeadReport[] {
  const out: LeadReport[] = [];
  for (const c of linked) {
    const reported = c.quarters
      .filter((q) => q.epsActual !== null)
      .map((q) => {
        const ms = q.reportedAt ? Date.parse(q.reportedAt) : NaN;
        return { q, date: Number.isFinite(ms) ? nyYmdOf(ms) : q.reportedYmd };
      })
      .filter((x): x is { q: YahooQuarter; date: string } => !!x.date && x.date >= window.from && x.date <= window.to)
      .sort((a, b) => b.date.localeCompare(a.date));
    const latest = reported[0];
    if (!latest) continue;
    const m = c.moves.find((x) => x.date === latest.date);
    out.push({
      ticker: c.ticker,
      category: c.category,
      direction: c.direction,
      filingUrl: c.filingUrl,
      date: latest.date,
      fiscalPeriod: latest.q.fiscalQuarter ? (fiscalLabel(latest.q.fiscalQuarter) ?? latest.q.fiscalQuarter) : null,
      epsActual: latest.q.epsActual,
      epsEstimate: latest.q.epsEstimate,
      surprisePct: surprise(latest.q.epsActual, latest.q.epsEstimate),
      move: m && m.reactionDay < today ? m.move : null,
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.ticker.localeCompare(b.ticker));
}
