import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeRiskSnapshot } from "./compute.js";
import { RISK_SCHEMA_VERSION } from "./types.js";
import { NOW, account, cfg, inputs, position, quant } from "./test-fixtures.js";

const config = cfg();

describe("risk/compute — snapshot", () => {
  it("no positions → empty snapshot, no score, no components", () => {
    const s = computeRiskSnapshot(inputs({ account: account([], 10_000) }), config, { trigger: ["startup"] });
    assert.equal(s.empty, true);
    assert.equal(s.score, null);
    assert.equal(s.band, null);
    assert.equal(s.components, null);
    assert.equal(s.driver, null);
    assert.equal(s.position_count, 0);
    assert.equal(s.invested_fraction, 0);
    assert.deepEqual(s.trigger, ["startup"]);
    assert.equal(s.schema_version, RISK_SCHEMA_VERSION);
    assert.equal(s.computed_at, NOW);
  });

  it("NVDA+TSM critical-link book: hand-computed components, blend, band, driver", () => {
    const s = computeRiskSnapshot(
      inputs({
        account: account([position("NVDA", 10, 1800), position("TSM", 20, 1900)], 1000),
        quant: {
          NVDA: quant({ beta: 2, daily_vol: 0.03, earnings_rhythm: 0.1, last_price: 200 }),
          TSM: quant({ beta: 1, daily_vol: 0.02, last_price: 100 }),
        },
        spy_daily_vol: 0.01,
        live: {
          open_incidents: [{ ticker: "NVDA", band: "P1", incident_id: "i1" }],
          anomalies: [],
          earnings: [{ ticker: "NVDA", due_at: "2026-08-26T20:00:00.000Z", sessions_until: 2, fiscal_period: "Q2 2027" }],
        },
      }),
      config,
      { trigger: ["manual"] },
    );
    assert.equal(s.empty, false);
    assert.equal(s.position_count, 2);
    assert.equal(s.invested_fraction, 0.8);
    const c = s.components!;
    // concentration: HHI 0.5 → 95
    assert.equal(c.concentration.score, 95);
    // market: β_port 1.5 × 0.8 = 1.2 → 55
    assert.equal(c.market.beta_eff, 1.2);
    assert.equal(c.market.score, 55);
    // volatility: systematic (1.5·0.01)² = 2.25e-4; idio NVDA .25×(9e-4−4e-4)=1.25e-4, TSM .25×(4e-4−1e-4)=0.75e-4 → 4.25e-4 → 2.062% → 45+0.562×25=59.05 → 59
    assert.equal(c.volatility.port_vol_daily_pct, 2.062);
    assert.equal(c.volatility.score, 59);
    // network: critical direct link, equal weights → 1.0 → 90
    assert.equal(c.network.score, 90);
    assert.equal(c.network.top_links[0].edge_id, "NVDA:TSM:supplier:wafer:0");
    // event: NVDA .5 × (15 + 20) = 17.5 → 58.75 → 59
    assert.equal(c.event.raw, 17.5);
    assert.equal(c.event.score, 59);
    // blend: 95×.2 + 55×.2 + 59×.2 + 90×.25 + 59×.15 = 19+11+11.8+22.5+8.85 = 73.15 → 73 → elevated
    assert.equal(s.score, 73);
    assert.equal(s.band, "elevated");
    assert.equal(s.driver?.component, "network");
    assert.equal(s.driver?.sentence, "NVDA and TSM share critical supply-chain exposure.");
    // No bars in this fixture, so Sharpe cannot be measured and says so.
    assert.deepEqual(s.degraded, [
      { ticker: "*", field: "sharpe", substitute: "0 sessions" },
      { ticker: "NVDA", field: "history", substitute: "excluded" },
      { ticker: "TSM", field: "history", substitute: "excluded" },
    ]);
    assert.equal(s.components!.sharpe.score, null);
    // Sharpe out of the blend, so the other five renormalise over .88.
    assert.ok(Math.abs(s.blend_weights.network - 0.22 / 0.88) < 1e-12);
    assert.equal(s.blend_weights.sharpe, 0);
    assert.deepEqual(s.graph_version, { generatedAt: "2026-08-22T00:00:00.000Z", pipelineVersion: 5 });
    assert.deepEqual(
      s.weights.map((w) => [w.ticker, w.weight, w.market_value]),
      [
        ["NVDA", 0.5, 2000],
        ["TSM", 0.5, 2000],
      ],
    );
  });

  it("single position: concentration 95, network 5, driver concentration", () => {
    const s = computeRiskSnapshot(inputs({ account: account([position("NVDA", 5, 1000)]), quant: { NVDA: quant({ last_price: 200 }) } }), config);
    const c = s.components!;
    assert.equal(c.concentration.score, 95);
    assert.equal(c.network.score, 5);
    assert.equal(s.invested_fraction, 1);
    assert.equal(s.driver?.component, "concentration");
    assert.equal(s.driver?.sentence, "100% of the portfolio sits in NVDA.");
  });

  it("degraded: null β and null vol substitute and are recorded; an unknown ticker is priced at cost basis and excluded from the graph", () => {
    const s = computeRiskSnapshot(
      inputs({
        account: account([position("ZLAB", 10, 250), position("NVDA", 1, 200)]),
        quant: { ZLAB: quant({ beta: null, daily_vol: null, last_price: 25 }), NVDA: quant({ last_price: 200 }) },
        universe_median_vol: 0.025,
        live: { open_incidents: [], anomalies: [], earnings: [] },
      }),
      config,
    );
    assert.equal(s.empty, false);
    assert.ok(typeof s.score === "number");
    assert.deepEqual(s.degraded, [
      { ticker: "*", field: "sharpe", substitute: "0 sessions" },
      { ticker: "NVDA", field: "history", substitute: "excluded" },
      { ticker: "ZLAB", field: "beta", substitute: 1 },
      { ticker: "ZLAB", field: "graph", substitute: "excluded" }, // not in the synthetic graph
      { ticker: "ZLAB", field: "history", substitute: "excluded" },
      { ticker: "ZLAB", field: "vol", substitute: 0.025 },
    ]);
    // ZLAB is not in the synthetic graph → excluded from pairs
    const t = computeRiskSnapshot(
      inputs({
        account: account([position("ZLAB", 10, 250), position("NVDA", 1, 200)]),
        quant: { NVDA: quant({ last_price: 200 }) },
        graph: inputs().graph,
      }),
      config,
    );
    assert.ok(t.degraded.some((d) => d.ticker === "ZLAB" && d.field === "graph" && d.substitute === "excluded"));
    assert.ok(t.degraded.some((d) => d.ticker === "ZLAB" && d.field === "price" && d.substitute === "cost_basis"));
    assert.ok(t.degraded.some((d) => d.ticker === "ZLAB" && d.field === "quant"));
    assert.equal(t.components!.network.score, 5);
  });

  it("no trigger → manual; trigger list is preserved as given", () => {
    assert.deepEqual(computeRiskSnapshot(inputs(), config).trigger, ["manual"]);
    assert.deepEqual(computeRiskSnapshot(inputs(), config, { trigger: ["close_run", "band_change"] }).trigger, ["close_run", "band_change"]);
  });

  it("is deterministic: same inputs → identical snapshot", () => {
    const i = inputs({ account: account([position("NVDA", 1, 100), position("TSM", 1, 100)]), quant: { NVDA: quant(), TSM: quant() } });
    assert.deepEqual(computeRiskSnapshot(i, config), computeRiskSnapshot(i, config));
  });
});
