import test from "node:test";
import assert from "node:assert/strict";
import { eventFireDates, runBacktest, type RippleSignal, type RunConfig } from "../src/index";
import { approx, makeBars, market, randomWalk, strategy, weekdays } from "./helpers";

const flat = (n: number, v = 100) => new Array<number>(n).fill(v);

function cfg(dates: string[], over: Partial<RunConfig> = {}): RunConfig {
  return { start: dates[0]!, end: dates.at(-1)!, initialCapital: 10_000, commissionBps: 0, slippageBps: 0, ...over };
}

test("signal on the close of day t fills at the open of t+1, with slippage and commission", () => {
  const dates = weekdays("2024-01-01", 12);
  const closes = [100, 100, 100, 110, 110, 110, 110, 110, 110, 110, 110, 110];
  const aaa = makeBars(dates, closes, { 4: { open: 111, high: 111 }, 6: { open: 112, high: 112 } });
  const s = strategy({ exit: { conditions: [], stopLossPct: null, takeProfitPct: null, maxHoldingDays: 2 } });
  const r = runBacktest(s, cfg(dates, { commissionBps: 10, slippageBps: 20 }), market({ AAA: aaa, SPY: makeBars(dates, flat(12)) }));
  assert.equal(r.trades.length, 1);
  const t = r.trades[0]!;
  assert.equal(t.entryDate, dates[4]);
  assert.ok(approx(t.entryPrice, 111 * 1.002));
  assert.equal(t.exitDate, dates[6]);
  assert.ok(approx(t.exitPrice, 112 * 0.998));
  assert.equal(t.exitReason, "max_holding");
  assert.equal(t.sessionsHeld, 2);
  const shares = 10_000 / 1.001 / (111 * 1.002);
  const final = shares * 112 * 0.998 * 0.999;
  assert.ok(approx(t.shares, shares));
  assert.ok(approx(r.equity.at(-1)!.strategy, final));
  assert.ok(approx(r.metrics.strategy.totalReturnPct, (final / 10_000 - 1) * 100));
  // Nothing is held on the signal day itself.
  assert.equal(r.equity[3]!.invested, 0);
  assert.ok(r.equity[4]!.invested > 0.99);
});

test("no look-ahead: changing prices after day K leaves every result up to K unchanged", () => {
  const dates = weekdays("2020-01-01", 320);
  const walk = randomWalk(320, 11);
  const spyWalk = randomWalk(320, 5);
  const K = 220;
  const s = strategy({
    universe: ["AAA", "BBB"],
    entry: { mode: "any", conditions: [{ type: "rsi", ticker: null, period: 2, op: "below", value: 15 }] },
    exit: {
      conditions: [{ type: "price_vs_ma", ticker: null, ma: "sma", period: 5, op: "above" }],
      stopLossPct: 4,
      takeProfitPct: null,
      maxHoldingDays: 8,
    },
    sizing: { maxPositions: 2, positionPct: null },
  });
  const build = (shock: boolean) => {
    const f = (xs: number[]) => xs.map((x, i) => (shock && i > K ? x * (i % 2 ? 1.7 : 0.4) : x));
    return market({
      AAA: makeBars(dates, f(walk)),
      BBB: makeBars(dates, f(walk.map((x, i) => x * (1 + 0.1 * Math.sin(i / 7))))),
      SPY: makeBars(dates, f(spyWalk)),
    });
  };
  const c = cfg(dates, { start: dates[40]!, commissionBps: 5, slippageBps: 5 });
  const a = runBacktest(s, c, build(false));
  const b = runBacktest(s, c, build(true));
  const upTo = (r: typeof a) => r.equity.filter((p) => p.date <= dates[K]!);
  assert.ok(a.trades.length > 5, "the walk should trade");
  assert.deepEqual(upTo(a), upTo(b));
  const closedBy = (r: typeof a) => r.trades.filter((t) => t.exitDate <= dates[K]!);
  assert.deepEqual(closedBy(a), closedBy(b));
});

function stopCase(over: Record<number, object>, exit: { stopLossPct: number | null; takeProfitPct: number | null }) {
  const dates = weekdays("2024-01-01", 8);
  const closes = [100, 100, 100, 110, 110, 110, 110, 110];
  const aaa = makeBars(dates, closes, over);
  const s = strategy({ exit: { conditions: [], maxHoldingDays: null, ...exit } });
  return { dates, r: runBacktest(s, cfg(dates), market({ AAA: aaa, SPY: makeBars(dates, flat(8)) })) };
}

test("stop loss fills at the stop level intraday, or at the open on a gap", () => {
  const intraday = stopCase({ 5: { open: 110, high: 110, low: 100, close: 110 } }, { stopLossPct: 5, takeProfitPct: null });
  assert.equal(intraday.r.trades[0]!.exitReason, "stop_loss");
  assert.equal(intraday.r.trades[0]!.exitDate, intraday.dates[5]);
  assert.ok(approx(intraday.r.trades[0]!.exitPrice, 104.5));
  assert.equal(intraday.r.trades[0]!.sessionsHeld, 2);

  const gap = stopCase({ 5: { open: 100, high: 110, low: 99, close: 110 } }, { stopLossPct: 5, takeProfitPct: null });
  assert.ok(approx(gap.r.trades[0]!.exitPrice, 100));

  const both = stopCase({ 5: { open: 110, high: 120, low: 100, close: 110 } }, { stopLossPct: 5, takeProfitPct: 5 });
  assert.equal(both.r.trades[0]!.exitReason, "stop_loss");

  const tp = stopCase({ 5: { open: 110, high: 120, low: 109, close: 110 } }, { stopLossPct: 5, takeProfitPct: 5 });
  assert.equal(tp.r.trades[0]!.exitReason, "take_profit");
  assert.ok(approx(tp.r.trades[0]!.exitPrice, 115.5));
});

test("event windows: first session on or after the release, then daysAfter - 1 sessions", () => {
  const dates = weekdays("2024-01-01", 10); // 2024-01-06 is a Saturday
  assert.deepEqual([...eventFireDates(dates, ["2024-01-06"], 1)], ["2024-01-08"]);
  assert.deepEqual([...eventFireDates(dates, ["2024-01-03"], 1)], ["2024-01-03"]);
  assert.deepEqual([...eventFireDates(dates, ["2024-01-03"], 3)], ["2024-01-05"]);
  assert.deepEqual([...eventFireDates(dates, ["2024-01-12"], 1)], ["2024-01-12"]);
  assert.deepEqual([...eventFireDates(dates, ["2024-01-13"], 1)], []);
});

test("earnings strategy: enters the open after the first session following a beat, holds N sessions", () => {
  const dates = weekdays("2024-01-01", 15);
  const aaa = makeBars(dates, flat(15).map((v, i) => v + i));
  const s = strategy({
    entry: { mode: "all", conditions: [{ type: "earnings_surprise", ticker: null, op: "above", pct: 5, daysAfter: 1 }] },
    exit: { conditions: [], stopLossPct: null, takeProfitPct: null, maxHoldingDays: 3 },
  });
  const data = market(
    { AAA: aaa, SPY: makeBars(dates, flat(15)) },
    {
      earnings: {
        AAA: [
          { date: "2024-01-06", time: "unknown", epsActual: 1.08, epsEstimate: 1, surprisePct: 8 },
          { date: "2024-01-15", time: "after_close", epsActual: 1.03, epsEstimate: 1, surprisePct: 3 },
        ],
      },
    },
  );
  const r = runBacktest(s, cfg(dates), data);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0]!.entryDate, "2024-01-09");
  assert.equal(r.trades[0]!.exitDate, "2024-01-12");
  assert.equal(r.trades[0]!.sessionsHeld, 3);
});

test("position slots: entries fill in universe order, the rest are counted as skipped", () => {
  const dates = weekdays("2024-01-01", 8);
  const jump = makeBars(dates, [100, 100, 100, 110, 110, 110, 110, 110]);
  const s = strategy({
    universe: ["AAA", "BBB", "CCC"],
    sizing: { maxPositions: 2, positionPct: null },
    exit: { conditions: [], stopLossPct: null, takeProfitPct: null, maxHoldingDays: 2 },
  });
  const r = runBacktest(s, cfg(dates), market({ AAA: jump, BBB: jump, CCC: jump, SPY: makeBars(dates, flat(8)) }));
  assert.deepEqual(r.trades.map((t) => t.ticker), ["AAA", "BBB"]);
  assert.ok(approx(r.trades[0]!.cost, 5_000));
  assert.equal(r.metrics.strategy.skippedEntries, 1);
  assert.ok(r.warnings.some((w) => w.includes("1 entry signals")));
});

test("SPY buy-and-hold over the same calendar; open positions close on the last day", () => {
  const dates = weekdays("2023-01-02", 60);
  const spy = makeBars(dates, randomWalk(60, 3));
  const s = strategy({
    universe: ["SPY"],
    entry: { mode: "all", conditions: [{ type: "n_day_return", ticker: null, days: 1, op: "above", pct: -100 }] },
  });
  const r = runBacktest(s, cfg(dates), market({ SPY: spy }));
  const expected = (spy.at(-1)!.close / spy[0]!.close - 1) * 100;
  assert.ok(Math.abs(r.metrics.benchmark.totalReturnPct - expected) < 1e-9);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0]!.exitReason, "end");
  // The 1-day return needs one prior bar, so the first signal is day 1 and the fill day 2.
  assert.equal(r.trades[0]!.entryDate, dates[2]);
  assert.equal(r.period.sessions, 60);
  assert.ok(r.caveats.some((c) => c.startsWith("Survivorship")));
});

test("monthly rebalancing trims the winner back to its weight", () => {
  const dates = weekdays("2024-01-01", 60);
  const up = makeBars(dates, dates.map((_, i) => 100 * 1.01 ** i));
  const still = makeBars(dates, flat(60));
  const base = strategy({
    universe: ["AAA", "BBB"],
    entry: { mode: "all", conditions: [{ type: "n_day_return", ticker: null, days: 1, op: "above", pct: -100 }] },
    sizing: { maxPositions: 2, positionPct: null },
  });
  const data = market({ AAA: up, BBB: still, SPY: still });
  const hold = runBacktest(base, cfg(dates), data);
  const reb = runBacktest({ ...base, rebalance: "monthly" }, cfg(dates), data);
  assert.ok(reb.equity.at(-1)!.strategy < hold.equity.at(-1)!.strategy);
  assert.ok(reb.equity.at(-1)!.strategy > 10_000);
  assert.ok(reb.equity.slice(2, -1).every((p) => p.invested > 0.99));
});

test("ripple conditions read the ripple feed; with no feed they never fire and say so", () => {
  const dates = weekdays("2024-01-01", 10);
  const aaa = makeBars(dates, flat(10));
  const s = strategy({
    entry: {
      mode: "all",
      conditions: [{ type: "ripple_event", relation: "supplier", direction: "up", minConfidence: "medium", maxDegree: 1, daysAfter: 1 }],
    },
    exit: { conditions: [], stopLossPct: null, takeProfitPct: null, maxHoldingDays: 2 },
  });
  const none = runBacktest(s, cfg(dates), market({ AAA: aaa, SPY: aaa }));
  assert.equal(none.trades.length, 0);
  assert.ok(none.warnings.some((w) => w.includes("ripple")));
  const hit = (over: Partial<RippleSignal>): RippleSignal => ({
    ticker: "AAA",
    date: dates[2]!,
    relation: "supplier",
    direction: "up",
    confidence: "high",
    degree: 1,
    cardId: "c1",
    ...over,
  });
  const fed = runBacktest(s, cfg(dates), market({ AAA: aaa, SPY: aaa }, { ripple: [hit({}), hit({ date: dates[6]!, confidence: "low" })] }));
  assert.equal(fed.trades.length, 1);
  assert.equal(fed.trades[0]!.entryDate, dates[3]);
});

test("a market filter reads another ticker's series", () => {
  const dates = weekdays("2024-01-01", 12);
  const aaa = makeBars(dates, [100, 100, 100, 110, 110, 110, 121, 121, 121, 121, 121, 121]);
  const spy = makeBars(dates, [100, 100, 100, 90, 90, 90, 99, 100, 101, 102, 103, 104]);
  const s = strategy({
    entry: {
      mode: "all",
      conditions: [
        { type: "n_day_return", ticker: null, days: 1, op: "above", pct: 5 },
        { type: "n_day_return", ticker: "SPY", days: 1, op: "above", pct: 0 },
      ],
    },
    exit: { conditions: [], stopLossPct: null, takeProfitPct: null, maxHoldingDays: 1 },
  });
  const r = runBacktest(s, cfg(dates), market({ AAA: aaa, SPY: spy }));
  // Day 3: AAA +10% but SPY -10%, no entry. Day 6: both up, entry at the open of day 7.
  assert.deepEqual(r.trades.map((t) => t.entryDate), [dates[7]]);
});

test("earnings of another company: trades the universe after the named ticker reports", () => {
  const dates = weekdays("2024-01-01", 15);
  const s = strategy({
    universe: ["BBB"],
    entry: { mode: "all", conditions: [{ type: "earnings_surprise", ticker: "AAA", op: "above", pct: 0, daysAfter: 1 }] },
    exit: { conditions: [], stopLossPct: null, takeProfitPct: null, maxHoldingDays: 2 },
  });
  const data = market(
    { BBB: makeBars(dates, flat(15)), AAA: makeBars(dates, flat(15)), SPY: makeBars(dates, flat(15)) },
    {
      earnings: {
        AAA: [{ date: "2024-01-03", time: "after_close", epsActual: 1.1, epsEstimate: 1, surprisePct: 10 }],
        BBB: [{ date: "2024-01-08", time: "after_close", epsActual: 1.1, epsEstimate: 1, surprisePct: 10 }],
      },
    },
  );
  const r = runBacktest(s, cfg(dates), data);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0]!.ticker, "BBB");
  assert.equal(r.trades[0]!.entryDate, "2024-01-04");
});
