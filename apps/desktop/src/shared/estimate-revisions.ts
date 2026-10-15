/**
 * Analyst estimate revisions before a report: how the consensus EPS for the
 * quarter being reported, the next quarter and the fiscal year has moved, and
 * how many analysts raised or lowered it.
 *
 * Source
 * ------
 *   Yahoo quoteSummary `earningsTrend`, per period (0q, +1q, 0y):
 *     epsTrend          the mean EPS estimate now and 7, 30, 60, 90 days ago
 *     epsRevisions      analysts who raised (upLast7days, upLast30days) and
 *                       lowered (downLast7Days, downLast30days) it
 *     earningsEstimate  how many analysts the mean is drawn from
 *     revenueEstimate   the mean revenue estimate now, with no history. The
 *                       app keeps one reading a day per name (main/estimates)
 *                       and the 30 day change is shown once a reading from 26
 *                       to 45 days back is on record
 *
 * Method
 * ------
 *   Change of the mean over 7, 30 and 90 days as a percent of the earlier
 *   mean. When the earlier mean is under TINY_BASE in size, or the mean has
 *   crossed zero, a percent says nothing, and the change is given as an amount
 *   (cents for a dollar estimate). A period drawn from fewer than MIN_ANALYSTS
 *   analysts gives no figures at all.
 *
 *   A change is notable when the 30 day move is at least NOTABLE_PCT (or
 *   NOTABLE_AMOUNT for an amount), or the revisions are lopsided: at least
 *   LOPSIDED_MIN on one side and at least LOPSIDED_RATIO times the other.
 *
 * Pure: the clock and every reading are parameters.
 */

import { addDaysYmd, formatEps } from "./earnings-view";
import { nextSession, nyYmdOf, sessionOf } from "./earnings-time";

export const ESTIMATE_PERIODS = ["0q", "+1q", "0y"] as const;
export type EstimatePeriod = (typeof ESTIMATE_PERIODS)[number];

export const MIN_ANALYSTS = 3;
/** Earlier means smaller than this (in the estimate's currency) are compared as an amount. */
export const TINY_BASE = 0.1;
export const NOTABLE_PCT = 0.03;
export const NOTABLE_AMOUNT = 0.05;
export const LOPSIDED_RATIO = 5;
export const LOPSIDED_MIN = 5;
/** Changes smaller than this (as a fraction) read as unchanged. */
export const FLAT_PCT = 0.0005;
/** Upcoming reports this many calendar days out or fewer get the Earnings tab line (two weeks, today included). */
export const ESTIMATES_WITHIN_DAYS = 13;
/** Names one estimates request may carry. */
export const ESTIMATES_REQUEST_CAP = 40;
/** How long a reading taken during the regular session is reused. */
export const OPEN_TTL_MS = 30 * 60_000;
/** Revenue readings kept per name. */
export const REVENUE_HISTORY_DAYS = 120;
export const REVENUE_LOOKBACK_MIN_DAYS = 26;
export const REVENUE_LOOKBACK_MAX_DAYS = 45;
export const REVENUE_LOOKBACK_DAYS = 30;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Reading the provider's reply
// ---------------------------------------------------------------------------

export type TrendRow = {
  period: EstimatePeriod;
  periodEnd: string | null;
  currency: string | null;
  analysts: number | null;
  now: number | null;
  ago7: number | null;
  ago30: number | null;
  ago90: number | null;
  up7: number | null;
  down7: number | null;
  up30: number | null;
  down30: number | null;
  revenue: number | null;
  revenueAnalysts: number | null;
  revenueCurrency: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function rawNum(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = record(value)?.raw;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function count(value: unknown): number | null {
  const n = rawNum(value);
  return n !== null && n >= 0 ? Math.round(n) : null;
}

function ymdOf(value: unknown): string | null {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const fmt = record(value)?.fmt;
  if (typeof fmt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fmt)) return fmt;
  return null;
}

function code(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const c = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

/** The periods of an `earningsTrend` module, parsed; empty when the reply carries none. */
export function readEarningsTrend(modules: unknown): TrendRow[] {
  const list = record(record(modules)?.earningsTrend)?.trend;
  if (!Array.isArray(list)) return [];
  const out: TrendRow[] = [];
  for (const t of list.map(record)) {
    const period = t?.period;
    if (!t || typeof period !== "string" || !(ESTIMATE_PERIODS as readonly string[]).includes(period)) continue;
    if (out.some((r) => r.period === period)) continue;
    const et = record(t.epsTrend);
    const er = record(t.epsRevisions);
    const ee = record(t.earningsEstimate);
    const re = record(t.revenueEstimate);
    out.push({
      period: period as EstimatePeriod,
      periodEnd: ymdOf(t.endDate),
      currency: code(et?.epsTrendCurrency) ?? code(ee?.earningsCurrency) ?? code(er?.epsRevisionsCurrency),
      analysts: count(ee?.numberOfAnalysts),
      now: rawNum(et?.current),
      ago7: rawNum(et?.["7daysAgo"]),
      ago30: rawNum(et?.["30daysAgo"]),
      ago90: rawNum(et?.["90daysAgo"]),
      up7: count(er?.upLast7days),
      // The provider spells this one with a capital D.
      down7: count(er?.downLast7Days) ?? count(er?.downLast7days),
      up30: count(er?.upLast30days),
      down30: count(er?.downLast30days),
      revenue: rawNum(re?.avg),
      revenueAnalysts: count(re?.numberOfAnalysts),
      revenueCurrency: code(re?.revenueCurrency),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/** A change of the mean: a percent of the earlier mean, or (tiny base, crossed zero) an amount. */
export type EpsChange = { kind: "pct"; value: number; from: number; to: number } | { kind: "amount"; value: number; from: number; to: number };

export function epsChange(from: number | null, to: number | null): EpsChange | null {
  if (from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  const crossed = (from < 0 && to > 0) || (from > 0 && to < 0);
  if (Math.abs(from) < TINY_BASE || crossed) return { kind: "amount", value: round(to - from, 4), from, to };
  return { kind: "pct", value: round((to - from) / Math.abs(from), 6), from, to };
}

export type RevenueChange = { pct: number; from: number; fromDate: string };

export type PeriodEstimates = {
  period: EstimatePeriod;
  periodEnd: string | null;
  currency: string | null;
  analysts: number;
  now: number;
  ago30: number | null;
  change7: EpsChange | null;
  change30: EpsChange | null;
  change90: EpsChange | null;
  up7: number | null;
  down7: number | null;
  up30: number | null;
  down30: number | null;
  revenue: { now: number; analysts: number; currency: string | null; change30: RevenueChange | null } | null;
};

export type EstimateRevisions = {
  ticker: string;
  /** When the provider was read, ISO. */
  readAt: string;
  periods: PeriodEstimates[];
};

// ---------------------------------------------------------------------------
// Revenue readings kept by the app
// ---------------------------------------------------------------------------

/** One day's mean revenue estimate for one period. */
export type RevenuePoint = { d: string; p: EstimatePeriod; e: string | null; v: number };

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS);
}

/** Today's readings added (replacing today's), older than REVENUE_HISTORY_DAYS dropped, oldest first. */
export function recordRevenue(history: readonly RevenuePoint[], today: string, rows: readonly TrendRow[]): RevenuePoint[] {
  const floor = addDaysYmd(today, -REVENUE_HISTORY_DAYS);
  const kept = history.filter((p) => p.d !== today && p.d >= floor && Number.isFinite(p.v) && p.v > 0);
  for (const r of rows) {
    if (r.revenue !== null && r.revenue > 0) kept.push({ d: today, p: r.period, e: r.periodEnd, v: r.revenue });
  }
  return kept.sort((a, b) => a.d.localeCompare(b.d) || a.p.localeCompare(b.p));
}

/** The mean revenue estimate now against the reading closest to thirty days back (26 to 45 days) for the same period. */
export function revenueChange(history: readonly RevenuePoint[], period: EstimatePeriod, periodEnd: string | null, today: string, now: number): RevenueChange | null {
  if (!(now > 0)) return null;
  let best: RevenuePoint | null = null;
  for (const p of history) {
    if (p.p !== period || p.e !== periodEnd || !(p.v > 0)) continue;
    const age = daysBetween(p.d, today);
    if (age < REVENUE_LOOKBACK_MIN_DAYS || age > REVENUE_LOOKBACK_MAX_DAYS) continue;
    if (!best || Math.abs(age - REVENUE_LOOKBACK_DAYS) < Math.abs(daysBetween(best.d, today) - REVENUE_LOOKBACK_DAYS)) best = p;
  }
  return best ? { pct: round((now - best.v) / best.v, 6), from: best.v, fromDate: best.d } : null;
}

// ---------------------------------------------------------------------------
// The figures
// ---------------------------------------------------------------------------

/** The figures per period, the periods with fewer than MIN_ANALYSTS left out; null when none is left. */
export function buildEstimates(
  ticker: string,
  rows: readonly TrendRow[],
  revenueHistory: readonly RevenuePoint[],
  today: string,
  readAt: string,
): EstimateRevisions | null {
  const periods: PeriodEstimates[] = [];
  for (const period of ESTIMATE_PERIODS) {
    const r = rows.find((x) => x.period === period);
    if (!r || r.now === null || r.analysts === null || r.analysts < MIN_ANALYSTS) continue;
    const revenue =
      r.revenue !== null && r.revenue > 0 && r.revenueAnalysts !== null && r.revenueAnalysts >= MIN_ANALYSTS
        ? {
            now: r.revenue,
            analysts: r.revenueAnalysts,
            currency: r.revenueCurrency,
            change30: revenueChange(revenueHistory, period, r.periodEnd, today, r.revenue),
          }
        : null;
    periods.push({
      period,
      periodEnd: r.periodEnd,
      currency: r.currency,
      analysts: r.analysts,
      now: r.now,
      ago30: r.ago30,
      change7: epsChange(r.ago7, r.now),
      change30: epsChange(r.ago30, r.now),
      change90: epsChange(r.ago90, r.now),
      up7: r.up7,
      down7: r.down7,
      up30: r.up30,
      down30: r.down30,
      revenue,
    });
  }
  return periods.length > 0 ? { ticker, readAt, periods } : null;
}

/**
 * The quarter a report on `reportDate` covers: the latest quarter period
 * ending on or before it. Null when the provider has already moved on past
 * it, or (no period dates) when the current quarter cannot be placed.
 */
export function reportPeriod(est: EstimateRevisions | null, reportDate: string): PeriodEstimates | null {
  if (!est) return null;
  const quarters = est.periods.filter((p) => p.period === "0q" || p.period === "+1q");
  const dated = quarters.filter((p) => p.periodEnd !== null && p.periodEnd <= reportDate).sort((a, b) => b.periodEnd!.localeCompare(a.periodEnd!));
  if (dated.length > 0) return dated[0]!;
  const current = quarters.find((p) => p.period === "0q");
  return current && current.periodEnd === null ? current : null;
}

export function isLopsided(up: number | null, down: number | null): boolean {
  const u = up ?? 0;
  const d = down ?? 0;
  const hi = Math.max(u, d);
  return hi >= LOPSIDED_MIN && hi >= LOPSIDED_RATIO * Math.min(u, d);
}

/** Whether the 30 day picture is worth a line on a list: a sizeable move, or revisions mostly one way. */
export function isNotable(p: PeriodEstimates): boolean {
  const c = p.change30;
  const moved = c !== null && (c.kind === "pct" ? Math.abs(c.value) >= NOTABLE_PCT : Math.abs(c.value) >= NOTABLE_AMOUNT - 1e-9);
  return moved || isLopsided(p.up30, p.down30);
}

/**
 * Until when a reading taken at `atMs` is reused: thirty minutes while the
 * regular session is open, and through to the next open otherwise.
 */
export function estimatesFreshUntil(atMs: number): number {
  const day = nyYmdOf(atMs);
  const s = sessionOf(day);
  if (s && atMs >= s.openMs && atMs < s.closeMs) return Math.min(atMs + OPEN_TTL_MS, s.closeMs + 60_000);
  if (s && atMs < s.openMs) return s.openMs;
  const next = sessionOf(nextSession(day));
  return next ? next.openMs : atMs + 12 * 3_600_000;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------
// The IPC contract
// ---------------------------------------------------------------------------

export type EstimatesResult =
  | { ok: true; estimates: Record<string, EstimateRevisions | null> }
  | { ok: false; error: "invalid_request" | "unavailable" };

const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;

/** The tickers of an estimates request, cleaned, de-duplicated and capped; null when it is not one. */
export function parseEstimatesRequest(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 500) return null;
  const out = new Set<string>();
  for (const item of raw) {
    const t = typeof item === "string" ? item.trim().toUpperCase() : "";
    if (TICKER.test(t)) out.add(t);
  }
  return [...out].slice(0, ESTIMATES_REQUEST_CAP);
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export type Say = (key: string, params?: Record<string, string | number>) => string;

function pctText(v: number, lang: string, signed: boolean): string {
  try {
    return new Intl.NumberFormat(lang, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: signed ? "exceptZero" : "never" }).format(signed ? v : Math.abs(v));
  } catch {
    const s = `${(Math.abs(v) * 100).toFixed(1)}%`;
    return signed && v !== 0 ? `${v > 0 ? "+" : "-"}${s}` : s;
  }
}

function amountText(v: number, currency: string | null, lang: string, signed: boolean): string {
  const value = signed ? v : Math.abs(v);
  try {
    return new Intl.NumberFormat(lang, {
      style: "currency",
      currency: currency ?? "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      signDisplay: signed ? "exceptZero" : "never",
    }).format(value);
  } catch {
    return `${signed && v > 0 ? "+" : ""}${value.toFixed(2)}`;
  }
}

function isFlat(c: EpsChange): boolean {
  return c.kind === "pct" ? Math.abs(c.value) < FLAT_PCT : Math.abs(c.value) < 0.005;
}

/** A change as a signed cell: "+9.4%", or an amount "+$0.06" for a tiny or crossed base. */
export function changeCell(c: EpsChange | null, currency: string | null, lang: string): string | null {
  if (!c) return null;
  if (isFlat(c)) return c.kind === "pct" ? pctText(0, lang, false) : amountText(0, currency, lang, false);
  return c.kind === "pct" ? pctText(c.value, lang, true) : amountText(c.value, currency, lang, true);
}

/** The size of a change for a sentence whose verb carries the direction: "9.4%", "6 cents". */
export function changeSize(c: EpsChange, currency: string | null, say: Say, lang: string): string {
  if (c.kind === "pct") return pctText(c.value, lang, false);
  if ((currency ?? "USD") === "USD") {
    const cents = Math.round(Math.abs(c.value) * 100);
    return say(cents === 1 ? "estimates.cents.one" : "estimates.cents.other", { count: cents });
  }
  return amountText(c.value, currency, lang, false);
}

/** The direction of a change: positive, negative or flat (the sign of a cell's colour). */
export function changeSign(c: EpsChange | null): number {
  if (!c || isFlat(c)) return 0;
  return c.value > 0 ? 1 : -1;
}

/**
 * The one line for the quarter being reported, over the last 30 days:
 * "EPS estimate for this report rose 9.4% over the last 30 days; 26 raised, 2 lowered."
 * Null without a 30 day reading.
 */
export function estimateLine(p: PeriodEstimates, say: Say, lang: string): string | null {
  const c = p.change30;
  if (!c) return null;
  const counted = p.up30 !== null && p.down30 !== null;
  const base = changeSign(c) > 0 ? "estimates.line.rose" : changeSign(c) < 0 ? "estimates.line.fell" : "estimates.line.flat";
  const key = counted ? base : `${base}.bare`;
  return say(key, { change: changeSize(c, p.currency, say, lang), up: p.up30 ?? 0, down: p.down30 ?? 0 });
}

function monthText(ymd: string, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${ymd}T12:00:00Z`));
  } catch {
    return ymd.slice(0, 7);
  }
}

/** The period as a label: "Quarter to Nov 2026", "Year to Aug 2027". */
export function periodLabel(p: PeriodEstimates, say: Say, lang: string): string {
  const year = p.period === "0y";
  if (!p.periodEnd) return say(year ? "estimates.period.thisYear" : p.period === "0q" ? "estimates.period.thisQuarter" : "estimates.period.nextQuarter");
  return say(year ? "estimates.period.year" : "estimates.period.quarter", { month: monthText(p.periodEnd, lang) });
}

/** The hover text: the mean now and 30 days ago, and how many analysts it is drawn from. */
export function estimateHint(p: PeriodEstimates, say: Say, lang: string): string {
  const now = formatEps(p.now, lang) ?? String(p.now);
  const lines = [say("estimates.hint.now", { now, count: p.analysts })];
  if (p.ago30 !== null) lines.push(say("estimates.hint.then", { then: formatEps(p.ago30, lang) ?? String(p.ago30) }));
  if (p.currency && p.currency !== "USD") lines.push(say("estimates.hint.currency", { currency: p.currency }));
  return lines.join("\n");
}
