import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rebuildChunks, scoreCase, scoreDataset } from "./build.js";
import type { DatasetCase } from "./build.js";

function rel(name: string, category = "supplier"): DatasetCase["expected"][number] {
  return {
    counterparty_name: name,
    counterparty_type: "public_company",
    category,
    evidence_quote: `We buy from ${name}.`,
  };
}

describe("rebuildChunks", () => {
  it("reproduces the pipeline's overlapping cut", () => {
    const chunks = rebuildChunks("x".repeat(50_000));
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0]!.length, 24_000);
    // 24k window on a 23k stride — the 1k overlap the extractor relies on.
    assert.equal(chunks[1]!.length, 24_000);
  });

  it("returns one chunk for a short filing", () => {
    assert.equal(rebuildChunks("short").length, 1);
  });
});

describe("scoreCase", () => {
  it("counts a relationship still found as kept", () => {
    const s = scoreCase([rel("Acme Foundry")], [rel("Acme Foundry")]);
    assert.equal(s.kept, 1);
    assert.equal(s.lost, 0);
  });

  it("matches through legal-suffix drift", () => {
    // The name a run writes varies; the counterparty does not.
    const s = scoreCase([rel("Acme Foundry, Inc.")], [rel("Acme Foundry")]);
    assert.equal(s.kept, 1);
    assert.equal(s.lost, 0);
  });

  it("counts a relationship no longer found as lost", () => {
    const s = scoreCase([rel("Acme"), rel("Beta")], [rel("Acme")]);
    assert.equal(s.kept, 1);
    assert.equal(s.lost, 1);
  });

  it("flags a silent category change", () => {
    // Same counterparty, opposite meaning — invisible if you only count names.
    const s = scoreCase([rel("Acme", "supplier")], [rel("Acme", "customer")]);
    assert.equal(s.kept, 1);
    assert.equal(s.recategorised, 1);
  });

  it("counts new finds separately from losses", () => {
    const s = scoreCase([rel("Acme")], [rel("Acme"), rel("Gamma")]);
    assert.equal(s.added, 1);
    assert.equal(s.lost, 0);
  });

  it("treats an empty case as a real case", () => {
    // 98 of 459 chunks legitimately contain nothing. Inventing relationships
    // there is as much a regression as losing them.
    const s = scoreCase([], [rel("Invented")]);
    assert.equal(s.added, 1);
    assert.equal(s.kept, 0);
    assert.equal(s.lost, 0);
  });
});

describe("scoreDataset", () => {
  it("reports perfect retention when nothing went missing", () => {
    const score = scoreDataset([
      { case_id: "A-0", expected: [rel("Acme")], actual: [rel("Acme")] },
      { case_id: "A-1", expected: [], actual: [] },
    ]);
    assert.equal(score.retention, 1);
    assert.equal(score.regressions.length, 0);
  });

  it("surfaces the worst regression first", () => {
    const score = scoreDataset([
      { case_id: "A-0", expected: [rel("A"), rel("B"), rel("C")], actual: [] },
      { case_id: "A-1", expected: [rel("D")], actual: [] },
    ]);
    assert.equal(score.lost, 4);
    assert.equal(score.retention, 0);
    assert.equal(score.regressions[0]!.case_id, "A-0");
  });

  it("does not let new finds paper over losses", () => {
    // A change that finds ten new things and drops one has still dropped one.
    const score = scoreDataset([
      { case_id: "A-0", expected: [rel("Kept"), rel("Dropped")], actual: [rel("Kept"), rel("N1"), rel("N2")] },
    ]);
    assert.equal(score.lost, 1);
    assert.equal(score.added, 2);
    assert.equal(score.retention, 0.5);
  });

  it("has no retention figure with nothing to retain", () => {
    const score = scoreDataset([{ case_id: "A-0", expected: [], actual: [] }]);
    assert.equal(score.retention, null);
  });
});
