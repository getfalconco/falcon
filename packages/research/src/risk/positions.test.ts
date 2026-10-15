import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeRiskSnapshot } from "./compute.js";
import { pearson } from "./positions.js";
import { account, barSeries, cfg, inputs, position, quant } from "./test-fixtures.js";

const config = cfg();

/** The compute test's NVDA+TSM book: 2,000 each at the Tracker's prices, 1,000 cash. */
function book(overrides: Parameters<typeof inputs>[0] = {}) {
  return computeRiskSnapshot(
    inputs({
      account: account([position("NVDA", 10, 1800), position("TSM", 20, 1900)], 1000),
      quant: {
        NVDA: quant({ beta: 2, daily_vol: 0.03, last_price: 200 }),
        TSM: quant({ beta: 1, daily_vol: 0.02, last_price: 100 }),
      },
      spy_daily_vol: 0.01,
      live: {
        open_incidents: [],
        anomalies: [],
        earnings: [
          { ticker: "NVDA", due_at: "2026-08-26T20:00:00.000Z", sessions_until: 2, fiscal_period: "Q2 2027" },
          { ticker: "TSM", due_at: "2026-09-30T20:00:00.000Z", sessions_until: 26, fiscal_period: null },
        ],
      },
      ...overrides,
    }),
    config,
  );
}

describe("risk/positions — per-position read", () => {
  it("hand-computed Euler shares sum to the portfolio variance", () => {
    const s = book();
    const [nvda, tsm] = s.positions!;
    // β_p = 1.5, σ_m = 1%: NVDA .5 × (2·1.5·1e-4 + .5·5e-4) = 2.75e-4,
    // TSM .5 × (1·1.5e-4 + .5·3e-4) = 1.5e-4; σ_p² = 4.25e-4 (the vol component's).
    assert.equal(nvda.ticker, "NVDA");
    assert.equal(nvda.risk_share, 0.6471);
    assert.equal(tsm.risk_share, 0.3529);
    assert.equal(s.components!.volatility.port_vol_daily_pct, 2.062);
  });

  it("carries the Tracker's own beta and vol, the account weight and earnings inside the horizon only", () => {
    const [nvda, tsm] = book().positions!;
    assert.equal(nvda.beta, 2);
    assert.equal(nvda.daily_vol_pct, 3);
    // 2,000 of a 5,000 account (cash included), as the Positions card prints it.
    assert.equal(nvda.account_weight, 0.4);
    assert.deepEqual(nvda.earnings, { due_at: "2026-08-26T20:00:00.000Z", sessions_until: 2 });
    assert.equal(tsm.earnings, null, "26 sessions out is past the 5-session horizon");
  });

  it("never reports a substitute as the name's own beta or vol", () => {
    const s = book({ quant: { NVDA: quant({ beta: null, daily_vol: null, last_price: 200 }), TSM: quant({ beta: 1, daily_vol: 0.02, last_price: 100 }) } });
    const nvda = s.positions!.find((p) => p.ticker === "NVDA")!;
    assert.equal(nvda.beta, null);
    assert.equal(nvda.daily_vol_pct, null);
    // The blend still ran on the substitutes, so the share is still there.
    assert.equal(typeof nvda.risk_share, "number");
    const total = s.positions!.reduce((sum, p) => sum + (p.risk_share ?? 0), 0);
    assert.ok(Math.abs(total - 1) < 1e-3);
  });

  it("a short that offsets the book takes a negative share", () => {
    const s = computeRiskSnapshot(
      inputs({
        account: account([position("NVDA", 20, 3600), position("TSM", -10, -900)], 0),
        quant: { NVDA: quant({ beta: 1.5, daily_vol: 0.03, last_price: 200 }), TSM: quant({ beta: 1.2, daily_vol: 0.02, last_price: 100 }) },
        spy_daily_vol: 0.01,
      }),
      config,
    );
    const tsm = s.positions!.find((p) => p.ticker === "TSM")!;
    assert.equal(tsm.side, "short");
    assert.ok(tsm.risk_share! < 0);
    assert.ok(tsm.account_weight! < 0);
  });

  it("correlation with the largest holding, from the closes both traded", () => {
    const same = barSeries(40, { wigglePct: 1.5, driftPct: 0.1 });
    const mirrored = same.map((b, i) => ({ d: b.d, c: i === 0 ? 100 : 100 * (same[i].c / same[0].c) ** -1 }));
    const s = book({
      account: account([position("NVDA", 15, 1800), position("TSM", 20, 1900), position("AMD", 5, 400)], 1000),
      quant: {
        NVDA: quant({ beta: 2, daily_vol: 0.03, last_price: 200 }),
        TSM: quant({ beta: 1, daily_vol: 0.02, last_price: 100 }),
        AMD: quant({ beta: 1.6, daily_vol: 0.03, last_price: 100 }),
      },
      bars: { NVDA: same, TSM: same, AMD: mirrored },
    });
    const byTicker = new Map(s.positions!.map((p) => [p.ticker, p]));
    assert.equal(s.weights[0].ticker, "NVDA");
    assert.equal(byTicker.get("NVDA")!.correlation, null, "the largest holding has no line against itself");
    assert.deepEqual(byTicker.get("TSM")!.correlation, { ticker: "NVDA", value: 1, sessions: 39 });
    assert.ok(byTicker.get("AMD")!.correlation!.value < -0.9);
  });

  it("too few aligned sessions: no correlation", () => {
    const short = barSeries(10, { wigglePct: 1 });
    const s = book({ bars: { NVDA: short, TSM: short } });
    assert.equal(s.positions!.find((p) => p.ticker === "TSM")!.correlation, null);
  });

  it("an empty book carries no positions", () => {
    const s = computeRiskSnapshot(inputs({ account: account([], 5000) }), config);
    assert.equal(s.positions, undefined);
  });

  it("pearson: flat series read as null, not zero", () => {
    assert.equal(pearson([1, 1, 1], [1, 2, 3]), null);
    assert.equal(pearson([1, 2, 3], [2, 4, 6]), 1);
  });
});
