import { STOCK_LIKE, contractSize, quoteSymbol, type PortfolioAccount, type PortfolioPosition, type PositionKind } from "../portfolio-holdings";
import { addDays, isNyseEarlyClose, isNyseSession, nyInstantMs } from "../../../../packages/engine/src/study/abnormal.ts";
import { CLOSE_MIN, EARLY_CLOSE_MIN, OPEN_MIN, nyDate } from "./market-status";

/**
 * Pure: the Equity card's curve (tabs/EquityCard.tsx) from the member's real
 * history. Falcon records a snapshot of the holdings every time they change
 * (an import, a paper account, Clear portfolio, a pruned ticker list:
 * lib/portfolio-store.ts, table public.portfolio_holdings_history), and the
 * curve is rebuilt from those snapshots x market prices:
 *
 *   value(t)   cash of the snapshot in force at t + each of its positions x
 *              multiplier x the price at t (the last bar at or before t)
 *   start      the first snapshot (the moment the member connected: the
 *              account's first day). Nothing is drawn before it, neither the
 *              curve nor SPY: a timeframe that begins earlier starts there
 *              and says so ("Since Nov 18", historyStart, rangeCoverage)
 *   steps      at a snapshot's time the holdings change, so the curve steps
 *   held       options, futures and others are held at the price recorded in
 *              the snapshot (the import's) until a newer snapshot: no
 *              reliable free history for contracts
 *   timeline   the exchange-traded symbols' bars (crypto's 24/7 bars only when
 *              nothing else is priced), plus the snapshot times
 *   now        the live total closes the curve (finishCurve), so it ends at the
 *              Positions card's figure
 */

export type EquityRange = "1D" | "1W" | "1M" | "3M" | "YTD" | "1Y" | "5Y";
/** The timeframes; 5Y is the longest history fetched. */
export const EQUITY_RANGES: readonly EquityRange[] = ["1D", "1W", "1M", "3M", "YTD", "1Y", "5Y"];
export const DEFAULT_RANGE: EquityRange = "1M";

/** One symbol's closes, oldest first: epoch ms and prices of the same length; `prev` is the close before the range (1D: yesterday's). */
export type PriceSeries = { t: number[]; c: number[]; prev?: number };

/* ------------------------------------------------------------------ snapshots */

export type SnapshotSource = "broker" | "screenshot" | "csv" | "paper" | "clear" | "prune" | "initial";

/** One position as a snapshot keeps it: what was held, never what it cost. */
export type SnapshotPosition = {
  account_id: string;
  kind: PositionKind;
  symbol: string;
  ticker: string | null;
  quantity: number;
  multiplier: number;
  currency: string;
  /** The price at the snapshot (the import's), for positions without a price history here (options, futures, others). */
  price: number | null;
};

export type SnapshotCash = { account_id: string; currency: string; cash: number };

/** The full holdings from a moment on, until the next snapshot. */
export type HoldingsSnapshot = { at: number; source: SnapshotSource; positions: SnapshotPosition[]; cash: SnapshotCash[] };

/** Pure: the holdings as a snapshot keeps them (positions with a quantity; balances with cash), in a stable order. */
export function snapshotOf(accounts: readonly PortfolioAccount[], positions: readonly PortfolioPosition[]): Pick<HoldingsSnapshot, "positions" | "cash"> {
  const accountCurrency = new Map(accounts.map((a) => [a.id, a.currency]));
  const ps: SnapshotPosition[] = positions
    .filter((p) => p.quantity !== null && Number.isFinite(p.quantity) && p.quantity !== 0)
    .map((p) => {
      const size = contractSize(p);
      const price = p.price ?? (p.marketValue !== null && p.quantity ? p.marketValue / (p.quantity * size) : null);
      return {
        account_id: p.accountId,
        kind: p.kind,
        symbol: p.symbol,
        ticker: p.ticker,
        quantity: p.quantity!,
        multiplier: size,
        currency: p.currency ?? accountCurrency.get(p.accountId) ?? "USD",
        price: price !== null && Number.isFinite(price) ? price : null,
      };
    })
    .sort((a, b) => a.account_id.localeCompare(b.account_id) || a.kind.localeCompare(b.kind) || a.symbol.localeCompare(b.symbol));
  const cash: SnapshotCash[] = accounts
    .filter((a) => a.cash !== null && Number.isFinite(a.cash))
    .map((a) => ({ account_id: a.id, currency: a.currency ?? "USD", cash: a.cash! }))
    .sort((a, b) => a.account_id.localeCompare(b.account_id) || a.currency.localeCompare(b.currency));
  return { positions: ps, cash };
}

/** Pure: whether two snapshots hold the same things (prices left out: a new import price alone is no change). */
export function sameHoldings(a: Pick<HoldingsSnapshot, "positions" | "cash">, b: Pick<HoldingsSnapshot, "positions" | "cash">): boolean {
  const key = (s: Pick<HoldingsSnapshot, "positions" | "cash">) =>
    JSON.stringify([s.positions.map((p) => [p.account_id, p.kind, p.symbol, p.quantity, p.multiplier, p.currency]), s.cash.map((c) => [c.account_id, c.currency, c.cash])]);
  return key(a) === key(b);
}

/** Pure: the symbol a snapshot position's price series is looked up by; null when it is held at its recorded price. */
export function seriesSymbol(p: Pick<SnapshotPosition, "kind" | "symbol" | "ticker" | "currency">): string | null {
  if (!STOCK_LIKE.has(p.kind) && p.kind !== "crypto") return null;
  return quoteSymbol({ kind: p.kind, symbol: p.symbol, ticker: p.ticker, currency: p.currency });
}

/** Pure: the snapshots that matter from `from` on: the last one in force at `from`, then every later one up to `nowMs`. */
export function snapshotsInRange(snapshots: readonly HoldingsSnapshot[], from: number, nowMs: number): HoldingsSnapshot[] {
  const sorted = [...snapshots].filter((s) => s.at <= nowMs).sort((a, b) => a.at - b.at);
  let first = 0;
  for (let i = 0; i < sorted.length; i++) if (sorted[i]!.at <= from) first = i;
  return sorted.slice(first);
}

/* ------------------------------------------------------------------ the curve */

export type EquityPoint = {
  t: number;
  v: number;
  /** SPY, raw until finishCurve scales it to the first value. */
  spy: number | null;
};

export type EquityCurve = {
  points: EquityPoint[];
  start: number | null;
  end: number | null;
  change: number | null;
  pct: number | null;
  /** SPY's move over the same points, percent; null without SPY. */
  spyPct: number | null;
  /** When the member's history begins (the first snapshot); null without one. */
  firstAt: number | null;
};

/** The last close at or before `t` (series oldest first), or null before the first. */
function closeAt(s: PriceSeries, t: number, from: { i: number }): number | null {
  if (from.i > 0 && s.t[from.i]! > t) from.i = 0;
  while (from.i + 1 < s.t.length && s.t[from.i + 1]! <= t) from.i++;
  return s.t[from.i]! <= t ? s.c[from.i]! : null;
}

const usable = (s: PriceSeries | null | undefined): s is PriceSeries => !!s && s.t.length > 0 && s.t.length === s.c.length;

/**
 * Pure: the curve's points from `from` (the timeframe's start; for 1D the
 * session's) to `nowMs`, never before the first snapshot. Values in
 * `currency` only (other currencies are left out, as in the total). With
 * `fromPrevious` (1D), when the holdings were already in force before the
 * session, the first point is yesterday's close, so the day's change matches
 * the Positions card's "today". The live end point is finishCurve's.
 */
export function snapshotPoints({
  snapshots,
  series,
  from,
  nowMs,
  currency,
  spy = null,
  fromPrevious = false,
}: {
  snapshots: readonly HoldingsSnapshot[];
  series: Readonly<Record<string, PriceSeries>>;
  from: number;
  nowMs: number;
  currency: string;
  spy?: PriceSeries | null;
  fromPrevious?: boolean;
}): { points: EquityPoint[]; firstAt: number | null } {
  const all = [...snapshots].sort((a, b) => a.at - b.at);
  if (!all.length) return { points: [], firstAt: null };
  const firstAt = all[0]!.at;
  const start = Math.max(from, firstAt);
  if (start > nowMs) return { points: [], firstAt };
  const inRange = snapshotsInRange(all, start, nowMs);

  const held = (s: HoldingsSnapshot) => s.positions.filter((p) => p.currency === currency);
  const priced = new Set<string>();
  const sessions = new Set<string>();
  for (const s of inRange)
    for (const p of held(s)) {
      const sym = seriesSymbol(p);
      if (!sym || !usable(series[sym])) continue;
      priced.add(sym);
      if (p.kind !== "crypto") sessions.add(sym);
    }
  const clock = (sessions.size ? [...sessions] : [...priced]).map((s) => series[s]!);
  if (!clock.length && usable(spy)) clock.push(spy);

  const times = new Set<number>([start]);
  for (const s of clock) for (const t of s.t) if (t > start && t <= nowMs) times.add(t);
  // A snapshot inside the range: the old holdings just before it, the new ones from it, so the curve steps.
  for (const s of inRange)
    if (s.at > start) {
      times.add(s.at - 1);
      times.add(s.at);
    }
  const timeline = [...times].sort((a, b) => a - b);

  const cursors = new Map<string, { i: number }>();
  const cur = (sym: string) => cursors.get(sym) ?? (cursors.set(sym, { i: 0 }), cursors.get(sym)!);
  const spyCursor = { i: 0 };
  const valueAt = (s: HoldingsSnapshot, t: number, usePrev: boolean) => {
    let v = s.cash.filter((c) => c.currency === currency).reduce((sum, c) => sum + c.cash, 0);
    for (const p of held(s)) {
      const sym = seriesSymbol(p);
      const ser = sym ? series[sym] : undefined;
      let price: number | null = null;
      if (usable(ser)) price = usePrev && typeof ser.prev === "number" ? ser.prev : closeAt(ser, t, cur(sym!)) ?? p.price ?? ser.c[0]!;
      else price = p.price;
      if (price !== null) v += p.quantity * p.multiplier * price;
    }
    return v;
  };

  let k = 0;
  const points: EquityPoint[] = [];
  const inForce = (t: number) => {
    while (k + 1 < inRange.length && inRange[k + 1]!.at <= t) k++;
    return inRange[k]!;
  };
  if (fromPrevious && inRange[0]!.at < start) {
    const s = inRange[0]!;
    const syms = held(s).map(seriesSymbol).filter((x): x is string => x !== null && usable(series[x]));
    if (syms.length && syms.every((x) => typeof series[x]!.prev === "number")) points.push({ t: start - 1, v: valueAt(s, start, true), spy: usable(spy) && typeof spy.prev === "number" ? spy.prev : null });
  }
  for (const t of timeline) points.push({ t, v: valueAt(inForce(t), t, false), spy: usable(spy) ? closeAt(spy, t, spyCursor) : null });
  return { points, firstAt };
}

/**
 * Pure: the curve closed with the live total at `nowMs` (the Positions
 * card's figure), never before the account's first day: points before
 * `firstAt` are dropped (a server or cache that still sends a lead-in draws
 * nothing there). The change counts from the first point; SPY is rebased to
 * the curve's value there, so both start together on the account's first day.
 */
export function finishCurve(points: readonly EquityPoint[], total: number, nowMs: number, firstAt: number | null): EquityCurve {
  const out = points.filter((p) => firstAt === null || p.t >= firstAt).map((p) => ({ ...p }));
  if (!out.length) return { points: [], start: null, end: null, change: null, pct: null, spyPct: null, firstAt };
  const lastSpy = [...out].reverse().find((p) => p.spy !== null)?.spy ?? null;
  if (nowMs > out[out.length - 1]!.t) out.push({ t: nowMs, v: total, spy: lastSpy });
  else out[out.length - 1]!.v = total;
  const v0 = out[0]!.v;
  // SPY's anchor: its value at the first point (else the nearest one after it).
  const anchor = out.find((p) => p.spy !== null)?.spy ?? null;
  for (const p of out) p.spy = anchor && p.spy !== null ? (v0 * p.spy) / anchor : null;
  const end = out[out.length - 1]!.v;
  const change = end - v0;
  const spyEnd = [...out].reverse().find((p) => p.spy !== null)?.spy ?? null;
  return {
    points: out,
    start: v0,
    end,
    change,
    pct: v0 ? (change / Math.abs(v0)) * 100 : 0,
    spyPct: spyEnd !== null && anchor && v0 ? ((spyEnd - v0) / Math.abs(v0)) * 100 : null,
    firstAt,
  };
}

/* ------------------------------------------------------------------ resolution */

export type BarInterval = "5m" | "15m" | "30m" | "60m" | "1d";

/** Bars per trading day (6.5 hours), and the longest span Yahoo serves them for. */
const BARS: { interval: BarInterval; perDay: number; maxDays: number }[] = [
  { interval: "5m", perDay: 78, maxDays: 59 },
  { interval: "15m", perDay: 26, maxDays: 59 },
  { interval: "30m", perDay: 13, maxDays: 59 },
  { interval: "60m", perDay: 7, maxDays: 729 },
  { interval: "1d", perDay: 1, maxDays: Infinity },
];

/** Bars the real part should come to at most: dense enough to look like trading, sparse enough not to look like noise. */
export const TARGET_POINTS = 250;

/** Pure: the finest bar size that keeps a span of real history under TARGET_POINTS (trading days are 5 of 7). */
export function chooseInterval(spanMs: number): BarInterval {
  const days = Math.max(spanMs, 0) / DAY_MS;
  const tradingDays = Math.max(1, (days * 5) / 7);
  return (BARS.find((b) => days <= b.maxDays && tradingDays * b.perDay <= TARGET_POINTS) ?? BARS[BARS.length - 1]!).interval;
}

/**
 * Pure: at most about `max` points, keeping each bucket's lowest and highest
 * value (`value`: the curve's, or SPY's for the flat lead-in) in time order,
 * so spikes survive and noise thins, plus the first and last points;
 * untouched when already small enough.
 */
export function downsample(points: readonly EquityPoint[], max: number, value: (p: EquityPoint) => number = (p) => p.v): EquityPoint[] {
  if (points.length <= max || max < 4) return [...points];
  const buckets = Math.max(1, Math.floor((max - 2) / 2));
  const size = (points.length - 2) / buckets;
  const out: EquityPoint[] = [points[0]!];
  for (let b = 0; b < buckets; b++) {
    const lo = 1 + Math.floor(b * size);
    const hi = Math.min(points.length - 1, 1 + Math.floor((b + 1) * size));
    if (hi <= lo) continue;
    let iMin = lo;
    let iMax = lo;
    for (let i = lo; i < hi; i++) {
      if (value(points[i]!) < value(points[iMin]!)) iMin = i;
      if (value(points[i]!) > value(points[iMax]!)) iMax = i;
    }
    for (const i of iMin === iMax ? [iMin] : [Math.min(iMin, iMax), Math.max(iMin, iMax)]) out.push(points[i]!);
  }
  out.push(points[points.length - 1]!);
  return out;
}

/* ------------------------------------------------------------------ timeframes and axes */

const DAY_MS = 86_400_000;

/** Pure: where a timeframe nominally starts before `nowMs` (YTD: January 1st); null for 1D (the session's start comes from the bars). */
export function nominalStart(range: EquityRange, nowMs: number): number | null {
  const d = new Date(nowMs);
  if (range === "1D") return null;
  if (range === "1W") return nowMs - 7 * DAY_MS;
  if (range === "YTD") return new Date(d.getFullYear(), 0, 1).getTime();
  const months = { "1M": 1, "3M": 3, "1Y": 12, "5Y": 60 }[range];
  const s = new Date(d);
  s.setMonth(s.getMonth() - months);
  return s.getTime();
}

/** Pure: the first snapshot's time when it cuts the timeframe short ("Since Nov 17"); null when the history covers it. */
export function historyStart(range: EquityRange, firstAt: number | null, from: number | null): number | null {
  if (firstAt === null || from === null) return null;
  return firstAt > from ? firstAt : null;
}

/** Pure: 3 to 5 round values spanning [min, max] for the value axis. */
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const raw = (max - min) / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/**
 * Pure: what each timeframe shows for an account first seen at `firstAt`:
 * "full" when it starts after the account's first day; "since" for the
 * shortest one that starts before it (drawn from the first day, labelled
 * "Since Nov 18"); "same" for the longer ones, which would draw exactly
 * that again (the card disables them unless one is already selected).
 * 1D is always "full": its start is the session's, known from the bars.
 */
export type RangeCoverage = "full" | "since" | "same";
export function rangeCoverage(firstAt: number | null, nowMs: number): Record<EquityRange, RangeCoverage> {
  const out = {} as Record<EquityRange, RangeCoverage>;
  let covered = false;
  for (const r of EQUITY_RANGES) {
    const from = nominalStart(r, nowMs);
    if (from === null || firstAt === null || from >= firstAt) out[r] = "full";
    else {
      out[r] = covered ? "same" : "since";
      covered = true;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the time axis */

/**
 * The chart's x axis is time, never a point's index, so 18 days are 18 times
 * as wide as one.
 *
 *   calendar   1M and longer (daily bars): wall-clock time. A weekend is two
 *              days wide; a stretch without data is as wide as it lasted and
 *              drawn as one straight segment.
 *   trading    1D and 1W (intraday bars): NYSE regular-session time, as
 *              trading charts draw it. Session minutes keep their width; each
 *              closed stretch (a night, a weekend, a holiday) shrinks to at
 *              most CLOSED_MS, so a week is five sessions side by side
 *              instead of mostly nights. Points inside a closed stretch (a
 *              snapshot at 8 PM, the live total on a Saturday) keep their
 *              order inside it. A curve mostly priced outside the session
 *              (crypto only, 24/7) stays on calendar time.
 */
export type TimeScaleKind = "trading" | "calendar";
export type TimeScale = {
  kind: TimeScaleKind;
  t0: number;
  t1: number;
  /** Time to a fraction of the width, 0 at t0 and 1 at t1 (clamped). */
  at(t: number): number;
  /** A fraction of the width back to time. */
  invert(f: number): number;
};

/** The width a closed stretch keeps on the trading scale: half an hour of session. */
export const CLOSED_MS = 30 * 60_000;
const HOUR_MS = 3_600_000;

/** Pure: the NYSE regular sessions that overlap [t0, t1], oldest first, with their New York date. */
export function sessionsBetween(t0: number, t1: number): { day: string; open: number; close: number }[] {
  const out: { day: string; open: number; close: number }[] = [];
  if (!(t1 >= t0)) return out;
  const last = nyDate(t1);
  for (let d = addDays(nyDate(t0), -1), n = 0; d <= last && n < 4000; d = addDays(d, 1), n++) {
    if (!isNyseSession(d)) continue;
    const open = nyInstantMs(d, OPEN_MIN);
    const close = nyInstantMs(d, isNyseEarlyClose(d) ? EARLY_CLOSE_MIN : CLOSE_MIN);
    if (close >= t0 && open <= t1) out.push({ day: d, open, close });
  }
  return out;
}

/** A piecewise-linear scale through knots (times ascending, units ascending). */
function knotScale(kind: TimeScaleKind, ts: number[], us: number[]): TimeScale {
  const t0 = ts[0]!;
  const t1 = ts[ts.length - 1]!;
  const total = us[us.length - 1]! || 1;
  const seg = (arr: number[], v: number) => {
    let lo = 0;
    let hi = arr.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid]! <= v) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  return {
    kind,
    t0,
    t1,
    at(t) {
      if (t <= t0) return 0;
      if (t >= t1) return 1;
      const i = seg(ts, t);
      const span = ts[i + 1]! - ts[i]!;
      return (us[i]! + (span ? ((t - ts[i]!) / span) * (us[i + 1]! - us[i]!) : 0)) / total;
    },
    invert(f) {
      const u = Math.min(1, Math.max(0, f)) * total;
      const i = seg(us, u);
      const span = us[i + 1]! - us[i]!;
      return ts[i]! + (span ? ((u - us[i]!) / span) * (ts[i + 1]! - ts[i]!) : 0);
    },
  };
}

/** Whether a time falls inside a regular session (the close included: bars are stamped at their start, the live total may sit on the bell). */
function inSession(sessions: readonly { open: number; close: number }[], t: number): boolean {
  return sessions.some((s) => t >= s.open && t <= s.close);
}

/**
 * Pure: the x scale for a timeframe's points (their times, ascending): trading
 * time for 1D and 1W when at least 60% of the points fall inside a session,
 * else calendar time (see TimeScale).
 */
export function timeScale(range: EquityRange, times: readonly number[]): TimeScale {
  const t0 = times[0] ?? 0;
  const t1 = Math.max(t0, times[times.length - 1] ?? t0);
  if (t1 === t0) return knotScale("calendar", [t0, t0 + 1], [0, 1]);
  const calendar = () => knotScale("calendar", [t0, t1], [0, t1 - t0]);
  if (range !== "1D" && range !== "1W") return calendar();
  const sessions = sessionsBetween(t0, t1);
  const inside = times.filter((t) => inSession(sessions, t)).length;
  if (!sessions.length || inside < times.length * 0.6) return calendar();
  const cuts = new Set<number>([t0, t1]);
  for (const s of sessions) for (const b of [s.open, s.close]) if (b > t0 && b < t1) cuts.add(b);
  const ts = [...cuts].sort((a, b) => a - b);
  const us = [0];
  for (let i = 1; i < ts.length; i++) {
    const a = ts[i - 1]!;
    const b = ts[i]!;
    us.push(us[i - 1]! + (inSession(sessions, (a + b) / 2) ? b - a : Math.min(b - a, CLOSED_MS)));
  }
  return knotScale("trading", ts, us);
}

export type TimeTick = { t: number; label: string };

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (d: Date) => `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
const hourLabel = (d: Date) => `${d.getHours() % 12 || 12} ${d.getHours() < 12 ? "AM" : "PM"}`;

/** Every local midnight in [t0, t1]. */
function midnights(t0: number, t1: number): Date[] {
  const out: Date[] = [];
  const d = new Date(t0);
  d.setHours(0, 0, 0, 0);
  if (d.getTime() < t0) d.setDate(d.getDate() + 1);
  for (let n = 0; d.getTime() <= t1 && n < 4000; n++, d.setDate(d.getDate() + 1)) out.push(new Date(d));
  return out;
}

/** Every first of a month (local midnight) in [t0, t1]. */
function monthStarts(t0: number, t1: number): Date[] {
  const out: Date[] = [];
  const d = new Date(t0);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  if (d.getTime() < t0) d.setMonth(d.getMonth() + 1);
  for (let n = 0; d.getTime() <= t1 && n < 1200; n++, d.setMonth(d.getMonth() + 1)) out.push(new Date(d));
  return out;
}

/** Whole local hours in [t0, t1] (spans up to 4 days) at every k hours, for k = 1, 2, 3, 6, 12. */
function hourTicks(t0: number, t1: number, keep: (t: number) => boolean): TimeTick[][] {
  return [1, 2, 3, 6, 12].map((k) => {
    const out: TimeTick[] = [];
    if (t1 - t0 > 4 * 86_400_000) return out;
    const d = new Date(t0);
    d.setMinutes(0, 0, 0);
    if (d.getTime() < t0) d.setTime(d.getTime() + HOUR_MS);
    for (; d.getTime() <= t1; d.setTime(d.getTime() + HOUR_MS)) {
      // Whole hours of local time (a half-hour zone's are not UTC's).
      if (d.getMinutes() !== 0 || d.getHours() % k !== 0 || !keep(d.getTime())) continue;
      out.push({ t: d.getTime(), label: d.getHours() === 0 ? dayLabel(d) : hourLabel(d) });
    }
    return out;
  });
}

/**
 * Pure: the date axis's ticks, placed by time: at most `target`, on round
 * moments (whole hours, midnights, Mondays, the 1st and 15th, month starts,
 * years), the finest step that fits. On the trading scale: one tick per
 * session open (labelled with its New York date) when the span holds two
 * sessions or more, else whole hours inside the session. Hours and calendar
 * dates are local time. A span with no round moment in it (an account opened
 * minutes ago) gets one tick at its start, "10:32 AM".
 */
export function timeTicks(scale: TimeScale, target = 5): TimeTick[] {
  const { t0, t1 } = scale;
  if (!(t1 > t0)) return [];
  const start = new Date(t0);
  const first: TimeTick[] = [{ t: t0, label: `${start.getHours() % 12 || 12}:${String(start.getMinutes()).padStart(2, "0")} ${start.getHours() < 12 ? "AM" : "PM"}` }];
  const pick = (cands: TimeTick[][]) => cands.find((c) => c.length && c.length <= target) ?? cands.filter((c) => c.length).pop() ?? first;
  if (scale.kind === "trading") {
    const sessions = sessionsBetween(t0, t1);
    if (sessions.length >= 2) {
      const opens = sessions.filter((s) => s.open >= t0);
      const stride = Math.ceil(opens.length / target);
      return opens
        .filter((_, i) => (opens.length - 1 - i) % stride === 0)
        .map((s) => {
          const [, m, d] = s.day.split("-").map(Number) as [number, number, number];
          return { t: s.open, label: `${MONTH_NAMES[m - 1]} ${d}` };
        });
    }
    return pick(hourTicks(t0, t1, (t) => inSession(sessions, t)));
  }
  const days = t1 - t0 <= 120 * 86_400_000 ? midnights(t0, t1) : [];
  const months = monthStarts(t0, t1);
  const dayTicks = (keep: (d: Date) => boolean) => days.filter(keep).map((d) => ({ t: d.getTime(), label: dayLabel(d) }));
  const monthTicks = (k: number) => months.filter((d) => d.getMonth() % k === 0).map((d) => ({ t: d.getTime(), label: d.getMonth() === 0 ? String(d.getFullYear()) : MONTH_NAMES[d.getMonth()]! }));
  const yearTicks = (k: number) => months.filter((d) => d.getMonth() === 0 && d.getFullYear() % k === 0).map((d) => ({ t: d.getTime(), label: String(d.getFullYear()) }));
  return pick([
    ...hourTicks(t0, t1, () => true),
    dayTicks(() => true),
    dayTicks((d) => d.getDate() % 2 === 1 && d.getDate() < 31),
    dayTicks((d) => d.getDay() === 1),
    dayTicks((d) => d.getDate() === 1 || d.getDate() === 15),
    monthTicks(1),
    monthTicks(2),
    monthTicks(3),
    monthTicks(6),
    yearTicks(1),
    yearTicks(2),
    yearTicks(5),
    yearTicks(10),
  ]);
}

/** Pure: the index of the point nearest in time to `t` (times ascending); -1 when there are none. */
export function nearestIndex(times: readonly number[], t: number): number {
  if (!times.length) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(times[hi]! - t) < Math.abs(times[lo]! - t) ? hi : lo;
}
