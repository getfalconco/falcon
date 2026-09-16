import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EVENT_TYPES } from "../../classifier/types.js";
import { DEFAULT_PROPAGATION_CONFIG, DEFAULT_TRANSMISSION_MATRIX, mergePropagationConfig } from "./config.js";
import { invertDirection, matrixCell, propagationTier, resolveDirection, transmissionFor } from "./matrix.js";
import { PROPAGATION_ROLES } from "./types.js";

const cfg = DEFAULT_PROPAGATION_CONFIG;

describe("transmission matrix (§5)", () => {
  it("covers every event type × role", () => {
    for (const e of EVENT_TYPES) {
      for (const r of PROPAGATION_ROLES) {
        const c = matrixCell(cfg, e, r);
        assert.ok(["yes", "weak", "no"].includes(c.transmits), `${e}:${r}`);
        assert.ok(["same", "inverse", "unclear"].includes(c.direction), `${e}:${r}`);
      }
    }
  });

  it("earnings → supplier transmits same (demand read-through); customer weak same", () => {
    const s = transmissionFor(cfg, { type: "earnings_results", direction: "negative", materiality: "high" }, { role: "supplier", tier: "critical" });
    assert.deepEqual(s, { tier: "strong", direction: "negative", matrix_cell: "earnings_results:supplier", transmits: "yes", rule: "same" });
    const c = transmissionFor(cfg, { type: "earnings_results", direction: "positive", materiality: "high" }, { role: "customer", tier: "important" });
    assert.equal(c?.transmits, "weak");
    assert.equal(c?.direction, "positive");
    assert.equal(c?.tier, "moderate");
  });

  it("golden: competitor ambiguity rows ship `unclear` — never a guessed sign", () => {
    for (const type of ["earnings_results", "guidance", "ma_activity"] as const) {
      const t = transmissionFor(cfg, { type, direction: "negative", materiality: "high" }, { role: "competitor", tier: "critical" });
      assert.ok(t, `${type} competitor transmits`);
      assert.equal(t.transmits, "yes");
      assert.equal(t.direction, "unclear");
      assert.equal(t.rule, "unclear");
      assert.match(matrixCell(cfg, type, "competitor").note ?? "", /stage-2/);
    }
  });

  it("supply_chain_ops: customers inverse (supply risk), competitors inverse (gain), dependency same", () => {
    const ev = { type: "supply_chain_ops" as const, direction: "negative" as const, materiality: "standard" as const };
    assert.equal(transmissionFor(cfg, ev, { role: "customer", tier: "critical" })?.direction, "positive");
    assert.equal(transmissionFor(cfg, ev, { role: "competitor", tier: "critical" })?.direction, "positive");
    assert.equal(transmissionFor(cfg, ev, { role: "dependency", tier: "critical" })?.direction, "negative");
    assert.equal(transmissionFor(cfg, ev, { role: "depended_on_by", tier: "critical" })?.direction, "positive");
  });

  it("regulatory / product / contract rows: competitor inverse, partner same", () => {
    for (const type of ["regulatory_decision", "product_clinical", "contract_partnership"] as const) {
      const ev = { type, direction: "positive" as const, materiality: "high" as const };
      assert.equal(transmissionFor(cfg, ev, { role: "competitor", tier: "important" })?.direction, "negative");
      assert.equal(transmissionFor(cfg, ev, { role: "partner", tier: "important" })?.direction, "positive");
    }
    assert.equal(transmissionFor(cfg, { type: "contract_partnership", direction: "positive", materiality: "high" }, { role: "supplier", tier: "critical" })?.transmits, "yes");
  });

  it("legal / governance / financing: suppliers and customers do not transmit; competitor weak unclear", () => {
    for (const type of ["legal", "management_governance", "financing_credit"] as const) {
      const ev = { type, direction: "negative" as const, materiality: "high" as const };
      assert.equal(transmissionFor(cfg, ev, { role: "supplier", tier: "critical" }), null);
      assert.equal(transmissionFor(cfg, ev, { role: "customer", tier: "critical" }), null);
      const comp = transmissionFor(cfg, ev, { role: "competitor", tier: "critical" });
      assert.equal(comp?.transmits, "weak");
      assert.equal(comp?.direction, "unclear");
    }
  });

  it("`no` rows produce no target for any role", () => {
    for (const type of ["analyst_action", "ownership_flows", "macro_sector", "capital_allocation", "other"] as const) {
      for (const role of PROPAGATION_ROLES) {
        assert.equal(transmissionFor(cfg, { type, direction: "positive", materiality: "high" }, { role, tier: "critical" }), null, `${type}:${role}`);
      }
    }
  });

  it("direction rules: same inherits, inverse flips, mixed/unclear have no sign to flip", () => {
    assert.equal(resolveDirection("negative", "same"), "negative");
    assert.equal(resolveDirection("negative", "inverse"), "positive");
    assert.equal(resolveDirection("positive", "inverse"), "negative");
    assert.equal(resolveDirection("mixed", "inverse"), "mixed");
    assert.equal(resolveDirection("unclear", "same"), "unclear");
    assert.equal(resolveDirection("positive", "unclear"), "unclear");
    assert.equal(invertDirection("unclear"), "unclear");
  });

  it("an unknown event type falls back to `no`", () => {
    assert.deepEqual(matrixCell(cfg, "nonsense" as never, "supplier"), { transmits: "no", direction: "unclear" });
  });
});

describe("strength map (§6)", () => {
  it("critical×high → strong; critical×standard and important×high → moderate; the rest weak", () => {
    assert.equal(propagationTier(cfg, "critical", "high"), "strong");
    assert.equal(propagationTier(cfg, "critical", "standard"), "moderate");
    assert.equal(propagationTier(cfg, "important", "high"), "moderate");
    assert.equal(propagationTier(cfg, "important", "standard"), "weak");
    assert.equal(propagationTier(cfg, "marginal", "high"), "weak");
    assert.equal(propagationTier(cfg, "critical", "low"), "weak");
  });
});

describe("config merge", () => {
  it("deep-merges a single matrix cell and keeps the rest of the defaults", () => {
    const merged = mergePropagationConfig({
      matrix: { earnings_results: { competitor: { transmits: "yes", direction: "inverse" } } } as never,
      pricing: { openBelow: 0.4 } as never,
    });
    assert.equal(merged.matrix.earnings_results.competitor.direction, "inverse");
    assert.equal(merged.matrix.earnings_results.supplier.direction, "same");
    assert.equal(merged.matrix.supply_chain_ops.customer.direction, DEFAULT_TRANSMISSION_MATRIX.supply_chain_ops.customer.direction);
    assert.equal(merged.pricing.openBelow, 0.4);
    assert.equal(merged.pricing.pricedAtOrAbove, 1.0);
    assert.equal(merged.pricing.tierScale.weak, 0.25);
    // Graduated in config v2: surfacing is on unless the stored file says otherwise.
    assert.equal(merged.propagationSurfacingEnabled, true);
  });
});
