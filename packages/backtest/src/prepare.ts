/**
 * Turns loaded data into what the FSL evaluator and the simulator read: one
 * aligned panel on SPY's calendar, events placed on their decision session,
 * and the daily cash rate. Pure.
 *
 * Event timing (design 2.4, 4.4):
 *   close clock    an event counts on session t when known by 16:00 New York time on t;
 *   preopen clock  when known by 09:15 on t (fills at t's open).
 * Yahoo gives earnings release times only as a bucket: before the open counts
 * as 08:00, during the session as 12:00, after the close (and unknown) as 16:30.
 * v1 specs (legacy) keep v1's rule: a release counts on its date, whatever the time.
 */

import { decisionDay, isoToDay, nyLocal } from "./calendar";
import type { EarningsRow, EventInputs, Panel, ReactionRow, RippleRow } from "./fsl/eval";
import { dailyCashRates, type RatePoint } from "./rates";
import type { Bar, EarningsEvent, RippleEventRaw } from "./data/types";
import { mean, ols } from "./stats";

export type SpecData = {
  bars: Record<string, Bar[]>;
  earnings: Record<string, EarningsEvent[]>;
  ripple: RippleEventRaw[];
  rates: RatePoint[];
  sources: { prices: string; earnings: string | null; ripple: string | null; rates: string | null };
  flags: { ratesFallback: boolean; rippleConnected: boolean; betaSource: boolean };
  warnings: string[];
};

export type Prepared = {
  panel: Panel;
  events: EventInputs;
  tbill: Float64Array;
  /** First and last simulated sessions (inclusive) in panel indices. */
  startIndex: number;
  endIndex: number;
  warnings: string[];
};

/** First index with dates[i] >= day. */
export function lowerBound(dates: readonly string[], day: string): number {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! < day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const BUCKET_MIN: Record<EarningsEvent["time"], number> = { before_open: 8 * 60, during: 12 * 60, after_close: 16 * 60 + 30, unknown: 16 * 60 + 30 };

export function buildPanel(bars: Record<string, Bar[]>, tickers: string[], calendar: string[]): Panel {
  const T = calendar.length;
  const N = tickers.length;
  const mk = () => new Float64Array(N * T).fill(NaN);
  const panel: Panel = {
    dates: calendar,
    tickers,
    col: new Map(tickers.map((t, i) => [t, i])),
    open: mk(),
    high: mk(),
    low: mk(),
    close: mk(),
    raw: mk(),
    volume: mk(),
    dv: mk(),
    has: new Uint8Array(N * T),
  };
  const index = new Map(calendar.map((d, i) => [d, i]));
  tickers.forEach((t, c) => {
    const rows = bars[t] ?? [];
    const at = new Map<number, Bar>();
    for (const b of rows) {
      const i = index.get(b.date);
      if (i !== undefined) at.set(i, b);
    }
    let last: Bar | null = null;
    for (let i = 0; i < T; i++) {
      const b = at.get(i);
      const k = c * T + i;
      if (b) {
        panel.open[k] = b.open;
        panel.high[k] = b.high;
        panel.low[k] = b.low;
        panel.close[k] = b.close;
        panel.raw[k] = b.rawClose ?? b.close;
        panel.volume[k] = b.volume;
        panel.dv[k] = b.dollarVolume ?? b.close * b.volume;
        panel.has[k] = 1;
        last = b;
      } else if (last) {
        // No session for this ticker today: carry the last close (a flat bar, no volume).
        panel.open[k] = last.close;
        panel.high[k] = last.close;
        panel.low[k] = last.close;
        panel.close[k] = last.close;
        panel.raw[k] = last.rawClose ?? last.close;
        panel.volume[k] = 0;
        panel.dv[k] = 0;
      }
    }
  });
  return panel;
}

function sessionOfDay(dates: readonly string[], dayNum: number): number {
  return lowerBound(dates, new Date(dayNum * 86_400_000).toISOString().slice(0, 10));
}

/**
 * Market-model abnormal return of column c on session r (MacKinlay 1997):
 * beta and alpha from daily close-to-close returns vs SPY over sessions
 * [r - 260, r - 11], at least 120 observations.
 */
export function abnormalReturn(panel: Panel, c: number, spy: number, r: number): number {
  const T = panel.dates.length;
  const ret = (col: number, t: number) => {
    if (t < 1) return NaN;
    const a = panel.close[col * T + t - 1]!;
    const b = panel.close[col * T + t]!;
    return a > 0 && b > 0 && panel.has[col * T + t] ? b / a - 1 : NaN;
  };
  const xs: number[] = [];
  const ys: number[] = [];
  for (let t = Math.max(1, r - 260); t <= r - 11; t++) {
    const x = ret(spy, t);
    const y = ret(c, t);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      xs.push(x);
      ys.push(y);
    }
  }
  const ri = ret(c, r);
  const rm = ret(spy, r);
  if (!Number.isFinite(ri) || !Number.isFinite(rm)) return NaN;
  if (xs.length < 120) return ri - rm;
  const { a, b } = ols(xs, ys);
  return ri - (a + b * rm);
}

export function placeEvents(data: SpecData, panel: Panel, clock: "close" | "preopen", legacy: boolean): EventInputs {
  const dates = panel.dates;
  const T = dates.length;
  const earnings = new Map<string, EarningsRow[]>();
  const reactions = new Map<string, ReactionRow[]>();
  const spy = panel.col.get("SPY");
  for (const [ticker, rows] of Object.entries(data.earnings)) {
    const c = panel.col.get(ticker);
    const out: EarningsRow[] = [];
    const rx: ReactionRow[] = [];
    for (const e of rows) {
      const day = isoToDay(e.date);
      const session = legacy ? lowerBound(dates, e.date) : sessionOfDay(dates, decisionDay(day, BUCKET_MIN[e.time], clock));
      if (session < T) out.push({ session, surprise: e.surprisePct === null || !Number.isFinite(e.surprisePct) ? null : e.surprisePct / 100 });
      // Reaction day: the first session that could trade on the release.
      const reaction = sessionOfDay(dates, decisionDay(day, e.time === "before_open" ? 9 * 60 : e.time === "during" ? 12 * 60 : 16 * 60 + 30, "close"));
      if (c !== undefined && spy !== undefined && reaction < T) {
        const v = abnormalReturn(panel, c, spy, reaction);
        // Known at the reaction-day close: the close clock uses it that session, preopen the next.
        const known = clock === "close" ? reaction : reaction + 1;
        if (Number.isFinite(v) && known < T) rx.push({ session: known, value: v });
      }
    }
    earnings.set(ticker, out);
    reactions.set(ticker, rx);
  }
  const ripple = new Map<string, RippleRow[]>();
  for (const r of data.ripple) {
    const local = nyLocal(r.known_at);
    if (!local) continue;
    const session = sessionOfDay(dates, decisionDay(local.day, local.minutes, clock));
    if (session >= T) continue;
    const list = ripple.get(r.ticker) ?? [];
    list.push({
      session,
      relation: r.relation,
      degree: r.degree,
      eventKind: r.event_kind,
      eventSign: r.event_sign,
      impliedDir: r.implied_dir,
      edgeTier: r.edge_tier,
      coverage: r.coverage,
    });
    ripple.set(r.ticker, list);
  }
  return { earnings, reactions, ripple };
}

export function prepare(
  data: SpecData,
  tickers: string[],
  period: { start: string; end: string },
  clock: "close" | "preopen",
  legacy: boolean,
): Prepared {
  const spy = data.bars.SPY ?? [];
  const calendar = spy.map((b) => b.date).filter((d) => d <= period.end);
  if (calendar.length < 2) throw new Error(`No SPY trading days up to ${period.end}.`);
  const all = Array.from(new Set([...tickers, "SPY"]));
  const panel = buildPanel(data.bars, all, calendar);
  const startIndex = lowerBound(calendar, period.start);
  const endIndex = calendar.length - 1;
  if (endIndex - startIndex < 2) throw new Error(`No SPY trading days between ${period.start} and ${period.end}.`);
  return {
    panel,
    events: placeEvents(data, panel, clock, legacy),
    tbill: dailyCashRates(calendar, data.rates),
    startIndex,
    endIndex,
    warnings: [],
  };
}

/** The same inputs cut at session c: bars after c removed, events known after c dropped (prefix check). */
export function truncate(p: Prepared, c: number): Prepared {
  const T = p.panel.dates.length;
  const n = c + 1;
  const cut = (a: Float64Array) => {
    const out = new Float64Array(p.panel.tickers.length * n);
    for (let k = 0; k < p.panel.tickers.length; k++) out.set(a.subarray(k * T, k * T + n), k * n);
    return out;
  };
  const has = new Uint8Array(p.panel.tickers.length * n);
  for (let k = 0; k < p.panel.tickers.length; k++) has.set(p.panel.has.subarray(k * T, k * T + n), k * n);
  const panel: Panel = {
    dates: p.panel.dates.slice(0, n),
    tickers: p.panel.tickers,
    col: p.panel.col,
    open: cut(p.panel.open),
    high: cut(p.panel.high),
    low: cut(p.panel.low),
    close: cut(p.panel.close),
    raw: cut(p.panel.raw),
    volume: cut(p.panel.volume),
    dv: cut(p.panel.dv),
    has,
  };
  const keep = <R extends { session: number }>(m: Map<string, R[]>) => new Map(Array.from(m, ([k, v]) => [k, v.filter((r) => r.session <= c)]));
  return {
    panel,
    events: { earnings: keep(p.events.earnings), reactions: keep(p.events.reactions), ripple: keep(p.events.ripple) },
    tbill: p.tbill.slice(0, n),
    startIndex: Math.min(p.startIndex, c),
    endIndex: c,
    warnings: [],
  };
}

export { mean };
