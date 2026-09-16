import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { componentPayload, riskPanelRows } from "./risk-panel-rows.js";
import type { RiskSnapshot } from "./risk-types.js";

/** A snapshot as the store held them before §3.6 existed: five components. */
const LEGACY = {
  schema_version: 1,
  computed_at: "2026-08-25T20:45:00.088Z",
  account: "paper",
  trigger: ["close_run"],
  invested_fraction: 0.62,
  position_count: 5,
  score: 36,
  band: "moderate",
  components: {
    concentration: { score: 71, hhi: 0.3045, top: [{ ticker: "NVDA", weight: 0.49 }] },
    market: { score: 36, beta_eff: 0.848, beta_port: 1.35 },
    volatility: { score: 52, port_vol_daily_pct: 1.777, spy_vol_daily_pct: 0.64, systematic_share: 0.23 },
    network: { score: 5, linked_fraction: 0, pair_count: 10, excluded: [], top_links: [] },
    event: { score: 16, raw: 3.23, contributors: [] },
  },
  driver: { component: "concentration", sentence: "49% of the portfolio sits in NVDA.", contribution: 12.8 },
  weights: [],
  blend_weights: { concentration: 0.2, market: 0.2, volatility: 0.2, network: 0.25, event: 0.15 },
  degraded: [],
  graph_version: null,
  empty: false,
} as unknown as RiskSnapshot;

describe("risk panel rows — snapshots outlive the code that wrote them", () => {
  it("a five-component snapshot yields six rows, the missing one marked absent", () => {
    const rows = riskPanelRows(LEGACY);
    assert.equal(rows.length, 6);
    const sharpe = rows.find((r) => r.key === "sharpe")!;
    assert.equal(sharpe.state, "absent");
    assert.equal(sharpe.score, null);
    assert.equal(sharpe.weight, 0);
    assert.equal(sharpe.contribution, null);
    assert.equal(sharpe.label, "Risk-adjusted return");
    // The five it does have are untouched.
    const network = rows.find((r) => r.key === "network")!;
    assert.equal(network.state, "scored");
    assert.equal(network.score, 5);
    assert.equal(network.weight, 0.25);
    assert.equal(network.contribution, 1.25);
    assert.equal(rows.find((r) => r.key === "concentration")!.isDriver, true);
  });

  it("componentPayload returns null for a component the snapshot predates", () => {
    assert.equal(componentPayload(LEGACY, "sharpe"), null);
    assert.equal(componentPayload(LEGACY, "network")!.pair_count, 10);
  });

  it("a measured-but-unscored component is 'unmeasured', not 'absent'", () => {
    const thin = {
      ...LEGACY,
      components: {
        ...(LEGACY.components as object),
        sharpe: { score: null, sharpe: null, sessions: 12, ann_return_pct: 0, ann_vol_pct: 0, risk_free_pct: 4, excluded: [] },
      },
    } as unknown as RiskSnapshot;
    const row = riskPanelRows(thin).find((r) => r.key === "sharpe")!;
    assert.equal(row.state, "unmeasured");
    assert.equal(row.score, null);
  });

  it("an empty snapshot (no components at all) still yields six safe rows", () => {
    const empty = { ...LEGACY, components: null, driver: null, blend_weights: undefined } as unknown as RiskSnapshot;
    const rows = riskPanelRows(empty);
    assert.equal(rows.length, 6);
    assert.ok(rows.every((r) => r.state === "absent" && r.score === null && r.weight === 0 && !r.isDriver));
  });
});
