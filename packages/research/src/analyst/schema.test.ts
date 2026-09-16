/**
 * §5 validators: enum membership, length caps, conditional field rules,
 * evidence grounding (exists in the incident), the generic-trigger rejection
 * list, the edge-deviation rationale rule and the grounding downgrade.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeAnalystConfig } from "./config.js";
import {
  coerceStoredOutput,
  downgradeForGrounding,
  isEdgeDeviation,
  isGenericTrigger,
  resolveEvidence,
  sanitizeText,
  validateModelOutput,
  type ValidationContext,
} from "./schema.js";
import type { ReactionState } from "./types.js";
import { RECORDED } from "./test-fixtures.js";

const CONFIG = mergeAnalystConfig(null);

const REACTION_NO_EDGE: ReactionState = {
  basis: "move",
  realized_pct: -0.09,
  realized_z: -6.6,
  best_cause: {
    message_id: "id-news",
    article_key: "id:x",
    event_type: "earnings_results",
    materiality: "high",
    direction: "negative",
    headline: "x",
  },
  tier_expectation_z: 2,
  comparison: "exceeded",
  edge_default: "no_edge",
};

const REACTION_UNDETERMINED: ReactionState = {
  ...REACTION_NO_EDGE,
  best_cause: null,
  tier_expectation_z: null,
  comparison: "n_a",
  realized_z: 1.2,
  edge_default: "undetermined",
};

function ctx(reaction: ReactionState = REACTION_NO_EDGE, overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    refs: { m1: "id-gap", m4: "id-filing", m7: "id-news" },
    evidence_ids: ["id-gap", "id-filing", "id-news", "id-other"],
    reaction_state: reaction,
    config: CONFIG,
    ...overrides,
  };
}

function good(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    cause: "identified",
    cause_summary: "Earnings release drove the move.",
    mechanism: "Weaker sales compress the multiple.",
    evidence: ["m4", "m7"],
    edge_status: "no_edge",
    edge_rationale: null,
    watch_trigger: "Next earnings 2026-11-19.",
    ...overrides,
  });
}

describe("accepts", () => {
  it("a grounded identified output; refs resolve to message ids in order, deduped", () => {
    const r = validateModelOutput(good({ evidence: ["m4", "[m7]", "m4", "id-other"] }), ctx());
    assert.ok(r.ok);
    assert.deepEqual(r.output.evidence, ["id-filing", "id-news", "id-other"]);
    assert.equal(r.edge_deviation, false);
  });

  it("unidentified with empty evidence and a falsifiable trigger", () => {
    const r = validateModelOutput(RECORDED.bntx_unidentified, ctx(REACTION_UNDETERMINED));
    assert.ok(r.ok);
    assert.equal(r.output.cause, "unidentified");
    assert.equal(r.output.edge_status, "watch");
  });

  it("fenced JSON", () => {
    const r = validateModelOutput(RECORDED.fenced, ctx(REACTION_UNDETERMINED));
    assert.ok(r.ok);
  });

  it("a deviation with a rationale, flagged", () => {
    const r = validateModelOutput(
      good({ edge_status: "watch", edge_rationale: "The release left guidance open until the 8-K.", watch_trigger: "Guidance 8-K by 2026-09-05." }),
      ctx(),
    );
    assert.ok(r.ok);
    assert.equal(r.edge_deviation, true);
  });

  it("no deviation against an undetermined default", () => {
    assert.equal(isEdgeDeviation("watch", REACTION_UNDETERMINED), false);
    assert.equal(isEdgeDeviation("watch", REACTION_NO_EDGE), true);
    assert.equal(isEdgeDeviation("no_edge", REACTION_NO_EDGE), false);
  });

  it("strips control characters and collapses whitespace", () => {
    const bell = String.fromCharCode(7);
    assert.equal(sanitizeText(`a${bell}b   c`), "a b c");
    const r = validateModelOutput(good({ cause_summary: `Earnings${bell}release` }), ctx());
    assert.ok(r.ok);
    assert.equal(r.output.cause_summary, "Earnings release");
  });
});

describe("rejects (retry)", () => {
  it("not JSON", () => {
    const r = validateModelOutput(RECORDED.not_json, ctx());
    assert.ok(!r.ok);
    assert.match(r.errors[0], /^parse:/);
    assert.equal(r.grounding_only, false);
  });

  it("enum violations are not grounding failures", () => {
    const r = validateModelOutput(RECORDED.bad_enum, ctx());
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => e.startsWith("enum: cause")));
    assert.ok(r.errors.some((e) => e.startsWith("enum: edge_status")));
    assert.equal(r.grounding_only, false);
    assert.equal(r.downgraded, null);
  });

  it("missing / unexpected keys", () => {
    const r = validateModelOutput(JSON.stringify({ cause: "unidentified" }), ctx());
    assert.ok(!r.ok && r.errors.some((e) => e.includes('missing "cause_summary"')));
    const r2 = validateModelOutput(good({ price_target: 500 }), ctx());
    assert.ok(!r2.ok && r2.errors.some((e) => e.includes('unexpected key "price_target"')));
  });

  it("length caps", () => {
    const r = validateModelOutput(good({ cause_summary: "x".repeat(241) }), ctx());
    assert.ok(!r.ok && r.errors.some((e) => e.startsWith("length: cause_summary")));
    const r2 = validateModelOutput(good({ watch_trigger: "y".repeat(300) }), ctx());
    assert.ok(!r2.ok && r2.errors.some((e) => e.startsWith("length: watch_trigger")));
    const r3 = validateModelOutput(good({ evidence: Array.from({ length: 13 }, () => "m4") }), ctx());
    assert.ok(!r3.ok && r3.errors.some((e) => e.startsWith("length: evidence")));
  });

  it("conditional: identified needs mechanism", () => {
    const r = validateModelOutput(RECORDED.bad_missing_mechanism, ctx());
    assert.ok(!r.ok && r.errors.some((e) => e.includes("mechanism is required")));
  });

  it("conditional: potential_edge needs watch_trigger and edge_rationale", () => {
    const r = validateModelOutput(RECORDED.bad_potential_edge, ctx(REACTION_UNDETERMINED));
    assert.ok(!r.ok && r.errors.some((e) => e.includes('edge_rationale is required for edge_status "potential_edge"')));
    const r2 = validateModelOutput(
      good({ cause: "unidentified", mechanism: null, evidence: [], edge_status: "potential_edge", edge_rationale: "open trigger", watch_trigger: null }),
      ctx(REACTION_UNDETERMINED),
    );
    assert.ok(!r2.ok && r2.errors.some((e) => e.includes("watch_trigger is required")));
  });

  it("conditional: watch needs a trigger", () => {
    const r = validateModelOutput(good({ edge_status: "watch", watch_trigger: null, edge_rationale: "r" }), ctx());
    assert.ok(!r.ok && r.errors.some((e) => e.includes('watch_trigger is required when edge_status is "watch"')));
  });

  it("deviation from a decisive edge_default without rationale", () => {
    const r = validateModelOutput(good({ edge_status: "watch", watch_trigger: "8-K by 2026-09-05." }), ctx());
    assert.ok(!r.ok && r.errors.some((e) => e.includes("deviates from edge_default")));
  });

  it("generic triggers, case-insensitive, list is configuration", () => {
    const r = validateModelOutput(RECORDED.bad_generic_trigger, ctx(REACTION_UNDETERMINED));
    assert.ok(!r.ok && r.errors.some((e) => e.startsWith("trigger:")));
    assert.equal(isGenericTrigger("Monitor The Situation closely", CONFIG), "monitor the situation");
    assert.equal(isGenericTrigger("8-K within 4 business days", CONFIG), null);
    const cfg = mergeAnalystConfig({ genericTriggerPhrases: ["stay alert"] });
    assert.equal(isGenericTrigger("watch for news", cfg), null);
    assert.equal(isGenericTrigger("Stay alert", cfg), "stay alert");
  });
});

describe("grounding (§5)", () => {
  it("identified with unknown refs → grounding-only failure with a downgrade candidate", () => {
    const r = validateModelOutput(RECORDED.bad_grounding, ctx());
    assert.ok(!r.ok);
    assert.equal(r.grounding_only, true);
    assert.ok(r.errors.every((e) => e.startsWith("grounding:")));
    assert.equal(r.downgraded?.cause, "unidentified");
    assert.equal(r.downgraded?.mechanism, null);
    assert.deepEqual(r.downgraded?.evidence, []);
  });

  it("identified with empty evidence → grounding-only", () => {
    const r = validateModelOutput(RECORDED.bad_grounding_empty, ctx());
    assert.ok(!r.ok && r.grounding_only);
  });

  it("one unknown ref among valid ones keeps the valid ids in the downgrade", () => {
    const r = validateModelOutput(good({ evidence: ["m4", "m42"] }), ctx());
    assert.ok(!r.ok && r.grounding_only);
    assert.deepEqual(r.downgraded?.evidence, ["id-filing"]);
  });

  it("grounding plus another error is not grounding-only (no downgrade)", () => {
    const r = validateModelOutput(good({ evidence: ["m42"], watch_trigger: "watch for news" }), ctx());
    assert.ok(!r.ok);
    assert.equal(r.grounding_only, false);
    assert.equal(r.downgraded, null);
  });

  it("unidentified may cite evidence, but it must still exist", () => {
    const r = validateModelOutput(good({ cause: "unidentified", mechanism: null, evidence: ["m42"] }), ctx());
    assert.ok(!r.ok && r.grounding_only);
  });

  it("resolveEvidence accepts refs, bracketed refs and raw ids", () => {
    const c = ctx();
    assert.equal(resolveEvidence("m4", c), "id-filing");
    assert.equal(resolveEvidence("[m4]", c), "id-filing");
    assert.equal(resolveEvidence("M4", c), "id-filing");
    assert.equal(resolveEvidence("id-other", c), "id-other");
    assert.equal(resolveEvidence("nope", c), null);
  });

  it("downgradeForGrounding", () => {
    const d = downgradeForGrounding({
      cause: "identified",
      cause_summary: "s",
      mechanism: "m",
      evidence: ["a"],
      edge_status: "no_edge",
      edge_rationale: null,
      watch_trigger: null,
    });
    assert.equal(d.cause, "unidentified");
    assert.equal(d.mechanism, null);
    assert.deepEqual(d.evidence, ["a"]);
  });
});

describe("coerceStoredOutput", () => {
  it("rejects junk rows", () => {
    assert.equal(coerceStoredOutput(null), null);
    assert.equal(coerceStoredOutput({ schema_version: 2 }), null);
    assert.equal(coerceStoredOutput({ schema_version: 1, incident_id: "i" }), null);
  });
});
