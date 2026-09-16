/**
 * Equity curve — the strategy against buy-and-hold S&P 500 (§7 presentation).
 *
 * A backtest produces individual trades, not a portfolio, so turning them into
 * a growth curve needs ONE modelling decision. The one taken here is the
 * least arbitrary available:
 *
 *   every session, capital is split equally across whatever positions are open
 *   that day; when nothing is open the curve sits flat in cash.
 *
 * That is a standard equal-weight event-study portfolio. It needs no
 * max-positions knob, no leverage, and no ordering preference between signals
 * that fire on the same day — each of which would have been a free parameter,
 * and free parameters are exactly what §2 refuses.
 *
 * What it is NOT: a claim about what an account would have done. There are no
 * transaction costs, no slippage, no borrow cost on the short side, and a day
 * with one open position puts 100% of capital in one name. The assumption is
 * carried on the curve itself so it travels with the number.
 *
 * One reconciliation note: for LONG positions the compounded curve reproduces
 * the horizon return the stats table scores, exactly. For SHORTS it does not
 * quite — a short marked to market each session compounds −r daily, which is
 * not the same as flipping the sign on a close-to-close move (exposure shrinks
 * as the position moves against you). The curve is the more faithful of the
 * two; the small gap is short-side compounding asymmetry, not a bug.
 */

import type { TradingCalendar } from "./calendar.js";
import { entryPriceOf, type ReturnContext } from "./returns.js";
import { snapshotAt } from "./series.js";
import type { EntryWhen, Signal } from "./types.js";

export type EquityPoint = {
  d: string;
  /** Strategy equity, starting at 1. */
  s: number;
  /** Benchmark equity, starting at 1. */
  b: number;
  /** Positions open that session. */
  n: number;
};

export type EquityCurve = {
  horizon: number;
  points: EquityPoint[];
  strategy_total: number | null;
  benchmark_total: number | null;
  strategy_max_drawdown: number | null;
  benchmark_max_drawdown: number | null;
  /** Share of sessions with at least one position open. */
  exposure: number;
  /** Sessions where the curves can be compared at all. */
  sessions: number;
  /** The modelling decision, carried with the curve. */
  assumption: string;
};

export const EQUITY_ASSUMPTION =
  "Equal weight across whatever positions are open each session, cash when none are; gross of costs and slippage.";

/**
 * The sessions a signal is actually exposed for, with the return earned on
 * each — matching the entry convention exactly, so compounding these reproduces
 * the horizon return the report scores.
 *
 *   signal_close   close(S) → close(S+h)      exposed S+1 … S+h
 *   next_open      open(S+1) → close(S+h)     exposed S+1 … S+h, day one from the open
 */
function dailyLegs(
  ctx: ReturnContext,
  calendar: TradingCalendar,
  ticker: string,
  session: string,
  when: EntryWhen,
  horizon: number,
  sign: 1 | -1,
): Array<{ d: string; r: number }> {
  const series = ctx.seriesByTicker.get(ticker);
  if (!series) return [];
  // Both conventions are exposed for sessions S+1 … S+h; they differ only in
  // where day one starts (previous close vs that morning's open).
  const legs: Array<{ d: string; r: number }> = [];

  for (let step = 1; step <= horizon; step++) {
    const day = calendar.shift(session, step);
    if (!day) return [];
    const snap = snapshotAt(series, day);
    // A session the name did not trade contributes nothing rather than being
    // forward-filled into an invented return.
    if (!snap) continue;

    let r: number | null;
    if (when === "next_open" && step === 1) {
      const open = entryPriceOf(snap, "next_open");
      r = open > 0 ? snap.close / open - 1 : null;
    } else {
      r = snap.ret;
    }
    if (r == null || !Number.isFinite(r)) continue;
    legs.push({ d: day, r: r * sign });
  }
  return legs;
}

export type EquityInput = {
  signals: Signal[];
  ctx: ReturnContext;
  calendar: TradingCalendar;
  horizon: number;
  when: EntryWhen;
  from: string;
  to: string;
  /** Cap on stored points; the curve is thinned for drawing, never the maths. */
  maxPoints?: number;
};

/** session → the signed daily returns of every position open that day. */
function openPositionsByDay(input: EquityInput, signals: Signal[]): Map<string, number[]> {
  const byDay = new Map<string, number[]>();
  for (const signal of signals) {
    const ret = signal.returns.find((r) => r.sessions === input.horizon);
    // Only signals whose horizon actually resolved take part; an unfinished
    // hold has no business moving the curve.
    if (!ret || ret.raw == null) continue;
    for (const leg of dailyLegs(input.ctx, input.calendar, signal.ticker, signal.session, input.when, input.horizon, signal.sign)) {
      const list = byDay.get(leg.d) ?? [];
      list.push(leg.r);
      byDay.set(leg.d, list);
    }
  }
  return byDay;
}

export function buildEquityCurve(input: EquityInput): EquityCurve {
  const { calendar, ctx } = input;
  const sessions = calendar.range(input.from, input.to);
  const strategyDays = openPositionsByDay(input, input.signals);
  const bench = ctx.seriesByTicker.get(ctx.benchmark);

  const points: EquityPoint[] = [];
  let strategy = 1;
  let benchmark = 1;
  let sPeak = 1;
  let bPeak = 1;
  let sWorst = 0;
  let bWorst = 0;
  let exposed = 0;

  // Thin for storage only — every session is still compounded.
  const maxPoints = input.maxPoints ?? 320;
  const stride = Math.max(1, Math.ceil(sessions.length / maxPoints));

  for (const [i, day] of sessions.entries()) {
    const open = strategyDays.get(day) ?? [];
    if (open.length > 0) {
      exposed++;
      strategy *= 1 + open.reduce((a, b) => a + b, 0) / open.length;
    }
    const benchSnap = bench ? snapshotAt(bench, day) : null;
    if (benchSnap?.ret != null && Number.isFinite(benchSnap.ret)) benchmark *= 1 + benchSnap.ret;

    if (strategy > sPeak) sPeak = strategy;
    if (benchmark > bPeak) bPeak = benchmark;
    sWorst = Math.min(sWorst, strategy / sPeak - 1);
    bWorst = Math.min(bWorst, benchmark / bPeak - 1);

    if (i % stride === 0 || i === sessions.length - 1) {
      points.push({ d: day, s: round6(strategy), b: round6(benchmark), n: open.length });
    }
  }

  const any = sessions.length > 0;
  return {
    horizon: input.horizon,
    points,
    strategy_total: any ? strategy - 1 : null,
    benchmark_total: any ? benchmark - 1 : null,
    strategy_max_drawdown: any ? sWorst : null,
    benchmark_max_drawdown: any ? bWorst : null,
    exposure: any ? exposed / sessions.length : 0,
    sessions: sessions.length,
    assumption: EQUITY_ASSUMPTION,
  };
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
