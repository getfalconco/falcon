import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collapseEntities } from "./stage1.js";
import type { PropagationRole, TraversalCandidate, Transmission } from "./types.js";

/**
 * §4a — one entity, one call. The fixtures below are the shape that produced
 * a long and a short on COP off a single Chevron event: the same ticker
 * reached as an important partner (`same`) and a marginal competitor
 * (`inverse`).
 */

function candidate(target: string, role: PropagationRole, tier: "critical" | "important" | "marginal"): TraversalCandidate {
  return {
    target,
    ticker: /^[A-Z]{1,5}$/.test(target) ? target : null,
    label: target,
    relationship: {
      role,
      subtype: "joint_venture",
      tier,
      confidence: 0.9,
      evidence_quote: "q",
      source_url: "u",
      filing_date: null,
      via: "forward",
      evidence_via: "forward",
      edge_ids: [`${target}:${role}`],
      merged_evidence: [],
    },
  };
}

function tx(direction: Transmission["direction"], rule: Transmission["rule"]): Transmission {
  return { tier: "moderate", direction, matrix_cell: `contract_partnership:${rule}`, transmits: "yes", rule };
}

const partnerCOP = { candidate: candidate("COP", "partner", "important"), transmission: tx("positive", "same") };
const competitorCOP = { candidate: candidate("COP", "competitor", "marginal"), transmission: tx("negative", "inverse") };

describe("entity collapse", () => {
  it("opposite roles on one ticker collapse to a single directionless target", () => {
    const { kept, collapsed, conflicts } = collapseEntities([partnerCOP, competitorCOP]);
    assert.equal(kept.length, 1);
    assert.equal(collapsed, 1);
    assert.equal(conflicts, 1);
    const [only] = kept;
    // The strongest relationship survives — important beats marginal.
    assert.equal(only.candidate.relationship.role, "partner");
    assert.equal(only.transmission.direction, "unclear");
    assert.equal(only.transmission.rule, "unclear");
    assert.equal(only.transmission.role_conflict, true);
    assert.deepEqual(only.transmission.also_roles, ["competitor"]);
  });

  it("never emits both a long and a short on the same ticker", () => {
    const { kept } = collapseEntities([partnerCOP, competitorCOP]);
    const signed = kept.filter((k) => k.transmission.direction === "positive" || k.transmission.direction === "negative");
    assert.equal(signed.length, 0);
  });

  it("roles that agree merge without touching the direction", () => {
    const supplier = { candidate: candidate("MSFT", "supplier", "critical"), transmission: tx("positive", "same") };
    const partner = { candidate: candidate("MSFT", "partner", "important"), transmission: tx("positive", "same") };
    const { kept, conflicts } = collapseEntities([supplier, partner]);
    assert.equal(kept.length, 1);
    assert.equal(conflicts, 0);
    assert.equal(kept[0].transmission.direction, "positive");
    assert.equal(kept[0].transmission.role_conflict, false);
    assert.deepEqual(kept[0].transmission.also_roles, ["partner"]);
  });

  it("a directionless role does not make a conflict", () => {
    const unclear = { candidate: candidate("COP", "dependency", "marginal"), transmission: tx("unclear", "unclear") };
    const { kept, conflicts } = collapseEntities([partnerCOP, unclear]);
    assert.equal(conflicts, 0);
    assert.equal(kept[0].transmission.direction, "positive");
  });

  it("single-role targets pass through untouched, order preserved", () => {
    const a = { candidate: candidate("TSM", "supplier", "critical"), transmission: tx("positive", "same") };
    const b = { candidate: candidate("AMD", "competitor", "important"), transmission: tx("negative", "inverse") };
    const { kept, collapsed, conflicts } = collapseEntities([a, b]);
    assert.equal(collapsed, 0);
    assert.equal(conflicts, 0);
    assert.deepEqual(kept.map((k) => k.candidate.ticker), ["TSM", "AMD"]);
    assert.equal(kept[0].transmission.also_roles, undefined);
  });

  it("name-only entities collapse on their name, and stay separate from other names", () => {
    const p = { candidate: candidate("name:angola lng", "partner", "important"), transmission: tx("positive", "same") };
    const s = { candidate: candidate("name:angola lng", "supplier", "marginal"), transmission: tx("negative", "inverse") };
    const other = { candidate: candidate("name:russia", "dependency", "important"), transmission: tx("positive", "same") };
    const { kept, conflicts } = collapseEntities([p, s, other]);
    assert.equal(kept.length, 2);
    assert.equal(conflicts, 1);
    assert.equal(kept[0].transmission.direction, "unclear");
    assert.equal(kept[1].transmission.direction, "positive");
  });
});
