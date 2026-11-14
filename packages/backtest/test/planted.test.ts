import test from "node:test";
import assert from "node:assert/strict";
import { blankSpec, runChecked, validateSpec, type RunResultV2, type StrategySpecV2 } from "../src/index";
import type { Bar } from "../src/data/types";
import { rng } from "../src/util";
import { sessions, specData, walkBars } from "./v2-helpers";

const dates = sessions("2015-01-01", 2000);
const NOW = new Date(`${dates.at(-1)}T21:00:00Z`);
const period = { start: dates[300]!, end: dates.at(-1)! };

function rules(entry: string, tickers: string[], over: Partial<StrategySpecV2> = {}, port: Record<string, unknown> = {}): StrategySpecV2 {
  return {
    ...blankSpec(),
    params: {},
    universe: { kind: "static", tickers },
    portfolio: { mode: "rules", entry, exit: null, max_positions: tickers.length, clock: "close", reentry: "edge", tiebreak: "seeded", sizing: "equal", ...port } as StrategySpecV2["portfolio"],
    period,
    ...over,
  };
}

function run(spec: StrategySpecV2, bars: Record<string, Bar[]>): RunResultV2 {
  const c = validateSpec(spec, NOW);
  assert.ok(c.ok, c.ok ? "" : JSON.stringify(c.issues));
  return runChecked(c as never, { data: specData(bars), now: NOW });
}

const status = (r: RunResultV2, id: number) => r.quality.checks.filter((c) => c.id === id).map((c) => c.status);
const flagged = (r: RunResultV2, id: number) => r.quality.flags.some((f) => f.check_id === id);

test("planted bug: a 7-trade wonder gets Insufficient sample (check 6)", () => {
  const spy = walkBars(dates, 1, { volume: 9e7 });
  const aaa = walkBars(dates, 2, { volume: 2e7 });
  // Seven big jumps, each followed by a run-up.
  for (const k of [400, 600, 800, 1000, 1200, 1400, 1600]) {
    for (let j = 0; j < 10; j++) {
      const f = j === 0 ? 1.12 : 1.01;
      for (let q = k + j; q < aaa.length; q++) {
        const b = aaa[q]!;
        aaa[q] = { ...b, open: b.open * f, high: b.high * f, low: b.low * f, close: b.close * f, rawClose: b.close * f };
      }
    }
  }
  const r = run(rules("ret(close, 1) > 0.1", ["AAA"], { risk: { stop_pct: null, trailing_pct: null, take_profit_pct: null, max_hold_days: 10 } }), { SPY: spy, AAA: aaa });
  assert.ok(r.trades.length <= 10, `trades ${r.trades.length}`);
  assert.deepEqual(status(r, 6), ["warn"]);
  assert.equal(r.quality.label.level, "insufficient");
  assert.ok(flagged(r, 6));
});

test("planted bug: a cost-sensitive scalp trips the costs check (check 9)", () => {
  const spy = walkBars(dates, 3, { volume: 9e7 });
  // Mean reversion that pays a little after a down close: about 15 bp gross per trade, daily trading.
  const r0 = rng(7);
  const out: Bar[] = [];
  let px = 40;
  for (const date of dates) {
    const prevDown = out.length > 1 && out[out.length - 1]!.close < out[out.length - 2]!.close;
    const open = px * (prevDown ? 1.0015 : 0.9995);
    const close = open * (1 + (r0() - 0.5) * 0.02);
    const vol = 400_000;
    out.push({ date, open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, close, volume: vol, rawClose: close, dollarVolume: close * vol });
    px = close;
  }
  const r = run(rules("close < delay(close, 1)", ["SCALP"], { risk: { stop_pct: null, trailing_pct: null, take_profit_pct: null, max_hold_days: 1 } }), { SPY: spy, SCALP: out });
  assert.ok(r.trades.length > 300);
  assert.deepEqual(status(r, 9), ["warn"]);
  assert.ok(flagged(r, 9));
});

test("planted bug: one ticker makes the P&L (check 12)", () => {
  const bars: Record<string, Bar[]> = { SPY: walkBars(dates, 4, { volume: 9e7 }) };
  ["AAA", "BBB", "CCC", "DDD"].forEach((t, i) => (bars[t] = walkBars(dates, 30 + i, { drift: 0, vol: 0.01, volume: 3e7 })));
  bars.ROCKET = walkBars(dates, 40, { drift: 0.003, vol: 0.01, volume: 3e7 });
  const r = run(rules("close > ts_mean(close, 50)", ["AAA", "BBB", "CCC", "DDD", "ROCKET"], {}, { exit: "close < ts_mean(close, 50)" }), bars);
  assert.deepEqual(status(r, 12), ["warn"]);
  assert.equal(r.quality.values.concentration!.top_ticker, "ROCKET");
});

test("planted bug: a hindsight list typed today trips check 14; a bad tick trips check 5", () => {
  const bars: Record<string, Bar[]> = { SPY: walkBars(dates, 5, { volume: 9e7 }), NVDA: walkBars(dates, 6, { drift: 0.002 }), AVGO: walkBars(dates, 7, { drift: 0.0015 }) };
  const b = bars.AVGO![900]!;
  bars.AVGO![900] = { ...b, close: b.close * 1.8, high: b.close * 1.8 };
  const r = run(rules("close > ts_mean(close, 100)", ["NVDA", "AVGO"], {}, { exit: "close < ts_mean(close, 100)" }), bars);
  assert.deepEqual(status(r, 14), ["warn"]);
  assert.deepEqual(status(r, 5), ["warn"]);
  // Flag texts are deterministic templates: information, no advice words, no em dashes.
  for (const f of r.quality.flags) assert.ok(!/should|buy now|sell now|—/i.test(f.text), f.text);
});

test("weights mode: 60/40 has no timing claim; the evidence label and checks still render", () => {
  const bars = { SPY: walkBars(dates, 8, { volume: 9e7 }), TLT: walkBars(dates, 9, { drift: 0.0001, volume: 3e7 }) };
  const spec: StrategySpecV2 = { ...blankSpec(), params: {}, universe: { kind: "static", tickers: ["SPY", "TLT"] }, portfolio: { mode: "weights", weights: { SPY: "0.6", TLT: "0.4" } }, rebalance: "quarterly", period };
  const r = run(spec, bars);
  assert.ok(r.quality.checks.find((c) => c.id === 7)!.detail.includes("allocation, no timing claim"));
  assert.ok(r.trades.length >= 2);
  assert.ok(["insufficient", "thin", "some", "consistent"].includes(r.quality.label.level));
});
