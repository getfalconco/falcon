import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { interpolateAnchors } from "./anchors.js";
import { sharpeComponent } from "./components.js";
import { alignReturns, portfolioReturns, sampleStd, sharpeOf, type RiskBar } from "./sharpe.js";
import type { RiskDegraded, RiskWeight } from "./types.js";
import { cfg, weightsOf } from "./test-fixtures.js";

const config = cfg();
const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

/** Closes that produce the given returns exactly enough for a 1e-9 check. */
function closesFrom(returns: number[], start = 100, from = 1): RiskBar[] {
  const bars: RiskBar[] = [{ d: `2026-03-${String(from).padStart(2, "0")}`, c: start }];
  let c = start;
  returns.forEach((r, i) => {
    c = c * (1 + r);
    bars.push({ d: `2026-03-${String(from + i + 1).padStart(2, "0")}`, c });
  });
  return bars;
}

describe("risk/sharpe — the ratio", () => {
  // r = [+2%, −1%, +1%, 0] × 2 → mean 0.005; deviations ±0.015, ±0.005;
  // Σd² = 0.001 over n−1 = 7 → sd = √(1/7000) = 0.011952286…
  const R = [0.02, -0.01, 0.01, 0, 0.02, -0.01, 0.01, 0];

  it("mean, sample sd and the annualisation are the textbook ones", () => {
    const sd = sampleStd(R)!;
    near(sd, Math.sqrt(0.001 / 7));
    const r = sharpeOf(R, { riskFreeAnnualPct: 0, tradingDaysPerYear: 252, minSessions: 4 });
    near(r.mean_daily, 0.005);
    near(r.sd_daily, sd);
    near(r.ann_return, 0.005 * 252);
    near(r.ann_vol, sd * Math.sqrt(252));
    near(r.sharpe!, (0.005 / sd) * Math.sqrt(252));
    assert.equal(r.sessions, 8);
  });

  it("the risk-free rate is subtracted daily, then annualised", () => {
    const sd = Math.sqrt(0.001 / 7);
    const r = sharpeOf(R, { riskFreeAnnualPct: 4, tradingDaysPerYear: 252, minSessions: 4 });
    near(r.sharpe!, ((0.005 - 0.04 / 252) / sd) * Math.sqrt(252));
    // A rate above the book's return turns it negative.
    const rich = sharpeOf(R, { riskFreeAnnualPct: 200, tradingDaysPerYear: 252, minSessions: 4 });
    assert.ok(rich.sharpe! < 0);
  });

  it("null below minSessions, and null when the series never moves", () => {
    assert.equal(sharpeOf(R, { riskFreeAnnualPct: 0, tradingDaysPerYear: 252, minSessions: 60 }).sharpe, null);
    const flat = sharpeOf([0.01, 0.01, 0.01, 0.01], { riskFreeAnnualPct: 0, tradingDaysPerYear: 252, minSessions: 2 });
    assert.equal(flat.sharpe, null);
    assert.equal(flat.sd_daily, 0);
    assert.equal(sampleStd([0.01]), null);
  });
});

describe("risk/sharpe — alignment", () => {
  it("uses only the sessions every ticker traded, newest `window` of them", () => {
    const bars = {
      AAA: [
        { d: "2026-03-01", c: 100 },
        { d: "2026-03-02", c: 101 },
        { d: "2026-03-03", c: 102 },
        { d: "2026-03-04", c: 103 },
      ],
      // BBB missing 03-02 entirely, and starts a day later.
      BBB: [
        { d: "2026-03-01", c: 50 },
        { d: "2026-03-03", c: 51 },
        { d: "2026-03-04", c: 52 },
      ],
    };
    const all = alignReturns(bars, ["AAA", "BBB"], 90);
    assert.deepEqual(all.dates, ["2026-03-03", "2026-03-04"]);
    near(all.byTicker.get("AAA")![0], 102 / 100 - 1); // spans the gap, not 102/101
    assert.equal(all.byTicker.get("BBB")!.length, 2);
    // window caps from the newest end.
    const capped = alignReturns(bars, ["AAA", "BBB"], 1);
    assert.deepEqual(capped.dates, ["2026-03-04"]);
  });

  it("a ticker with no usable history is excluded, not guessed at", () => {
    const aligned = alignReturns({ AAA: closesFrom([0.01, 0.01]), BBB: [{ d: "2026-03-01", c: 10 }] }, ["AAA", "BBB", "CCC"], 90);
    assert.deepEqual(aligned.excluded.sort(), ["BBB", "CCC"]);
    assert.ok(aligned.byTicker.has("AAA"));
  });
});

describe("risk/sharpe — portfolio series", () => {
  const weights: RiskWeight[] = [
    { ticker: "AAA", weight: 0.5, market_value: 1, side: "long" },
    { ticker: "BBB", weight: 0.5, market_value: 1, side: "long" },
  ];

  it("weights the tickers' returns, renormalising over the ones with history", () => {
    const aligned = alignReturns({ AAA: closesFrom([0.02, 0.02]), BBB: closesFrom([0, 0]) }, ["AAA", "BBB"], 90);
    const series = portfolioReturns(weights, aligned);
    near(series.returns[0], 0.01, 1e-12); // 50/50 of +2% and 0
    // BBB has no history at all → AAA carries the whole book, not half of it.
    const one = portfolioReturns(weights, alignReturns({ AAA: closesFrom([0.02, 0.02]) }, ["AAA", "BBB"], 90));
    near(one.returns[0], 0.02, 1e-12);
    assert.deepEqual(one.weights, [{ ticker: "AAA", weight: 1 }]);
  });

  it("a short position carries a negative weight", () => {
    const shorted: RiskWeight[] = [
      { ticker: "AAA", weight: 0.5, market_value: 1, side: "long" },
      { ticker: "BBB", weight: 0.5, market_value: 1, side: "short" },
    ];
    const aligned = alignReturns({ AAA: closesFrom([0.02, 0.02]), BBB: closesFrom([0.02, 0.02]) }, ["AAA", "BBB"], 90);
    near(portfolioReturns(shorted, aligned).returns[0], 0, 1e-12);
  });
});

describe("risk/sharpe — the component", () => {
  const weights = weightsOf([["AAA", 0.5], ["BBB", 0.5]]);
  /** 80 sessions of the same +2/−1/+1/0 pattern — clears minSessions 60. */
  const pattern = Array.from({ length: 80 }, (_, i) => [0.02, -0.01, 0.01, 0][i % 4]);

  it("scores off the anchor table, and carries the assumption it used", () => {
    const degraded: RiskDegraded[] = [];
    const bars = { AAA: closesFrom(pattern), BBB: closesFrom(pattern) };
    const payload = sharpeComponent(weights, bars, config, degraded);
    assert.equal(payload.sessions, 80);
    assert.equal(payload.risk_free_pct, 4);
    assert.ok(payload.sharpe! > 2.5);
    // Far above the last anchor → clamped to its score.
    assert.equal(payload.score, 10);
    assert.deepEqual(degraded, []);
    assert.deepEqual(payload.excluded, []);
  });

  it("anchors read the way the table says: 0 → 71, 1.0 → 38.3", () => {
    near(interpolateAnchors(config.anchors.sharpe, 0), 71);
    near(interpolateAnchors(config.anchors.sharpe, 1), 45 - (0.25 / 0.75) * 20);
    assert.equal(interpolateAnchors(config.anchors.sharpe, -5), 95);
    assert.equal(interpolateAnchors(config.anchors.sharpe, 9), 10);
  });

  it("a losing book scores worse than a winning one on the same volatility", () => {
    const up = Array.from({ length: 80 }, (_, i) => [0.02, -0.01, 0.01, 0][i % 4]);
    const down = up.map((r) => -r);
    const win = sharpeComponent(weights, { AAA: closesFrom(up), BBB: closesFrom(up) }, config, []);
    const lose = sharpeComponent(weights, { AAA: closesFrom(down), BBB: closesFrom(down) }, config, []);
    assert.ok(lose.sharpe! < 0 && win.sharpe! > 0);
    assert.ok(lose.score! > win.score!, `${lose.score} !> ${win.score}`);
  });

  it("thin history → no score, and it says so instead of inventing one", () => {
    const degraded: RiskDegraded[] = [];
    const payload = sharpeComponent(weights, { AAA: closesFrom([0.01, 0.01]), BBB: closesFrom([0.01, 0.01]) }, config, degraded);
    assert.equal(payload.score, null);
    assert.equal(payload.sharpe, null);
    assert.deepEqual(degraded, [{ ticker: "*", field: "sharpe", substitute: "2 sessions" }]);
  });

  it("a held name without history is dropped and recorded; the rest still score", () => {
    const degraded: RiskDegraded[] = [];
    const payload = sharpeComponent(weights, { AAA: closesFrom(pattern) }, config, degraded);
    assert.deepEqual(payload.excluded, ["BBB"]);
    assert.deepEqual(degraded, [{ ticker: "BBB", field: "history", substitute: "excluded" }]);
    assert.ok(payload.sharpe != null);
  });
});
