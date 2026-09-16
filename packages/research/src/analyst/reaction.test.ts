/**
 * §4 reaction_state goldens — pure function over (incident, verdicts, config):
 * basis selection (residual / move fallback / incomputable), peak reaction,
 * best_cause, comparison and the edge_default rules. Recorded WMT and BNTX
 * incidents pin the live shapes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gapEvent, newsItem, unexplainedMove, plusMinutes } from "../base/test-fixtures.js";
import { mergeAnalystConfig } from "./config.js";
import {
  bestCauseOf,
  chooseBasis,
  compareToTier,
  computeReactionState,
  directionConflicts,
  edgeDefaultOf,
  peakReaction,
} from "./reaction.js";
import { AT, classified, incidentFrom, loadRecorded } from "./test-fixtures.js";

const CONFIG = mergeAnalystConfig(null);

describe("basis selection", () => {
  it("residual when r² is at or above the fallback threshold", () => {
    const inc = incidentFrom([gapEvent("g", AT, {}, { quant: { r_squared: 0.4 } })]);
    assert.equal(chooseBasis(inc, CONFIG), "residual");
  });

  it("move under the low-R² fallback", () => {
    const inc = incidentFrom([gapEvent("g", AT, {}, { quant: { r_squared: 0.05 } })]);
    assert.equal(chooseBasis(inc, CONFIG), "move");
  });

  it("an unexplained_move's measure_used is authoritative over r²", () => {
    const inc = incidentFrom([
      unexplainedMove("u", AT, { measure_used: "move_zscore" }, { quant: { r_squared: 0.9 } }),
    ]);
    assert.equal(chooseBasis(inc, CONFIG), "move");
    const inc2 = incidentFrom([
      unexplainedMove("u", AT, { measure_used: "residual_zscore" }, { quant: { r_squared: 0.01 } }),
    ]);
    assert.equal(chooseBasis(inc2, CONFIG), "residual");
  });

  it("null r² everywhere → move", () => {
    const inc = incidentFrom([gapEvent("g", AT, {}, { quant: { r_squared: null } })]);
    assert.equal(chooseBasis(inc, CONFIG), "move");
  });
});

describe("peak reaction", () => {
  it("takes the largest |z| across the incident, not the latest context", () => {
    const inc = incidentFrom([
      newsItem("n1", AT, {}, { quant: { residual_zscore: -1.0, residual_move: -0.01 } }),
      gapEvent("g", plusMinutes(AT, 10), {}, { quant: { residual_zscore: -6.2, residual_move: -0.08 } }),
      newsItem("n2", plusMinutes(AT, 60), {}, { quant: { residual_zscore: -0.1, residual_move: -0.001 } }),
    ]);
    const peak = peakReaction(inc, "residual");
    assert.equal(peak.realized_z, -6.2);
    assert.equal(peak.realized_pct, -0.08);
  });

  it("null vol (fresh listing) → nothing computable → incomputable basis, watch default", () => {
    const inc = incidentFrom([
      gapEvent("g", AT, {}, { quant: { daily_vol_30d: null, residual_zscore: null, move_zscore: null } }),
    ]);
    const state = computeReactionState(inc, {}, CONFIG);
    assert.equal(state.basis, "incomputable");
    assert.equal(state.realized_z, null);
    assert.equal(state.realized_pct, null);
    assert.equal(state.comparison, "n_a");
    assert.equal(state.edge_default, "watch");
  });

  it("a context with z but null vol is not trusted", () => {
    const inc = incidentFrom([
      gapEvent("g", AT, {}, { quant: { daily_vol_30d: null, move_zscore: 4, residual_zscore: 4 } }),
    ]);
    assert.equal(peakReaction(inc, "move").realized_z, null);
  });
});

describe("best_cause", () => {
  it("highest-materiality direct verdict; indirect and none ignored; ties → earliest message", () => {
    const a = newsItem("a", AT, { headline: "A" });
    const b = newsItem("b", plusMinutes(AT, 5), { headline: "B" });
    const c = newsItem("c", plusMinutes(AT, 10), { headline: "C" });
    const d = newsItem("d", plusMinutes(AT, 15), { headline: "D" });
    const inc = incidentFrom([a, b, c, d]);
    const verdicts = {
      [a.id]: classified(a, { relevance: "direct", materiality: "standard", direction: "negative" }, "guidance"),
      [b.id]: classified(b, { relevance: "indirect", materiality: "high", direction: "negative" }, "macro_sector"),
      [c.id]: classified(c, { relevance: "direct", materiality: "high", direction: "negative" }, "earnings_results"),
      [d.id]: classified(d, { relevance: "direct", materiality: "high", direction: "positive" }, "legal"),
    };
    const best = bestCauseOf(inc, verdicts);
    assert.equal(best?.message_id, "c");
    assert.equal(best?.event_type, "earnings_results");
    assert.equal(best?.headline, "C");
  });

  it("null when no direct verdict", () => {
    const a = newsItem("a", AT);
    const inc = incidentFrom([a]);
    assert.equal(bestCauseOf(inc, { [a.id]: classified(a, { relevance: "none" }) }), null);
    assert.equal(bestCauseOf(inc, {}), null);
  });
});

describe("comparison + edge_default rules", () => {
  it("compareToTier bands", () => {
    assert.equal(compareToTier(6.6, 2.0, 0.5), "exceeded");
    assert.equal(compareToTier(2.2, 2.0, 0.5), "consistent");
    assert.equal(compareToTier(1.5, 2.0, 0.5), "consistent");
    assert.equal(compareToTier(1.4, 2.0, 0.5), "short_of");
    assert.equal(compareToTier(0.2, 0.5, 0.5), "consistent");
  });

  it("edge_default pure rules", () => {
    const high = { materiality: "high", direction: "negative" } as const;
    assert.equal(edgeDefaultOf("move", high, "exceeded", 6, -6, CONFIG), "no_edge");
    assert.equal(edgeDefaultOf("move", high, "consistent", 2, -2, CONFIG), "no_edge");
    assert.equal(edgeDefaultOf("move", high, "short_of", 0.5, -0.5, CONFIG), "undetermined");
    assert.equal(edgeDefaultOf("residual", null, "n_a", 2.0, 2.0, CONFIG), "watch");
    assert.equal(edgeDefaultOf("residual", null, "n_a", 1.9, -1.9, CONFIG), "undetermined");
    assert.equal(edgeDefaultOf("incomputable", high, "n_a", null, null, CONFIG), "watch");
  });

  it("v1.1: a cause whose direction contradicts the move never yields no_edge (mixed/unclear exempt)", () => {
    assert.equal(directionConflicts({ direction: "positive" }, -1.4), true);
    assert.equal(directionConflicts({ direction: "negative" }, 3.0), true);
    assert.equal(directionConflicts({ direction: "positive" }, 2.0), false);
    assert.equal(directionConflicts({ direction: "mixed" }, -7.6), false);
    assert.equal(directionConflicts({ direction: "unclear" }, -7.6), false);
    assert.equal(directionConflicts({ direction: "positive" }, null), false);
    assert.equal(directionConflicts(null, -1), false);
    const pos = { materiality: "high", direction: "positive" } as const;
    assert.equal(edgeDefaultOf("move", pos, "exceeded", 6, -6, CONFIG), "undetermined");
    assert.equal(edgeDefaultOf("move", pos, "exceeded", 6, 6, CONFIG), "no_edge");
  });

  it("v1.1: a low-materiality cause caps the default at undetermined; the floor is configuration", () => {
    const low = { materiality: "low", direction: "negative" } as const;
    assert.equal(edgeDefaultOf("move", low, "exceeded", 3, -3, CONFIG), "undetermined");
    assert.equal(edgeDefaultOf("move", low, "consistent", 0.5, -0.5, CONFIG), "undetermined");
    const std = { materiality: "standard", direction: "negative" } as const;
    assert.equal(edgeDefaultOf("move", std, "consistent", 1, -1, CONFIG), "no_edge");
    const strict = mergeAnalystConfig({ edgeDefault: { ...CONFIG.edgeDefault, noEdgeMinMateriality: "high" } });
    assert.equal(edgeDefaultOf("move", std, "consistent", 1, -1, strict), "undetermined");
  });

  it("v1.1: direction conflict → comparison n_a and undetermined in the full state", () => {
    const n = newsItem("n", AT, {}, { quant: { r_squared: 0.5, residual_zscore: -2.4, residual_move: -0.03 } });
    const inc = incidentFrom([n]);
    const state = computeReactionState(
      inc,
      { [n.id]: classified(n, { relevance: "direct", materiality: "high", direction: "positive" }) },
      CONFIG,
    );
    assert.equal(state.best_cause?.direction, "positive");
    assert.equal(state.comparison, "n_a");
    assert.equal(state.edge_default, "undetermined");
  });

  it("cause with a short_of reaction → undetermined (model may argue potential_edge)", () => {
    const n = newsItem("n", AT, {}, { quant: { r_squared: 0.5, residual_zscore: -0.4, residual_move: -0.004 } });
    const inc = incidentFrom([n]);
    const state = computeReactionState(
      inc,
      { [n.id]: classified(n, { relevance: "direct", materiality: "high", direction: "negative" }) },
      CONFIG,
    );
    assert.equal(state.basis, "residual");
    assert.equal(state.tier_expectation_z, 2.0);
    assert.equal(state.comparison, "short_of");
    assert.equal(state.edge_default, "undetermined");
  });

  it("no cause and a large reaction → watch", () => {
    const inc = incidentFrom([gapEvent("g", AT, {}, { quant: { r_squared: 0.5, residual_zscore: 3.1 } })]);
    const state = computeReactionState(inc, {}, CONFIG);
    assert.equal(state.best_cause, null);
    assert.equal(state.comparison, "n_a");
    assert.equal(state.edge_default, "watch");
  });

  it("tier map is configuration", () => {
    const n = newsItem("n", AT, {}, { quant: { r_squared: 0.5, residual_zscore: -1.2 } });
    const inc = incidentFrom([n]);
    const cfg = mergeAnalystConfig({ tierExpectationZ: { high: 4, standard: 1, low: 0.5 } });
    const state = computeReactionState(
      inc,
      { [n.id]: classified(n, { relevance: "direct", materiality: "high", direction: "negative" }) },
      cfg,
    );
    assert.equal(state.tier_expectation_z, 4);
    assert.equal(state.comparison, "short_of");
  });
});

describe("recorded goldens", () => {
  it("WMT earnings incident: move basis (r² 0.008), peak −7.6σ in the post-release window (latest context reads −0.1), high cause → exceeded → no_edge", () => {
    const rec = loadRecorded("wmt-earnings");
    const state = computeReactionState(rec.incident, rec.verdicts, CONFIG);
    assert.equal(state.basis, "move");
    assert.ok(state.realized_z !== null && Math.abs(state.realized_z - -7.62) < 0.01, `z ${state.realized_z}`);
    assert.ok(state.realized_pct !== null && Math.abs(state.realized_pct - -0.0968) < 0.001, `pct ${state.realized_pct}`);
    assert.ok(Math.abs(rec.incident.quant_context?.move_zscore ?? 0) < 0.2, "latest context is post-reaction");
    assert.equal(state.best_cause?.materiality, "high");
    assert.equal(state.best_cause?.event_type, "earnings_results");
    assert.equal(state.best_cause?.message_id, "0a5ce174-9787-4b56-a3f2-0a0de33f056a");
    assert.equal(state.tier_expectation_z, 2.0);
    assert.equal(state.comparison, "exceeded");
    assert.equal(state.edge_default, "no_edge");
  });

  it("BNTX gap: unexplained_move says move_zscore; only verdict is none → no cause, |z| ≥ 2 → watch", () => {
    const rec = loadRecorded("bntx-gap");
    const state = computeReactionState(rec.incident, rec.verdicts, CONFIG);
    assert.equal(state.basis, "move");
    assert.equal(state.best_cause, null);
    assert.ok(state.realized_z !== null && state.realized_z > 3.3);
    assert.equal(state.comparison, "n_a");
    assert.equal(state.edge_default, "watch");
  });

  it("CAH insider cluster (rubric batch 1 deviation case): positive/low RBC initiation vs a −1.4σ move → n_a → undetermined, not no_edge", () => {
    const rec = loadRecorded("cah-insider-cluster");
    const state = computeReactionState(rec.incident, rec.verdicts, CONFIG);
    assert.equal(state.best_cause?.event_type, "analyst_action");
    assert.equal(state.best_cause?.materiality, "low");
    assert.equal(state.best_cause?.direction, "positive");
    assert.ok(state.realized_z !== null && state.realized_z < -1.3 && state.realized_z > -1.5, `z ${state.realized_z}`);
    assert.equal(state.comparison, "n_a");
    assert.equal(state.edge_default, "undetermined");
  });

  it("META gap (rubric batch 1 #2): earnings_results/high/positive with a +0.5σ move → short_of → stays undetermined", () => {
    const rec = loadRecorded("meta-gap-short-of");
    const state = computeReactionState(rec.incident, rec.verdicts, CONFIG);
    assert.equal(state.basis, "move");
    assert.equal(state.best_cause?.materiality, "high");
    assert.equal(state.best_cause?.direction, "positive");
    assert.ok(state.realized_z !== null && state.realized_z > 0.4 && state.realized_z < 0.6, `z ${state.realized_z}`);
    assert.equal(state.comparison, "short_of");
    assert.equal(state.edge_default, "undetermined");
  });

  it("PFE insider cluster: only indirect verdicts → no cause; |z| ≈ 2.8 → watch", () => {
    const rec = loadRecorded("pfe-insider-cluster");
    const state = computeReactionState(rec.incident, rec.verdicts, CONFIG);
    assert.equal(state.best_cause, null);
    assert.equal(state.edge_default, "watch");
  });

  it("is deterministic: same inputs → deep-equal state", () => {
    const rec = loadRecorded("wmt-earnings");
    assert.deepEqual(
      computeReactionState(rec.incident, rec.verdicts, CONFIG),
      computeReactionState(structuredClone(rec.incident), structuredClone(rec.verdicts), CONFIG),
    );
  });
});
