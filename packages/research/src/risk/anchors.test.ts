import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { interpolateAnchors, roundScore } from "./anchors.js";
import { DEFAULT_RISK_CONFIG } from "./config.js";

describe("risk/anchors", () => {
  const conc = DEFAULT_RISK_CONFIG.anchors.concentration;

  it("returns the anchor score exactly at an anchor", () => {
    assert.equal(interpolateAnchors(conc, 0.05), 10);
    assert.equal(interpolateAnchors(conc, 0.1), 30);
    assert.equal(interpolateAnchors(conc, 0.2), 55);
    assert.equal(interpolateAnchors(conc, 0.33), 75);
    assert.equal(interpolateAnchors(conc, 0.5), 95);
  });

  it("interpolates linearly between neighbours", () => {
    assert.equal(interpolateAnchors(conc, 0.15), 42.5);
    assert.ok(Math.abs(interpolateAnchors(DEFAULT_RISK_CONFIG.anchors.market, 1.2) - 55) < 1e-9);
    assert.ok(Math.abs(interpolateAnchors(DEFAULT_RISK_CONFIG.anchors.event, 17.5) - 58.75) < 1e-9);
  });

  it("clamps below the first and above the last anchor", () => {
    assert.equal(interpolateAnchors(conc, 0.01), 10);
    assert.equal(interpolateAnchors(conc, 0), 10);
    assert.equal(interpolateAnchors(conc, 0.9), 95);
    assert.equal(interpolateAnchors(conc, 1.0), 95);
    assert.equal(interpolateAnchors(DEFAULT_RISK_CONFIG.anchors.network, -0.2), 5);
    assert.equal(interpolateAnchors(DEFAULT_RISK_CONFIG.anchors.volatility, 12), 90);
  });

  it("handles unsorted tables and non-finite input", () => {
    assert.ok(Math.abs(interpolateAnchors([[0.5, 95], [0.05, 10]], 0.275) - 52.5) < 1e-9);
    assert.equal(interpolateAnchors(conc, Number.NaN), 10);
  });

  it("roundScore clamps to 0–100", () => {
    assert.equal(roundScore(57.5), 58);
    assert.equal(roundScore(-3), 0);
    assert.equal(roundScore(140), 100);
    assert.equal(roundScore(Number.NaN), 0);
  });
});
