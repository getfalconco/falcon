import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEquityCurve } from "./equity.js";
import { computeHorizonReturn, resolveWindow } from "./returns.js";
import { contextFrom, flatSeries, seriesFrom, tradingDays } from "./test-fixtures.js";
import type { EntryWhen, Signal } from "./types.js";

const days = tradingDays(40);
const close = (a: number | null, b: number, tol = 1e-9) => {
  assert.ok(a != null, "expected a number");
  assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
};

function signalAt(ctx: ReturnType<typeof contextFrom>["ctx"], calendar: ReturnType<typeof contextFrom>["calendar"], session: string, horizon: number, when: EntryWhen, sign: 1 | -1 = 1): Signal {
  const window = resolveWindow(calendar, session, when, horizon)!;
  const ret = computeHorizonReturn(ctx, { ticker: "AAA", window, holdSessions: horizon, sign, beta: 1 });
  return {
    ticker: "AAA",
    session,
    entry_session: window.entry,
    entry_price: 100,
    entry_when: when,
    sign,
    sector: null,
    reason: "test",
    returns: [ret],
  };
}

describe("quantlab/equity — a single trade reproduces its own return", () => {
  const ticker = seriesFrom({ ticker: "AAA", days, returns: new Array(39).fill(0.01) });
  const bench = flatSeries("SPY", days);
  const { ctx, calendar } = contextFrom({ series: [bench, ticker], sectors: {} });

  it("signal_close: compounding the daily legs equals close-to-close", () => {
    const signal = signalAt(ctx, calendar, days[10], 5, "signal_close");
    const curve = buildEquityCurve({
      signals: [signal],
      ctx,
      calendar,
      horizon: 5,
      when: "signal_close",
      from: days[0],
      to: days[39],
    });
    // Only the trade moved the curve, so the final equity IS the trade return.
    close(curve.strategy_total, Math.pow(1.01, 5) - 1, 1e-9);
    close(curve.strategy_total, signal.returns[0].raw!, 1e-9);
  });

  it("next_open: day one runs from the open, and it still reconciles", () => {
    const withOpens = seriesFrom({ ticker: "AAA", days, returns: new Array(39).fill(0.01), openFactor: 1.02 });
    const local = contextFrom({ series: [bench, withOpens], sectors: {} });
    const signal = signalAt(local.ctx, local.calendar, days[10], 5, "next_open");
    const curve = buildEquityCurve({
      signals: [signal],

      ctx: local.ctx,
      calendar: local.calendar,
      horizon: 5,
      when: "next_open",
      from: days[0],
      to: days[39],
    });
    close(curve.strategy_total, signal.returns[0].raw!, 1e-9);
  });

  it("a short is marked to market daily, so it does NOT equal the negated long return", () => {
    const signal = signalAt(ctx, calendar, days[10], 5, "signal_close", -1);
    const curve = buildEquityCurve({
      signals: [signal],
      ctx,
      calendar,
      horizon: 5,
      when: "signal_close",
      from: days[0],
      to: days[39],
    });
    assert.ok(curve.strategy_total! < 0, "shorting a rising name loses");

    // A short position rebalanced each session compounds −1% five times…
    close(curve.strategy_total, Math.pow(0.99, 5) - 1, 1e-9);
    // …which is NOT the same as flipping the sign on the buy-and-hold return.
    // The gap is short-side compounding asymmetry, not an error: exposure
    // shrinks as the position moves against you.
    const negatedLong = signal.returns[0].raw!;
    assert.notEqual(curve.strategy_total, negatedLong);
    assert.ok(curve.strategy_total! > negatedLong, "the daily-rebalanced short loses slightly less");
    assert.ok(Math.abs(curve.strategy_total! - negatedLong) < 0.003, "and only slightly — same order of magnitude");
  });
});

describe("quantlab/equity — portfolio behaviour", () => {
  const ticker = seriesFrom({ ticker: "AAA", days, returns: new Array(39).fill(0.01) });
  const bench = seriesFrom({ ticker: "SPY", days, returns: new Array(39).fill(0.005) });
  const { ctx, calendar } = contextFrom({ series: [bench, ticker], sectors: {} });

  it("sits flat in cash while nothing is open", () => {
    const signal = signalAt(ctx, calendar, days[10], 5, "signal_close");
    const curve = buildEquityCurve({ signals: [signal], ctx, calendar, horizon: 5, when: "signal_close", from: days[0], to: days[39] });
    // Before the trade opens the strategy has not moved.
    assert.equal(curve.points.find((p) => p.d === days[9])!.s, 1);
    // After it closes it stops moving.
    assert.equal(curve.points.find((p) => p.d === days[39])!.s, curve.points.find((p) => p.d === days[15])!.s);
  });

  it("reports exposure as the share of sessions with a position open", () => {
    const signal = signalAt(ctx, calendar, days[10], 5, "signal_close");
    const curve = buildEquityCurve({ signals: [signal], ctx, calendar, horizon: 5, when: "signal_close", from: days[0], to: days[39] });
    // Exposed on days 11..15 = 5 of 40 sessions.
    close(curve.exposure, 5 / 40, 1e-12);
  });

  it("two overlapping trades share capital rather than doubling it", () => {
    const a = signalAt(ctx, calendar, days[10], 5, "signal_close");
    const b = signalAt(ctx, calendar, days[10], 5, "signal_close");
    const solo = buildEquityCurve({ signals: [a], ctx, calendar, horizon: 5, when: "signal_close", from: days[0], to: days[39] });
    const both = buildEquityCurve({ signals: [a, b], ctx, calendar, horizon: 5, when: "signal_close", from: days[0], to: days[39] });
    // Equal weight over two identical positions is the same as one — no leverage.
    close(both.strategy_total, solo.strategy_total!, 1e-12);
    assert.equal(both.points.find((p) => p.d === days[11])!.n, 2, "both are counted as open");
  });

  it("tracks the benchmark independently of whether the strategy is invested", () => {
    const curve = buildEquityCurve({ signals: [], ctx, calendar, horizon: 5, when: "signal_close", from: days[0], to: days[39] });
    close(curve.strategy_total, 0, 1e-12);
    close(curve.benchmark_total, Math.pow(1.005, 39) - 1, 1e-9);
    assert.equal(curve.exposure, 0);
  });

  it("carries its modelling assumption on the curve", () => {
    const curve = buildEquityCurve({ signals: [], ctx, calendar, horizon: 5, when: "signal_close", from: days[0], to: days[39] });
    assert.match(curve.assumption, /Equal weight/);
    assert.match(curve.assumption, /gross of costs/);
  });

  it("ignores a signal whose horizon never resolved", () => {
    const unresolved: Signal = {
      ...signalAt(ctx, calendar, days[10], 5, "signal_close"),
      returns: [{ sessions: 5, exit_session: null, exit_price: null, raw: null, market_adjusted: null, sector_relative: null, degraded: ["pending"] }],
    };
    const curve = buildEquityCurve({ signals: [unresolved], ctx, calendar, horizon: 5, when: "signal_close", from: days[0], to: days[39] });
    close(curve.strategy_total, 0, 1e-12);
  });

  it("records a drawdown when the strategy gives back gains", () => {
    const choppy = seriesFrom({ ticker: "AAA", days, returns: days.slice(1).map((_d, i) => (i % 2 === 0 ? 0.05 : -0.05)) });
    const local = contextFrom({ series: [bench, choppy], sectors: {} });
    const signal = signalAt(local.ctx, local.calendar, days[10], 10, "signal_close");
    const curve = buildEquityCurve({ signals: [signal], ctx: local.ctx, calendar: local.calendar, horizon: 10, when: "signal_close", from: days[0], to: days[39] });
    assert.ok(curve.strategy_max_drawdown! < 0, "an alternating series must show a drawdown");
  });
});

describe("quantlab/equity — stored resolution", () => {
  const ticker = seriesFrom({ ticker: "AAA", days, returns: new Array(39).fill(0.01) });
  const bench = seriesFrom({ ticker: "SPY", days, returns: new Array(39).fill(0.001) });
  const { ctx, calendar } = contextFrom({ series: [bench, ticker], sectors: {} });

  it("thins stored points without changing the totals", () => {
    const real = signalAt(ctx, calendar, days[10], 5, "signal_close");
    const opts = { signals: [real], ctx, calendar, horizon: 5, when: "signal_close" as const, from: days[0], to: days[39] };
    const full = buildEquityCurve({ ...opts, maxPoints: 1000 });
    const thin = buildEquityCurve({ ...opts, maxPoints: 10 });
    assert.ok(thin.points.length < full.points.length);
    assert.ok(thin.points.length <= 12, );
    close(thin.strategy_total, full.strategy_total!, 1e-12);
    close(thin.strategy_max_drawdown, full.strategy_max_drawdown!, 1e-12);
    assert.equal(thin.points[thin.points.length - 1].d, days[39], "the last session is always kept");
  });
});
