import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accountValue,
  accountWeight,
  accountWeights,
  bookWeights,
  formatWeightPct,
  positionMarketValue,
  weightPercent,
} from "./weights.js";

describe("portfolio/weights — market value", () => {
  it("prices at the print, signed by the shares", () => {
    assert.equal(positionMarketValue(4, 2000, 620), 2480);
    assert.equal(positionMarketValue(-10, -3000, 250), -2500);
  });

  it("falls back to the cost basis, given the sign of the shares, with no usable print", () => {
    assert.equal(positionMarketValue(4, 2000, null), 2000);
    assert.equal(positionMarketValue(4, 2000, 0), 2000);
    assert.equal(positionMarketValue(4, 2000, Number.NaN), 2000);
    // An unsigned basis on a borrowed position stays a short.
    assert.equal(positionMarketValue(-10, 3000, undefined), -3000);
  });
});

describe("portfolio/weights — account weights", () => {
  it("a book with cash: weight over cash + positions, and the lines sum to 100%", () => {
    const w = accountWeights(2_000, [
      { ticker: "lly", market_value: 2_480 },
      { ticker: "AAA", market_value: 5_520 },
    ]);
    assert.equal(w.total, 10_000);
    assert.deepEqual(
      w.positions.map((p) => [p.ticker, p.weight]),
      [
        ["AAA", 0.552],
        ["LLY", 0.248],
      ],
    );
    assert.equal(w.cash_weight, 0.2);
    const sum = w.positions.reduce((s, p) => s + (p.weight ?? 0), 0) + (w.cash_weight ?? 0);
    assert.ok(Math.abs(sum - 1) < 1e-12);
  });

  it("no cash: the account is the holdings", () => {
    const w = accountWeights(0, [
      { ticker: "LLY", market_value: 3_000 },
      { ticker: "AAA", market_value: 1_000 },
    ]);
    assert.equal(w.positions[0].weight, 0.75);
    assert.equal(w.cash_weight, 0);
  });

  it("negative cash (margin) shrinks the account, so a holding can be more than all of it", () => {
    const w = accountWeights(-2_000, [{ ticker: "LLY", market_value: 10_000 }]);
    assert.equal(w.total, 8_000);
    assert.equal(w.positions[0].weight, 1.25);
    assert.equal(w.cash_weight, -0.25);
  });

  it("a short is a negative weight; its proceeds sit in cash", () => {
    const w = accountWeights(12_000, [
      { ticker: "TSLA", market_value: -2_000 },
      { ticker: "LLY", market_value: 1_000 },
    ]);
    assert.equal(w.total, 11_000);
    assert.equal(w.positions[0].ticker, "TSLA");
    assert.equal(w.positions[0].weight, -2_000 / 11_000);
  });

  it("a zero or negative account has no weights", () => {
    const zero = accountWeights(-1_000, [{ ticker: "LLY", market_value: 1_000 }]);
    assert.equal(zero.total, 0);
    assert.equal(zero.positions[0].weight, null);
    assert.equal(zero.cash_weight, null);
    assert.equal(accountWeight(500, -10), null);
    assert.equal(accountWeights(0, []).cash_weight, null);
  });

  it("duplicate tickers merge; non-finite inputs count as nothing", () => {
    const w = accountWeights(Number.NaN, [
      { ticker: "LLY", market_value: 500 },
      { ticker: " lly ", market_value: 500 },
      { ticker: "BAD", market_value: Number.POSITIVE_INFINITY },
    ]);
    assert.deepEqual(w.positions, [{ ticker: "LLY", market_value: 1_000, weight: 1 }]);
    assert.equal(accountValue(100, [1, Number.NaN, 2]), 103);
  });

  it("bookWeights values holdings at the given prints, cost where there is none", () => {
    const w = bookWeights(
      7_000,
      [
        { ticker: "LLY", shares: 4, cost_usd: 2_000 },
        { ticker: "XOM", shares: 4, cost_usd: 520 },
      ],
      (t) => (t === "LLY" ? 620 : null),
    );
    assert.equal(w.total, 10_000);
    assert.equal(w.positions[0].weight, 0.248);
  });
});

describe("portfolio/weights — printing", () => {
  it("one decimal, no negative zero, null for no weight", () => {
    assert.equal(formatWeightPct(0.248), "24.8%");
    assert.equal(formatWeightPct(0.24849), "24.8%");
    assert.equal(formatWeightPct(-0.1), "-10.0%");
    assert.equal(formatWeightPct(-0.00001), "0.0%");
    assert.equal(formatWeightPct(null), null);
    assert.equal(weightPercent(1), "100.0");
  });
});
