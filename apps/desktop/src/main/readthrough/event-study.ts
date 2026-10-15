/**
 * Read-through event study: how a holding (H) has moved on the days a linked
 * company (the counterparty, C) reported.
 *
 * Inputs are daily closes (H, C and the benchmark, SPY) and C's report dates
 * with their hour. Everything is measured on sessions that have closed.
 *
 *   reaction session D   the session that first traded C's report: a report
 *                        after the close reads the next session, any other
 *                        hour (or none) the same session, or the next one
 *                        when the report day had none (the Tracker's rule,
 *                        earningsReactionMoves)
 *   move on D            close(D) / close(session before D) - 1
 *   beta                 OLS slope of the name's daily returns on SPY's over
 *                        the last 250 sessions, every reaction session and
 *                        the session after it left out; 1 when fewer than 60
 *                        sessions remain or SPY did not move
 *   abnormal move        move - beta x SPY's move, on the same session
 *   with it              sign(H abnormal) = sign(C abnormal), both non-zero
 *   avg follow           mean of H abnormal x sign(C abnormal)
 *   next session         the same abnormal move of H on the session after D
 *   normal abnormal      mean |H abnormal| over the last 120 sessions that are
 *                        not a reaction session or the session after one
 *   sensitivity          mean |H abnormal on D| / normal abnormal
 *   surprise agreement   sign(H abnormal) = sign(C's EPS surprise), over the
 *                        reports whose quarter the provider keeps
 *
 * A report is left out when H's own report was first traded the same session
 * (H's move would be its own news). At most the last eight reports count,
 * and with fewer than three there are no figures, only the count.
 *
 * Pure: no fs, no network, no clock.
 */

import {
  READTHROUGH_MAX_EVENTS,
  READTHROUGH_MIN_EVENTS,
  type ReadthroughEvent,
  type ReadthroughStats,
} from "../../shared/readthrough-types";
import type { EarningsTime } from "../../shared/earnings-types";
import { filingAcceptedMs } from "@meridian/research/edgar-time";
import { nyYmdOf, timeOfRelease } from "../../shared/earnings-time";
import { nearReportAnchor } from "../../shared/report-anchors";

export type Bar = { d: string; c: number };

/** One of a company's reports: its New York date and hour when known. */
export type ReportEvent = { date: string; hour: EarningsTime | null; surprisePct: number | null };

export const BETA_WINDOW = 250;
export const BETA_MIN_SESSIONS = 60;
export const NORMAL_WINDOW = 120;
export const NORMAL_MIN_SESSIONS = 40;
/** Two reports closer than this many days are the same one under two dates. */
export const SAME_REPORT_DAYS = 20;
/** A filing this close to a quarter's date is that quarter's release. */
const MATCH_DAYS = 3;

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

function dayMs(ymd: string): number {
  return Date.parse(`${ymd}T12:00:00Z`);
}

function apartDays(a: string, b: string): number {
  return Math.abs(dayMs(a) - dayMs(b)) / 86_400_000;
}

// ---------------------------------------------------------------------------
// Report dates
// ---------------------------------------------------------------------------

/** A quarter as the earnings service keeps it (Yahoo's earningsChart). */
export type QuarterLike = {
  reportedAt: string | null;
  reportedYmd: string | null;
  epsActual: number | null;
  epsEstimate: number | null;
};

/**
 * An 8-K with item 2.02 on EDGAR. `acceptedAt` is the true instant when
 * `acceptedAtUtc` is set (read at fetch time), else SEC's raw stamp (a day
 * cache written before), not always UTC; both are read
 * through `filingAcceptedMs` (@meridian/research/edgar-time).
 */
export type ReleaseFilingLike = { filedAt: string; acceptedAt: string | null; acceptedAtUtc?: boolean };

function surpriseOf(actual: number | null, estimate: number | null): number | null {
  if (actual === null || estimate === null || estimate === 0) return null;
  return Math.round(((actual - estimate) / Math.abs(estimate)) * 10_000) / 100;
}

/**
 * One report per release, oldest first: the provider's quarters (with the
 * release instant and the surprise), then EDGAR's item 2.02 filings for the
 * reports the provider no longer lists. A filing within twenty days of a
 * listed report is that report, and gives it its hour when the provider has
 * only the date. A filing far into its quarter from every day the provider's
 * reports fell on (Tesla's delivery figures, an analyst day outlook) is not a
 * report and is left out (shared/report-anchors.ts).
 */
export function reportEvents(quarters: readonly QuarterLike[], filings: readonly ReleaseFilingLike[]): ReportEvent[] {
  const nearAnchor = nearReportAnchor(quarters);
  const releases = filings
    .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.filedAt))
    .map((f): ReportEvent => {
      const ms = filingAcceptedMs(f);
      if (ms === null) return { date: f.filedAt, hour: null, surprisePct: null };
      const day = nyYmdOf(ms);
      // Accepted after midnight for a filing dated the day before: after that day's close.
      if (day > f.filedAt) return { date: f.filedAt, hour: "amc", surprisePct: null };
      return { date: day, hour: timeOfRelease(ms), surprisePct: null };
    })
    .filter((r) => nearAnchor(r.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  const out: ReportEvent[] = [];
  for (const q of quarters) {
    if (q.epsActual === null) continue;
    const ms = q.reportedAt ? Date.parse(q.reportedAt) : NaN;
    const date = Number.isFinite(ms) ? nyYmdOf(ms) : q.reportedYmd;
    if (!date) continue;
    const surprisePct = surpriseOf(q.epsActual, q.epsEstimate);
    if (Number.isFinite(ms)) {
      out.push({ date, hour: timeOfRelease(ms), surprisePct });
      continue;
    }
    // A date without the hour: the filing of the same release has it.
    const filing = releases.find((r) => r.hour !== null && apartDays(r.date, date) <= MATCH_DAYS);
    out.push(filing ? { date: filing.date, hour: filing.hour, surprisePct } : { date, hour: null, surprisePct });
  }
  for (const r of releases) {
    if (out.some((o) => apartDays(o.date, r.date) < SAME_REPORT_DAYS)) continue;
    out.push(r);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Closes
// ---------------------------------------------------------------------------

export type Aligned = { days: string[]; h: number[]; c: number[]; m: number[] };

/** The sessions all three series closed, before `today`, oldest first. */
export function alignCloses(holding: readonly Bar[], counterparty: readonly Bar[], market: readonly Bar[], today: string): Aligned {
  const cBy = new Map(counterparty.map((b) => [b.d, b.c]));
  const mBy = new Map(market.map((b) => [b.d, b.c]));
  const out: Aligned = { days: [], h: [], c: [], m: [] };
  const sorted = [...holding].sort((a, b) => a.d.localeCompare(b.d));
  for (const b of sorted) {
    if (b.d >= today) continue;
    const c = cBy.get(b.d);
    const m = mBy.get(b.d);
    if (!(b.c > 0) || c === undefined || !(c > 0) || m === undefined || !(m > 0)) continue;
    if (out.days[out.days.length - 1] === b.d) continue;
    out.days.push(b.d);
    out.h.push(b.c);
    out.c.push(c);
    out.m.push(m);
  }
  return out;
}

/** The index of the session that first traded a report, or -1 when the closes do not reach it. */
export function reactionIndex(days: readonly string[], event: Pick<ReportEvent, "date" | "hour">): number {
  const date = event.date.slice(0, 10);
  for (let i = 0; i < days.length; i++) {
    const d = days[i]!;
    if (event.hour === "amc" ? d > date : d >= date) {
      // A gap of more than a week means the closes skip the report (a halt, a listing gap).
      return apartDays(d, date) <= 7 ? i : -1;
    }
  }
  return -1;
}

function returnsOf(closes: readonly number[]): number[] {
  const out: number[] = [NaN];
  for (let i = 1; i < closes.length; i++) out.push(closes[i]! / closes[i - 1]! - 1);
  return out;
}

/** OLS slope of `y` on `x`; null when `x` does not vary. */
export function olsSlope(y: readonly number[], x: readonly number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i]!;
    my += y[i]!;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
  }
  return sxx > 0 ? sxy / sxx : null;
}

// ---------------------------------------------------------------------------
// The study
// ---------------------------------------------------------------------------

export type StudyInput = {
  holding: readonly Bar[];
  counterparty: readonly Bar[];
  market: readonly Bar[];
  /** C's reports. */
  events: readonly ReportEvent[];
  /** H's own reports: a C report first traded the same session as one of these is left out. */
  holdingEvents?: readonly ReportEvent[];
  /** New York's date: sessions from it on have not closed. */
  today: string;
  maxEvents?: number;
  minEvents?: number;
};

export type Study = {
  /** Reports measured (also when below the minimum). */
  sample: number;
  /** C reports left out because H reported the same session. */
  overlapping: number;
  /** Newest first. */
  events: ReadthroughEvent[];
  stats: ReadthroughStats | null;
  /** The last close used. */
  asOf: string | null;
};

function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** H's and C's beta over the window, the excluded sessions left out. */
function betas(a: Aligned, rh: number[], rc: number[], rm: number[], excluded: ReadonlySet<number>) {
  const idx: number[] = [];
  for (let i = a.days.length - 1; i >= 1 && idx.length < BETA_WINDOW; i--) if (!excluded.has(i)) idx.push(i);
  const x = idx.map((i) => rm[i]!);
  const fit = (r: number[]): { beta: number; fallback: boolean } => {
    if (idx.length < BETA_MIN_SESSIONS) return { beta: 1, fallback: true };
    const b = olsSlope(idx.map((i) => r[i]!), x);
    return b === null || !Number.isFinite(b) ? { beta: 1, fallback: true } : { beta: b, fallback: false };
  };
  return { h: fit(rh), c: fit(rc) };
}

export function studyPair(input: StudyInput): Study {
  const maxEvents = input.maxEvents ?? READTHROUGH_MAX_EVENTS;
  const minEvents = input.minEvents ?? READTHROUGH_MIN_EVENTS;
  const a = alignCloses(input.holding, input.counterparty, input.market, input.today);
  const asOf = a.days.length > 0 ? a.days[a.days.length - 1]! : null;
  const empty: Study = { sample: 0, overlapping: 0, events: [], stats: null, asOf };
  if (a.days.length < 2) return empty;

  const rh = returnsOf(a.h);
  const rc = returnsOf(a.c);
  const rm = returnsOf(a.m);

  const ownSessions = new Set<number>();
  for (const e of input.holdingEvents ?? []) {
    const i = reactionIndex(a.days, e);
    if (i >= 0) ownSessions.add(i);
  }

  // C's reports mapped to sessions, one per session, oldest first.
  const seen = new Set<number>();
  const mapped: Array<{ e: ReportEvent; i: number }> = [];
  let overlapping = 0;
  for (const e of [...input.events].sort((x, y) => x.date.localeCompare(y.date))) {
    const i = reactionIndex(a.days, e);
    if (i < 1 || seen.has(i)) continue;
    seen.add(i);
    if (ownSessions.has(i)) {
      overlapping++;
      continue;
    }
    mapped.push({ e, i });
  }

  // Every reaction session (and the one after) is kept out of beta and the normal move, H's own included.
  const excluded = new Set<number>();
  for (const i of [...seen, ...ownSessions]) {
    excluded.add(i);
    excluded.add(i + 1);
  }
  const beta = betas(a, rh, rc, rm, excluded);

  const chosen = mapped.slice(-maxEvents);
  const events: ReadthroughEvent[] = chosen.map(({ e, i }) => {
    const hAbn = rh[i]! - beta.h.beta * rm[i]!;
    const cAbn = rc[i]! - beta.c.beta * rm[i]!;
    const next = i + 1 < a.days.length ? rh[i + 1]! - beta.h.beta * rm[i + 1]! : null;
    return {
      date: e.date,
      reactionDay: a.days[i]!,
      counterpartyMove: round6(rc[i]!),
      counterpartyAbnormal: round6(cAbn),
      holdingMove: round6(rh[i]!),
      holdingAbnormal: round6(hAbn),
      holdingNextAbnormal: next === null ? null : round6(next),
      marketMove: round6(rm[i]!),
      surprisePct: e.surprisePct,
      withIt: sign(hAbn) === 0 || sign(cAbn) === 0 ? null : sign(hAbn) === sign(cAbn),
    };
  });
  events.reverse();

  const sample = events.length;
  if (sample < minEvents) return { sample, overlapping, events, stats: null, asOf };

  const normal: number[] = [];
  for (let i = a.days.length - 1; i >= 1 && normal.length < NORMAL_WINDOW; i--) {
    if (!excluded.has(i)) normal.push(Math.abs(rh[i]! - beta.h.beta * rm[i]!));
  }
  const normalAbs = normal.length >= NORMAL_MIN_SESSIONS ? mean(normal) : null;

  // The follow of each report is signed by the raw C abnormal move (computed above, rounded).
  const follow = events.map((ev) => ev.holdingAbnormal * sign(ev.counterpartyAbnormal));
  const nexts = events.filter((ev) => ev.holdingNextAbnormal !== null);
  const withSurprise = events.filter((ev) => ev.surprisePct !== null && ev.surprisePct !== 0 && ev.holdingAbnormal !== 0);
  const avgAbsAbnormal = mean(events.map((ev) => Math.abs(ev.holdingAbnormal)));

  const stats: ReadthroughStats = {
    events: sample,
    withIt: events.filter((ev) => ev.withIt === true).length,
    avgAbsMove: round6(mean(events.map((ev) => Math.abs(ev.holdingMove)))),
    avgAbsAbnormal: round6(avgAbsAbnormal),
    avgFollow: round6(mean(follow)),
    avgNextFollow: nexts.length > 0 ? round6(mean(nexts.map((ev) => ev.holdingNextAbnormal! * sign(ev.counterpartyAbnormal)))) : null,
    nextEvents: nexts.length,
    normalAbsAbnormal: normalAbs === null ? null : round6(normalAbs),
    sensitivity: normalAbs !== null && normalAbs > 0 ? Math.round((avgAbsAbnormal / normalAbs) * 1000) / 1000 : null,
    surpriseEvents: withSurprise.length,
    withSurprise: withSurprise.filter((ev) => sign(ev.holdingAbnormal) === sign(ev.surprisePct!)).length,
    beta: Math.round(beta.h.beta * 1000) / 1000,
    betaFallback: beta.h.fallback,
    from: events[events.length - 1]!.reactionDay,
    to: events[0]!.reactionDay,
  };
  return { sample, overlapping, events, stats, asOf };
}

/** A close-to-close move between two sessions on the bars; null when either is missing. */
export function moveBetween(bars: readonly Bar[], fromDay: string, toDay: string): number | null {
  const by = new Map(bars.map((b) => [b.d, b.c]));
  const a = by.get(fromDay);
  const b = by.get(toDay);
  return a && b ? round6(b / a - 1) : null;
}

/** The session before `day` on the bars, or null. */
export function sessionBefore(bars: readonly Bar[], day: string): string | null {
  let best: string | null = null;
  for (const b of bars) if (b.d < day && (best === null || b.d > best)) best = b.d;
  return best;
}
