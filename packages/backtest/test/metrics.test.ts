import test from "node:test";
import assert from "node:assert/strict";
import { cagrPct, curveMetrics, dailyReturns, maxDrawdownPct, sharpeRatio } from "../src/index";

test("max drawdown is the worst peak-to-trough fall", () => {
  assert.equal(maxDrawdownPct([100, 120, 90, 130, 65]), 50);
  assert.equal(maxDrawdownPct([1, 2, 3]), 0);
  assert.ok(Math.abs(maxDrawdownPct([100, 80, 120, 96]) - 20) < 1e-9);
});

test("sharpe: mean / sample std * sqrt(252), null without variation", () => {
  const s = sharpeRatio([0.01, 0.02, 0.03])!;
  assert.ok(Math.abs(s - 2 * Math.sqrt(252)) < 1e-9, String(s));
  assert.equal(sharpeRatio([0.01, -0.01, 0.01, -0.01]), 0);
  assert.equal(sharpeRatio([0.01, 0.01, 0.01]), null);
  assert.equal(sharpeRatio([0.01]), null);
});

test("cagr over calendar years", () => {
  const c = cagrPct(100, 121, "2020-01-01", "2022-01-01")!;
  assert.ok(Math.abs(c - 10) < 0.02, String(c));
  assert.equal(cagrPct(100, 0, "2020-01-01", "2021-01-01"), -100);
  assert.equal(cagrPct(100, 110, "2020-01-01", "2020-01-01"), null);
});

test("curve metrics on a known curve", () => {
  const m = curveMetrics([100, 110, 99, 121], ["2020-01-01", "2020-01-02", "2020-01-03", "2021-01-01"]);
  assert.ok(Math.abs(m.totalReturnPct - 21) < 1e-9);
  assert.ok(Math.abs(m.maxDrawdownPct - 10) < 1e-9);
  assert.deepEqual(dailyReturns([100, 110, 99]).map((r) => Math.round(r * 1e6) / 1e6), [0.1, -0.1]);
  assert.ok(m.volatilityPct! > 0);
});
