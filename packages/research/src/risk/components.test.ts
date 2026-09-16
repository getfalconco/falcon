import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildWeights,
  concentrationComponent,
  eventComponent,
  marketComponent,
  networkComponent,
  resolveBetas,
  volatilityComponent,
} from "./components.js";
import type { RiskDegraded } from "./types.js";
import { EMPTY_LIVE, account, cfg, position, quant, syntheticGraph, weightsOf } from "./test-fixtures.js";

const config = cfg();

describe("risk/components — weights", () => {
  it("values positions at Tracker last price, weights over invested value, invested_fraction over cash", () => {
    const r = buildWeights(account([position("NVDA", 10, 2000), position("TSM", 20, 3000)], 1000), {
      NVDA: quant({ last_price: 200 }), // 2000
      TSM: quant({ last_price: 100 }), // 2000
    });
    assert.equal(r.invested, 4000);
    assert.equal(r.invested_fraction, 0.8);
    assert.deepEqual(
      r.weights.map((w) => [w.ticker, w.weight, w.market_value, w.side]),
      [
        ["NVDA", 0.5, 2000, "long"],
        ["TSM", 0.5, 2000, "long"],
      ],
    );
    assert.equal(r.degraded.length, 0);
  });

  it("prefers a caller-supplied market value, falls back to cost basis (degraded) and skips flat positions", () => {
    const r = buildWeights(account([position("AAA", 1, 100, 900), position("BBB", -2, -50), position("CCC", 0, 0)]), { AAA: quant({ last_price: 5 }) });
    assert.deepEqual(
      r.weights.map((w) => [w.ticker, w.weight, w.side]),
      [
        ["AAA", 900 / 950, "long"],
        ["BBB", 50 / 950, "short"],
      ],
    );
    assert.deepEqual(r.degraded, [{ ticker: "BBB", field: "price", substitute: "cost_basis" }]);
  });

  it("an empty account has no weights and invested_fraction 0", () => {
    const r = buildWeights(account([], 5000), {});
    assert.equal(r.weights.length, 0);
    assert.equal(r.invested_fraction, 0);
  });
});

describe("risk/components — 3.1 concentration", () => {
  it("single position → HHI 1 → 95 (clamped)", () => {
    const c = concentrationComponent(weightsOf([["NVDA", 1]]), config);
    assert.equal(c.hhi, 1);
    assert.equal(c.score, 95);
    assert.deepEqual(c.top, [{ ticker: "NVDA", weight: 1 }]);
  });

  it("four equal → HHI 0.25 → 62.7 (between 0.2→55 and 0.33→75)", () => {
    const c = concentrationComponent(weightsOf([["A", 0.25], ["B", 0.25], ["C", 0.25], ["D", 0.25]]), config);
    assert.equal(c.hhi, 0.25);
    const expected = 55 + ((0.25 - 0.2) / (0.33 - 0.2)) * 20;
    assert.ok(Math.abs(c.score - expected) < 1e-9);
  });

  it("twenty equal → HHI 0.05 → 10", () => {
    const c = concentrationComponent(weightsOf(Array.from({ length: 20 }, (_, i) => [`T${i}`, 0.05] as [string, number])), config);
    assert.ok(Math.abs(c.hhi - 0.05) < 1e-9);
    assert.ok(Math.abs(c.score - 10) < 1e-9);
  });
});

describe("risk/components — 3.2 market sensitivity", () => {
  it("β_eff = Σ w β × invested_fraction, interpolated (1.2 → 55)", () => {
    const weights = weightsOf([["NVDA", 0.5], ["TSM", 0.5]]);
    const degraded: RiskDegraded[] = [];
    const betas = resolveBetas(weights, { NVDA: quant({ beta: 2 }), TSM: quant({ beta: 1 }) }, config, degraded);
    const m = marketComponent(weights, betas, 0.8, config);
    assert.equal(m.beta_port, 1.5);
    assert.equal(m.beta_eff, 1.2);
    assert.ok(Math.abs(m.score - 55) < 1e-9);
    assert.equal(degraded.length, 0);
  });

  it("null β → substitute 1.0 with a degraded entry; missing quant → field quant", () => {
    const weights = weightsOf([["AAA", 0.5], ["BBB", 0.5]]);
    const degraded: RiskDegraded[] = [];
    const betas = resolveBetas(weights, { AAA: quant({ beta: null }) }, config, degraded);
    assert.equal(betas.get("AAA"), 1);
    assert.equal(betas.get("BBB"), 1);
    assert.deepEqual(degraded, [
      { ticker: "AAA", field: "beta", substitute: 1 },
      { ticker: "BBB", field: "quant", substitute: 1 },
    ]);
    const m = marketComponent(weights, betas, 1, config);
    assert.equal(m.beta_eff, 1);
    assert.equal(m.score, 45);
  });

  it("a short position offsets beta", () => {
    const weights = [
      { ticker: "A", weight: 0.5, market_value: 1, side: "long" as const },
      { ticker: "B", weight: 0.5, market_value: 1, side: "short" as const },
    ];
    const betas = new Map([
      ["A", 1],
      ["B", 1],
    ]);
    const m = marketComponent(weights, betas, 1, config);
    assert.equal(m.beta_eff, 0);
    assert.equal(m.score, 15);
  });
});

describe("risk/components — 3.3 volatility", () => {
  it("single name β=1 σ=2% σ_SPY=1% → σ_p = 2.0% → 57.5", () => {
    const weights = weightsOf([["A", 1]]);
    const degraded: RiskDegraded[] = [];
    const v = volatilityComponent(weights, new Map([["A", 1]]), { A: quant({ beta: 1, daily_vol: 0.02 }) }, { spyVol: 0.01, universeMedianVol: 0.02 }, config, degraded);
    assert.equal(v.port_vol_daily_pct, 2);
    assert.equal(v.systematic_share, 0.25);
    assert.ok(Math.abs(v.score - 57.5) < 1e-9);
    assert.equal(degraded.length, 0);
  });

  it("two equal names, β=1 each, σ=2%: idio diversifies, systematic does not", () => {
    const weights = weightsOf([["A", 0.5], ["B", 0.5]]);
    const betas = new Map([
      ["A", 1],
      ["B", 1],
    ]);
    const q = { A: quant({ daily_vol: 0.02 }), B: quant({ daily_vol: 0.02 }) };
    const v = volatilityComponent(weights, betas, q, { spyVol: 0.01, universeMedianVol: 0.02 }, config, []);
    // systematic (1·0.01)² = 1e-4; idio 2 × 0.25 × 3e-4 = 1.5e-4 → σ_p = sqrt(2.5e-4) = 1.581%
    assert.ok(Math.abs(v.port_vol_daily_pct - 1.581) < 0.001);
  });

  it("null vol → universe median (degraded); null SPY vol → substitute (degraded)", () => {
    const weights = weightsOf([["A", 1]]);
    const degraded: RiskDegraded[] = [];
    const v = volatilityComponent(weights, new Map([["A", 1]]), { A: quant({ daily_vol: null }) }, { spyVol: null, universeMedianVol: 0.03 }, config, degraded);
    assert.deepEqual(degraded, [
      { ticker: "SPY", field: "spy_vol", substitute: 0.01 },
      { ticker: "A", field: "vol", substitute: 0.03 },
    ]);
    assert.equal(v.port_vol_daily_pct, 3);
    assert.ok(v.score > 0);
  });
});

describe("risk/components — 3.4 network (wrapper)", () => {
  it("records graph-excluded tickers as degraded and scores the rest", () => {
    const degraded: RiskDegraded[] = [];
    const n = networkComponent(weightsOf([["NVDA", 0.4], ["TSM", 0.4], ["CCC", 0.2]]), syntheticGraph(), config, degraded);
    assert.deepEqual(degraded, [{ ticker: "CCC", field: "graph", substitute: "excluded" }]);
    assert.equal(n.excluded.length, 1);
    assert.equal(n.pair_count, 1);
    assert.equal(n.linked_fraction, 1);
    assert.equal(n.score, 90);
  });

  it("no graph → every ticker excluded, score 5", () => {
    const degraded: RiskDegraded[] = [];
    const n = networkComponent(weightsOf([["NVDA", 0.5], ["TSM", 0.5]]), null, config, degraded);
    assert.equal(n.score, 5);
    assert.equal(degraded.length, 2);
  });
});

describe("risk/components — 3.5 live event risk", () => {
  const weights = weightsOf([["NVDA", 0.5], ["TSM", 0.5]]);

  it("P1 incident + earnings in 2 sessions at 2× rhythm → raw 17.5 → 58.75", () => {
    const e = eventComponent(
      weights,
      {
        open_incidents: [
          { ticker: "NVDA", band: "P2", incident_id: "a" },
          { ticker: "NVDA", band: "P1", incident_id: "b" }, // highest band only
        ],
        anomalies: [],
        earnings: [{ ticker: "NVDA", due_at: "2026-08-26T20:00:00.000Z", sessions_until: 2, fiscal_period: "Q2" }],
      },
      { NVDA: quant({ earnings_rhythm: 0.1 }) },
      config,
    );
    assert.equal(e.raw, 17.5);
    assert.ok(Math.abs(e.score - 58.75) < 1e-9);
    assert.deepEqual(
      e.contributors.map((c) => [c.ticker, c.kind, c.detail, c.contribution, c.weighted]),
      [
        ["NVDA", "earnings_window", "2 sessions", 20, 10],
        ["NVDA", "incident", "P1", 15, 7.5],
      ],
    );
  });

  it("anomaly states add per kind; rhythm null → factor 1; outside horizon ignored; unheld ignored", () => {
    const e = eventComponent(
      weights,
      {
        open_incidents: [{ ticker: "AMD", band: "P0", incident_id: "x" }],
        anomalies: [
          { ticker: "TSM", kind: "drift" },
          { ticker: "TSM", kind: "drift" },
          { ticker: "NVDA", kind: "insider_cluster" },
        ],
        earnings: [
          { ticker: "TSM", due_at: "2026-09-10T00:00:00.000Z", sessions_until: 9, fiscal_period: null },
          { ticker: "NVDA", due_at: "2026-08-24T20:00:00.000Z", sessions_until: 0, fiscal_period: null },
        ],
      },
      { NVDA: quant({ earnings_rhythm: null }), TSM: quant() },
      config,
    );
    // NVDA: insider 8 + earnings 10 → 18 × 0.5 = 9; TSM drift 4 × 0.5 = 2 → raw 11
    assert.equal(e.raw, 11);
    assert.equal(e.contributors.find((c) => c.kind === "earnings_window")?.detail, "today");
    assert.equal(e.contributors.filter((c) => c.kind === "drift").length, 1);
    assert.ok(!e.contributors.some((c) => c.ticker === "AMD"));
  });

  it("nothing live → raw 0 → 5", () => {
    const e = eventComponent(weights, EMPTY_LIVE, {}, config);
    assert.equal(e.raw, 0);
    assert.equal(e.score, 5);
  });
});
