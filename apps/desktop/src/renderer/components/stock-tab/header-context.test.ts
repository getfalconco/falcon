import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { heldContext } from "./header-context";
import type { RiskSnapshot } from "../../../shared/risk-types";

const book = {
  cash: 1_000,
  positions: {
    NVDA: { symbol: "NVDA", shares: 10, costUsd: 1_000 },
    AMD: { symbol: "AMD", shares: 20, costUsd: 2_000 },
    TSLA: { symbol: "TSLA", shares: -5, costUsd: -1_000 },
  },
};

function snapshot(over: Partial<RiskSnapshot> = {}): RiskSnapshot {
  return {
    schema_version: 1,
    computed_at: "2026-10-15T00:00:00.000Z",
    account: "paper",
    trigger: ["manual"],
    invested_fraction: 0.8,
    position_count: 3,
    score: 54,
    band: "moderate",
    components: null,
    driver: null,
    weights: [],
    blend_weights: { concentration: 0, market: 0, volatility: 0, network: 0, event: 0, sharpe: 0 },
    degraded: [],
    graph_version: null,
    empty: false,
    positions: [
      { ticker: "NVDA", side: "long", account_weight: 0.3, beta: 1.8, daily_vol_pct: 2.9, risk_share: 0.4417, earnings: null, correlation: null },
      { ticker: "AMD", side: "long", account_weight: 0.5, beta: 1.5, daily_vol_pct: 3.1, risk_share: 0.05, earnings: null, correlation: null },
    ],
    ...over,
  };
}

describe("held context", () => {
  it("is null for a name the book does not hold", () => {
    assert.equal(heldContext(book, "AAPL", 180, {}, snapshot()), null);
  });

  it("marks the position to the live price and weighs it by the shared definition", () => {
    const ctx = heldContext(book, "nvda", 150, { AMD: 100 }, snapshot())!;
    assert.equal(ctx.shares, 10);
    assert.equal(ctx.costUsd, 1_000);
    assert.equal(ctx.costPerShare, 100);
    assert.equal(ctx.pnlUsd, 500);
    assert.equal(ctx.pnlPct, 50);
    // 1500 / (1000 cash + 1500 + 2000 - 1000 carried at cost for TSLA) = 1500 / 3500
    assert.equal(ctx.weight, "42.9%");
    assert.equal(ctx.riskShare, "44%");
  });

  it("works for a position held the other way round", () => {
    const ctx = heldContext(book, "TSLA", 150, {}, snapshot())!;
    assert.equal(ctx.shares, -5);
    assert.equal(ctx.costUsd, 1_000);
    assert.equal(ctx.pnlUsd, 250);
    assert.equal(ctx.pnlPct, 25);
    assert.equal(ctx.riskShare, null);
  });

  it("leaves out what it cannot measure: no price, no P&L; no scored snapshot, no risk share", () => {
    const ctx = heldContext(book, "NVDA", null, {}, snapshot({ score: null }))!;
    assert.equal(ctx.pnlUsd, null);
    assert.equal(ctx.pnlPct, null);
    assert.equal(ctx.weight, "30.0%");
    assert.equal(ctx.riskShare, null);
    const bare = heldContext(book, "NVDA", null, {}, null)!;
    assert.equal(bare.weight, null);
    assert.equal(heldContext(book, "NVDA", 150, {}, snapshot({ empty: true }))!.riskShare, null);
  });
});
