/**
 * Event-study measurement (design docs/design/ripple-engine-v1.md 6.1, M1 a10 / b3).
 *
 * Replaces the v0 reading (`history.ts windowMove`: stock minus SPY, i.e. an
 * implied beta of 1, from the close before the reaction day, which nobody
 * could trade) with:
 *
 *   - Anchor. Entry t0 = the first regular-session open strictly after the
 *     event's public time plus a latency (default 0: the next open after
 *     EDGAR acceptance). Sessions follow the NYSE calendar (weekends,
 *     holidays, early closes).
 *   - Market model. r_it = a + b r_SPY,t + e over sessions [-260, -11]
 *     relative to day 0 (the first session whose close is after the public
 *     time), at least 120 valid days, else unmeasured. sigma = sd(e).
 *   - Legs. PRE = last close before the public time -> t0 open (already
 *     happened at entry). DRIFT_L = t0 open -> close of session t0 + L - 1
 *     (L sessions held; the first one open to close), L in {5, 20, 60}.
 *   - CAR = sum of abnormal returns over the leg; SCAR = CAR / (sigma sqrt L).
 *
 * Prices are split and dividend adjusted (total return); opens carry the same
 * adjustment factor as the close of their day. Missing values are NaN.
 *
 * Pure: no fs, no network, no clock.
 */

import { nyOffsetMs } from "../edgar-time.ts";
import { clusteredMeanTest, median, twoWayMeanTest, wildClusterBootstrapP, type MeanTest } from "./stats.ts";

// ---------------------------------------------------------------------------
// NYSE calendar

const DAY_MS = 86_400_000;

function ymdOf(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

function dow(ymd: string): number {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay();
}

export function addDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The n-th (1-based) weekday `wd` (0 = Sunday) of a month; n = -1 for the last. */
function nthWeekday(y: number, m: number, wd: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return ymdOf(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = new Date(Date.UTC(y, m - 1, lastDay)).getUTCDay();
  return ymdOf(y, m, lastDay - ((last - wd + 7) % 7));
}

/** Gregorian Easter Sunday (anonymous algorithm). */
export function easterSunday(y: number): string {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymdOf(y, month, day);
}

/** Unscheduled full-day closures (national mourning, weather, 9/11). */
const SPECIAL_CLOSURES = new Set([
  "2001-09-11", "2001-09-12", "2001-09-13", "2001-09-14",
  "2004-06-11", "2007-01-02", "2012-10-29", "2012-10-30", "2018-12-05", "2025-01-09",
]);

/** Observed fixed-date holiday: Saturday -> Friday, Sunday -> Monday. */
function observed(ymd: string): string {
  const w = dow(ymd);
  return w === 6 ? addDays(ymd, -1) : w === 0 ? addDays(ymd, 1) : ymd;
}

const holidayCache = new Map<number, Set<string>>();

/** NYSE full-day holidays of a year (rules in force since 1998, Juneteenth since 2022). */
export function nyseHolidays(y: number): Set<string> {
  const hit = holidayCache.get(y);
  if (hit) return hit;
  const out = new Set<string>();
  // New Year's Day: a Saturday New Year is not observed on the Friday before (NYSE rule 7.2).
  const ny = ymdOf(y, 1, 1);
  if (dow(ny) !== 6) out.add(observed(ny));
  out.add(nthWeekday(y, 1, 1, 3)); // Martin Luther King Jr. Day
  out.add(nthWeekday(y, 2, 1, 3)); // Washington's Birthday
  out.add(addDays(easterSunday(y), -2)); // Good Friday
  out.add(nthWeekday(y, 5, 1, -1)); // Memorial Day
  if (y >= 2022) out.add(observed(ymdOf(y, 6, 19))); // Juneteenth
  out.add(observed(ymdOf(y, 7, 4)));
  out.add(nthWeekday(y, 9, 1, 1)); // Labor Day
  out.add(nthWeekday(y, 11, 4, 4)); // Thanksgiving
  out.add(observed(ymdOf(y, 12, 25)));
  for (const d of SPECIAL_CLOSURES) if (d.startsWith(`${y}-`)) out.add(d);
  holidayCache.set(y, out);
  return out;
}

/** Whether the NYSE holds a regular session on a New York date. */
export function isNyseSession(ymd: string): boolean {
  const w = dow(ymd);
  if (w === 0 || w === 6) return false;
  return !nyseHolidays(Number(ymd.slice(0, 4))).has(ymd);
}

/** 13:00 closes: July 3, the day after Thanksgiving and December 24, when they are sessions. */
export function isNyseEarlyClose(ymd: string): boolean {
  if (!isNyseSession(ymd)) return false;
  const y = Number(ymd.slice(0, 4));
  return ymd === ymdOf(y, 7, 3) || ymd === ymdOf(y, 12, 24) || ymd === addDays(nthWeekday(y, 11, 4, 4), 1);
}

/** NYSE sessions in [from, to], oldest first. */
export function nyseSessions(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (isNyseSession(d)) out.push(d);
  return out;
}

/** The instant of a New York wall-clock time (minutes after midnight) on a date. */
export function nyInstantMs(ymd: string, minutes: number): number {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  // Offset at the guessed instant (wall + 5h); DST changes at 02:00, never near the session.
  return wall - nyOffsetMs(wall + 5 * 3_600_000);
}

export const OPEN_MIN = 9 * 60 + 30;
export const CLOSE_MIN = 16 * 60;
export const EARLY_CLOSE_MIN = 13 * 60;

export function sessionOpenMs(ymd: string): number {
  return nyInstantMs(ymd, OPEN_MIN);
}

export function sessionCloseMs(ymd: string): number {
  return nyInstantMs(ymd, isNyseEarlyClose(ymd) ? EARLY_CLOSE_MIN : CLOSE_MIN);
}

/** First index i with key(i) > ms (binary search over an increasing key). */
function firstAfter(n: number, key: (i: number) => number, ms: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(mid) > ms) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Index in `sessions` of the entry session: the first regular-session open
 * strictly after `publicMs + latencyMs`. Null when the calendar ends first.
 */
export function entryIndex(sessions: readonly string[], publicMs: number, latencyMs = 0): number | null {
  const i = firstAfter(sessions.length, (k) => sessionOpenMs(sessions[k]!), publicMs + latencyMs);
  return i < sessions.length ? i : null;
}

/** Index of the last session whose close is at or before `ms`. Null when none. */
export function lastCloseIndex(sessions: readonly string[], ms: number): number | null {
  const i = firstAfter(sessions.length, (k) => sessionCloseMs(sessions[k]!), ms) - 1;
  return i >= 0 ? i : null;
}

/** Day 0: the first session whose close comes after the public time (the reaction day). */
export function reactionDayIndex(sessions: readonly string[], publicMs: number): number | null {
  const i = firstAfter(sessions.length, (k) => sessionCloseMs(sessions[k]!), publicMs);
  return i < sessions.length ? i : null;
}

// ---------------------------------------------------------------------------
// Market model

export type PriceSeries = { open: ArrayLike<number>; close: ArrayLike<number> };

export type MarketModel = { alpha: number; beta: number; sigma: number; n: number };

export const ESTIMATION = { from: -260, to: -11, minDays: 120 } as const;

/** Close-to-close simple return into session i (NaN when either close is missing). */
export function closeReturn(p: PriceSeries, i: number): number {
  if (i < 1) return NaN;
  const a = p.close[i - 1]!;
  const b = p.close[i]!;
  return a > 0 && b > 0 ? b / a - 1 : NaN;
}

/**
 * OLS of stock on market close-to-close returns over sessions [lo, hi]
 * (inclusive). Null with fewer than `minDays` days where both are known, or a
 * flat market.
 */
export function fitMarketModel(stock: PriceSeries, market: PriceSeries, lo: number, hi: number, minDays: number = ESTIMATION.minDays): MarketModel | null {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = Math.max(1, lo); i <= hi; i++) {
    const y = closeReturn(stock, i);
    const x = closeReturn(market, i);
    if (!Number.isFinite(y) || !Number.isFinite(x)) continue;
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
  }
  if (n < minDays) return null;
  const vx = sxx - (sx * sx) / n;
  if (!(vx > 0)) return null;
  const beta = (sxy - (sx * sy) / n) / vx;
  const alpha = (sy - beta * sx) / n;
  // Residual sum of squares from the moments: Syy - b Sxy (centered).
  const ssr = Math.max(0, syy - (sy * sy) / n - beta * (sxy - (sx * sy) / n));
  // Floored so a series measured against itself (SPY on SPY) stays defined.
  const sigma = Math.max(Math.sqrt(ssr / (n - 2)), 1e-10);
  return { alpha, beta, sigma, n };
}

// ---------------------------------------------------------------------------
// One event

export type PreLeg = {
  /** Abnormal return, last close before the public time -> entry open. */
  ar: number;
  raw: number;
  market: number;
  /** Sessions spanned (1 = one overnight gap). */
  sessions: number;
};

export type DriftLeg = {
  L: number;
  exitIndex: number;
  exitDate: string;
  /** Sum of market-model abnormal returns (fraction, not %). */
  car: number;
  /** car / (sigma sqrt L). */
  scar: number;
  /** Buy-and-hold stock return, entry open -> exit close. */
  raw: number;
  /** Buy-and-hold market return over the same span. */
  market: number;
  /** v0's reading on the same span: raw minus market (beta 1). */
  rawMinusMarket: number;
};

export type EventMeasure = {
  day0: number;
  entry: number;
  entryDate: string;
  model: MarketModel;
  pre: PreLeg | null;
  drift: Record<number, DriftLeg | null>;
  /** Why a window is null: past the end of the data or a missing price. */
  driftMissing: Record<number, "after_data" | "missing_price" | null>;
};

export type MeasureInput = {
  /** Trading sessions (YYYY-MM-DD, oldest first) all series are aligned to. */
  sessions: readonly string[];
  stock: PriceSeries;
  market: PriceSeries;
  /** When the event became public (epoch ms), e.g. EDGAR acceptance. */
  publicMs: number;
  latencyMs?: number;
  windows?: readonly number[];
};

export const WINDOWS = [5, 20, 60] as const;

export type MeasureFailure = { ok: false; reason: "no_session" | "no_estimation" | "no_entry_price" };

/** Market-model legs of one event. */
export function measureEvent(input: MeasureInput): ({ ok: true } & EventMeasure) | MeasureFailure {
  const { sessions, stock, market, publicMs } = input;
  const windows = input.windows ?? WINDOWS;
  const day0 = reactionDayIndex(sessions, publicMs);
  const entry = entryIndex(sessions, publicMs, input.latencyMs ?? 0);
  if (day0 === null || entry === null) return { ok: false, reason: "no_session" };
  const model = fitMarketModel(stock, market, day0 + ESTIMATION.from, day0 + ESTIMATION.to);
  if (!model) return { ok: false, reason: "no_estimation" };
  const o = stock.open[entry]!;
  const mo = market.open[entry]!;
  if (!(o > 0) || !(mo > 0)) return { ok: false, reason: "no_entry_price" };
  const { alpha, beta, sigma } = model;

  let pre: PreLeg | null = null;
  const lc = lastCloseIndex(sessions, publicMs);
  if (lc !== null && lc < entry) {
    const c = stock.close[lc]!;
    const mc = market.close[lc]!;
    if (c > 0 && mc > 0) {
      const raw = o / c - 1;
      const m = mo / mc - 1;
      const k = entry - lc;
      pre = { ar: raw - alpha * k - beta * m, raw, market: m, sessions: k };
    }
  }

  const drift: Record<number, DriftLeg | null> = {};
  const driftMissing: Record<number, "after_data" | "missing_price" | null> = {};
  for (const L of windows) {
    const exit = entry + L - 1;
    drift[L] = null;
    if (exit >= sessions.length) {
      driftMissing[L] = "after_data";
      continue;
    }
    let car = 0;
    let ok = true;
    for (let i = entry; i <= exit; i++) {
      const r = i === entry ? stock.close[i]! / o - 1 : closeReturn(stock, i);
      const rm = i === entry ? market.close[i]! / mo - 1 : closeReturn(market, i);
      if (!Number.isFinite(r) || !Number.isFinite(rm)) {
        ok = false;
        break;
      }
      car += r - alpha - beta * rm;
    }
    if (!ok) {
      // A missing close at the end of the series is the data ending, not a gap.
      let last = exit;
      while (last > entry && !(stock.close[last]! > 0)) last--;
      driftMissing[L] = last < exit ? "after_data" : "missing_price";
      continue;
    }
    const raw = stock.close[exit]! / o - 1;
    const m = market.close[exit]! / mo - 1;
    drift[L] = { L, exitIndex: exit, exitDate: sessions[exit]!, car, scar: car / (sigma * Math.sqrt(L)), raw, market: m, rawMinusMarket: raw - m };
    driftMissing[L] = null;
  }
  return { ok: true, day0, entry, entryDate: sessions[entry]!, model, pre, drift, driftMissing };
}

// ---------------------------------------------------------------------------
// Many events

export type StudyObservation = {
  /** The outcome (e.g. CAR in %, SCAR, or matched-control y). */
  value: number;
  /** Event date (clusters events that share a date). */
  date: string;
  /** Ticker or issuer id (first dimension of the two-way clustering). */
  firm: string;
};

export type StudySummary = {
  n: number;
  /** Independent event dates. */
  g: number;
  mean: number;
  median: number;
  /** Share of observations above zero. */
  positive: number;
  /** Clustered by event date, df = G - 1. */
  byDate: MeanTest;
  /** Two-way, firm x calendar month (Cameron-Gelbach-Miller), df = min(G) - 1. */
  twoWay: MeanTest & { firms: number; months: number };
  /** Wild-cluster bootstrap p (date clusters) when G < 30, else null. */
  bootstrapP: number | null;
};

/** Mean, median and clustered tests of an outcome over events. Null for an empty sample. */
export function eventStudy(obs: readonly StudyObservation[]): StudySummary | null {
  const xs = obs.filter((o) => Number.isFinite(o.value));
  if (!xs.length) return null;
  const ys = xs.map((o) => o.value);
  const dates = xs.map((o) => o.date);
  const firms = xs.map((o) => o.firm);
  const months = xs.map((o) => o.date.slice(0, 7));
  const byDate = clusteredMeanTest(ys, dates);
  const tw = twoWayMeanTest(ys, firms, months);
  return {
    n: xs.length,
    g: byDate.clusters,
    mean: byDate.mean,
    median: median(ys),
    positive: ys.filter((y) => y > 0).length / ys.length,
    byDate: { mean: byDate.mean, se: byDate.se, t: byDate.t, df: byDate.df, p: byDate.p },
    twoWay: { mean: tw.mean, se: tw.se, t: tw.t, df: tw.df, p: tw.p, firms: tw.clustersA, months: tw.clustersB },
    bootstrapP: byDate.clusters < 30 ? wildClusterBootstrapP(ys, dates) : null,
  };
}
