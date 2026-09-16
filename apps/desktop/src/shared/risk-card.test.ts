import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { riskCardModel } from "./risk-card.js";
import type { RiskSnapshot } from "./risk-types.js";

const FIXTURE: RiskSnapshot = {
  schema_version: 1,
  computed_at: "2026-08-24T20:30:00.000Z",
  account: "paper",
  trigger: ["manual"],
  invested_fraction: 0.82,
  position_count: 4,
  score: 63,
  band: "elevated",
  components: null,
  driver: { component: "network", sentence: "NVDA and TSM share a critical supply-chain link.", contribution: 18 },
  weights: [],
  blend_weights: { concentration: 0.18, market: 0.17, volatility: 0.18, network: 0.22, event: 0.13, sharpe: 0.12 },
  degraded: [],
  graph_version: null,
  empty: false,
};

describe("risk card contract (§8)", () => {
  it("flag off → hidden, whatever the snapshot says", () => {
    assert.deepEqual(riskCardModel({ snapshot: FIXTURE, riskCardEnabled: false }), { kind: "hidden" });
    assert.deepEqual(riskCardModel(null), { kind: "hidden" });
    assert.deepEqual(riskCardModel({ snapshot: null, riskCardEnabled: true }), { kind: "hidden" });
  });

  it("empty snapshot → empty state", () => {
    const m = riskCardModel({ snapshot: { ...FIXTURE, empty: true, score: null, band: null, driver: null }, riskCardEnabled: true });
    assert.deepEqual(m, { kind: "empty", computed_at: FIXTURE.computed_at });
  });

  it("fixture snapshot → score, band, driver sentence, computed_at only", () => {
    const m = riskCardModel({ snapshot: FIXTURE, riskCardEnabled: true });
    assert.deepEqual(m, {
      kind: "score",
      score: 63,
      band: "elevated",
      sentence: "NVDA and TSM share a critical supply-chain link.",
      computed_at: "2026-08-24T20:30:00.000Z",
    });
  });
});
