import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildGraphFromResearchDir } from "./buildGraph.js";
import { dedupeCandidates } from "./dedupe.js";
import { backfillGraph, backfillRootEdges, stringifyLike, tierRecomputePlan, withStrength } from "./disclosedShareBackfill.js";
import {
  candidateShare,
  disclosedShareFromEvidence,
  disclosedShareOfEdge,
  quoteStatesCurrentPct,
  quoteStatesPct,
  STRENGTH_CLASSIFY_BATCH_SYSTEM,
  STRENGTH_CLASSIFY_SYSTEM,
} from "./strength.js";
import type { CandidateEdge, ValidatedEdge } from "./types.js";

const AMKR_QUOTE =
  "Direct sales to Apple and Qualcomm accounted for 29.8% and 11.1% of our net sales, respectively, for the year ended December 31, 2025.";

function validated(over: Partial<ValidatedEdge> & Pick<ValidatedEdge, "counterparty_name">): ValidatedEdge {
  return {
    root_ticker: "AMKR",
    counterparty_ticker: null,
    counterparty_type: "public_company",
    category: "customer",
    subtype: "",
    strength: 0.6,
    strength_tier: "important",
    strength_basis: "classified",
    epistemic_label: "VERIFIED",
    confidence: 0.95,
    evidence: [{ quote: "We sell to them.", source_url: "https://www.sec.gov/x", located_at: "10-K Item 1/1A" }],
    valid_from: "2026-02-10",
    shared_evidence_group: "",
    ...over,
  };
}

describe("disclosed share: reading a percentage from the evidence", () => {
  it("finds the percentage as the filing writes it", () => {
    assert.equal(quoteStatesPct(AMKR_QUOTE, 29.8), true);
    assert.equal(quoteStatesPct(AMKR_QUOTE, 11.1), true);
    assert.equal(quoteStatesPct("CVS Health accounted for 28 percent of our revenue", 28), true);
    assert.equal(quoteStatesPct("OptumRx — — 17 % — —", 17), true);
    assert.equal(quoteStatesPct("we derived 84 per cent of our sales", 84), true);
    assert.equal(quoteStatesPct(AMKR_QUOTE, 30), false);
    assert.equal(quoteStatesPct("revenue grew 129% this year", 29), false);
  });

  it("sets the share only when a quote states the number", () => {
    assert.deepEqual(disclosedShareFromEvidence(29.8, [AMKR_QUOTE]), {
      disclosed_share_pct: 29.8,
      disclosed_share_quote: AMKR_QUOTE,
    });
    // A percentage the model inferred, with no quote stating it, is not a disclosure.
    assert.deepEqual(disclosedShareFromEvidence(30, [AMKR_QUOTE]), { disclosed_share_pct: null, disclosed_share_quote: null });
    assert.deepEqual(disclosedShareFromEvidence(null, [AMKR_QUOTE]), { disclosed_share_pct: null, disclosed_share_quote: null });
  });

  it("reads only the latest year's column of a table row as the share", () => {
    // Cardinal Health 10-K for fiscal 2026: OptumRx was 17% of revenue in fiscal 2024 only.
    const optum = "OptumRx — — 17 % — —";
    assert.equal(quoteStatesCurrentPct(optum, 17), false);
    assert.deepEqual(disclosedShareFromEvidence(17, [optum]), { disclosed_share_pct: null, disclosed_share_quote: null });
    const cvs = "CVS Health 28 % 30 % 24 % 22 % 26 %";
    assert.equal(quoteStatesCurrentPct(cvs, 28), true);
    assert.equal(quoteStatesCurrentPct(cvs, 30), false);
    assert.equal(quoteStatesCurrentPct("Customer A 20.9 % 20.0 % *", 20.9), true);
    assert.equal(quoteStatesCurrentPct("Fiscal 2026 Customer A 15 %", 15), true);
    // Prose is read whole: the second share of a sentence is as current as the first.
    assert.equal(quoteStatesCurrentPct(AMKR_QUOTE, 11.1), true);
    assert.equal(quoteStatesCurrentPct("Our largest customer, CVS Health, accounted for 28 percent of our fiscal 2026 revenue.", 28), true);
    // A share recorded before the rule is read again through it.
    const recorded = validated({ counterparty_name: "OptumRx", strength: 0.17, strength_tier: "critical", strength_basis: "disclosed", disclosed_share_pct: 17, disclosed_share_quote: optum });
    assert.deepEqual(disclosedShareOfEdge(recorded), { disclosed_share_pct: null, disclosed_share_quote: null });
    const kept = validated({ counterparty_name: "CVS Health", strength: 0.28, strength_tier: "critical", strength_basis: "disclosed", disclosed_share_pct: 28, disclosed_share_quote: cvs });
    assert.deepEqual(disclosedShareOfEdge(kept), { disclosed_share_pct: 28, disclosed_share_quote: cvs });
  });

  it("tells a disclosed 30% from the marginal tier weight", () => {
    const quote = "Customer A accounted for 30% of our net revenue.";
    const disclosed = validated({
      counterparty_name: "Customer A",
      strength: 0.3,
      strength_tier: "critical",
      strength_basis: "disclosed",
      evidence: [{ quote, source_url: "https://www.sec.gov/x", located_at: "10-K Item 1/1A" }],
    });
    const tier = validated({ counterparty_name: "Rival", strength: 0.3, strength_tier: "marginal" });
    assert.equal(disclosedShareOfEdge(disclosed).disclosed_share_pct, 30);
    assert.equal(disclosedShareOfEdge(tier).disclosed_share_pct, null);
  });

  it("dedupe keeps a percentage from a merged duplicate, with its quote", () => {
    const base: CandidateEdge = {
      counterparty_name: "Airbus",
      counterparty_type: "public_company",
      category: "customer",
      subtype: "",
      disclosed_revenue_dependency_pct: null,
      evidence_quote: "We have significant business with Airbus.",
      evidence_quotes: [],
      confidence: 0.95,
      chunk_index: 0,
    };
    const withPct: CandidateEdge = {
      ...base,
      disclosed_revenue_dependency_pct: 29,
      evidence_quote: "Airbus accounted for 29% of segment sales.",
      confidence: 0.9,
    };
    const { kept } = dedupeCandidates([base, withPct]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.disclosed_revenue_dependency_pct, 29);
    assert.equal(kept[0]!.disclosed_pct_quote, "Airbus accounted for 29% of segment sales.");
  });
});

describe("disclosed share: graph build and backfill", () => {
  it("buildGraph carries the field, recovering it from a disclosed strength on older results", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-share-"));
    try {
      const edges = [
        validated({
          counterparty_name: "Apple",
          counterparty_ticker: "AAPL",
          strength: 0.298,
          strength_tier: "critical",
          strength_basis: "disclosed",
          evidence: [{ quote: AMKR_QUOTE, source_url: "https://www.sec.gov/x", located_at: "10-K Item 1/1A" }],
        }),
        validated({ counterparty_name: "Rival", category: "competitor", strength: 0.3, strength_tier: "marginal" }),
      ];
      await writeFile(path.join(dir, "AMKR.json"), JSON.stringify(edges));
      const graph = await buildGraphFromResearchDir(dir);
      const apple = graph.edges.find((e) => e.counterparty_name === "Apple")!;
      assert.equal(apple.disclosed_share_pct, 29.8);
      assert.equal(apple.disclosed_share_quote, AMKR_QUOTE);
      const rival = graph.edges.find((e) => e.counterparty_name === "Rival")!;
      assert.equal(rival.disclosed_share_pct, null);
      assert.equal(rival.disclosed_share_quote, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("backfills results and a graph file additively, once", () => {
    const quote = "Avnet accounted for 23% of our revenue in 2025 and 22% in 2024.";
    const edges = [
      validated({
        root_ticker: "NXPI",
        counterparty_name: "Avnet",
        strength: 0.23,
        strength_tier: "critical",
        strength_basis: "disclosed",
        evidence: [{ quote, source_url: "https://www.sec.gov/x", located_at: "10-K Item 1/1A" }],
      }),
      validated({ root_ticker: "NXPI", counterparty_name: "Arrow", subtype: "distributor" }),
      validated({ root_ticker: "NXPI", counterparty_name: "WPI", subtype: "distributor", evidence: [{ quote: "WPI accounted for 12% of revenue.", source_url: "https://www.sec.gov/x", located_at: "10-K Item 1/1A" }] }),
    ];
    const cached = [
      { counterparty_name: "WPI", category: "customer", disclosed_revenue_dependency_pct: 12, evidence_quote: "WPI accounted for 12% of revenue." },
      { counterparty_name: "Arrow", category: "customer", disclosed_revenue_dependency_pct: 9, evidence_quote: "a quote this edge does not carry" },
    ];
    const first = backfillRootEdges(edges, cached);
    assert.equal(first.stamped, 3);
    assert.equal(first.fromStrength, 1);
    assert.equal(first.fromCandidates, 1);
    assert.deepEqual(
      first.edges.map((e) => [e.counterparty_name, e.disclosed_share_pct]),
      [["Avnet", 23], ["Arrow", null], ["WPI", 12]],
    );
    // Key order: the new fields sit right after strength_basis; nothing else moves.
    const keys = Object.keys(first.edges[0]!);
    assert.deepEqual(keys.slice(keys.indexOf("strength_basis"), keys.indexOf("strength_basis") + 3), [
      "strength_basis",
      "disclosed_share_pct",
      "disclosed_share_quote",
    ]);
    // Idempotent.
    assert.equal(backfillRootEdges(first.edges, cached).stamped, 0);

    const graphEdge = (name: string, q: string, subtype = "") => ({
      id: `NXPI:name:${name.toLowerCase()}:customer:${subtype}:0`,
      root_ticker: "NXPI",
      counterparty_name: name,
      category: "customer",
      subtype,
      strength: 0.6,
      strength_tier: "important",
      evidence_quote: q,
    });
    const avnet = graphEdge("Avnet", quote);
    const graph = {
      edges: [avnet, graphEdge("Arrow", "We sell to them.", "distributor"), graphEdge("Stranger", "not in results")],
      reverseIndex: { "name:avnet": [{ ...avnet }] },
    };
    const { report } = backfillGraph(graph, first.edges);
    assert.deepEqual(report, { stamped: 2, withShare: 1, unmatched: 1, alreadySet: 0 });
    const patched = graph.edges as Array<Record<string, unknown>>;
    assert.equal(patched[0]!.disclosed_share_pct, 23);
    assert.equal(patched[1]!.disclosed_share_pct, null);
    assert.equal("disclosed_share_pct" in patched[2]!, false);
    assert.equal((graph.reverseIndex["name:avnet"]![0] as Record<string, unknown>).disclosed_share_pct, 23);
    assert.deepEqual(Object.keys(patched[0]!).slice(-3), ["disclosed_share_pct", "disclosed_share_quote", "evidence_quote"]);
    assert.equal(backfillGraph(graph, first.edges).report.stamped, 0);
  });

  it("writes a file back in its own format", () => {
    assert.equal(stringifyLike('{\r\n "a": 1\r\n}\r\n', { a: 1, b: 2 }), '{\r\n "a": 1,\r\n "b": 2\r\n}\r\n');
    assert.equal(stringifyLike('[\n  {\n    "a": 1\n  }\n]', [{ a: 1 }]), '[\n  {\n    "a": 1\n  }\n]');
  });
});

describe("strength tier: a percentage counts only when a quote states it", () => {
  const OPTUM = "OptumRx — — 17 % — —";

  it("the pipeline hands the classifier the verified share, not the model's percentage", () => {
    // 17% two years back (an earlier column): no share, so the tier is judged from the words.
    assert.equal(candidateShare({ disclosed_revenue_dependency_pct: 17, evidence_quote: OPTUM, evidence_quotes: [OPTUM] }).disclosed_share_pct, null);
    assert.equal(candidateShare({ disclosed_revenue_dependency_pct: 29.8, evidence_quote: AMKR_QUOTE, evidence_quotes: [AMKR_QUOTE] }).disclosed_share_pct, 29.8);
    // A percentage no quote writes at all.
    assert.equal(candidateShare({ disclosed_revenue_dependency_pct: 40, evidence_quote: "Apple is our largest customer." }).disclosed_share_pct, null);
    for (const prompt of [STRENGTH_CLASSIFY_SYSTEM, STRENGTH_CLASSIFY_BATCH_SYSTEM]) assert.match(prompt, /disclosed_revenue_dependency_pct is null/);
  });

  it("plans the recompute: a stated share gives its tier, an unstated one goes back to the classifier", () => {
    const optum = validated({
      root_ticker: "CAH",
      counterparty_name: "OptumRx",
      strength: 0.17,
      strength_tier: "critical",
      strength_basis: "disclosed",
      disclosed_share_pct: null,
      disclosed_share_quote: null,
      evidence: [{ quote: OPTUM, source_url: "https://www.sec.gov/x", located_at: "10-K Item 1/1A" }],
    });
    const apple = validated({
      counterparty_name: "Apple",
      strength: 0.298,
      strength_tier: "critical",
      strength_basis: "disclosed",
      disclosed_share_pct: 29.8,
      disclosed_share_quote: AMKR_QUOTE,
      evidence: [{ quote: AMKR_QUOTE, source_url: "https://www.sec.gov/x", located_at: "10-K Item 1/1A" }],
    });
    // A stated share whose tier was classified instead.
    const qualcomm = validated({
      counterparty_name: "Qualcomm",
      disclosed_share_pct: 11.1,
      disclosed_share_quote: AMKR_QUOTE,
      evidence: [{ quote: AMKR_QUOTE, source_url: "https://www.sec.gov/x", located_at: "10-K Item 1/1A" }],
    });
    const plain = validated({ counterparty_name: "Globex", disclosed_share_pct: null, disclosed_share_quote: null });
    const plan = tierRecomputePlan([optum, apple, qualcomm, plain]);
    assert.deepEqual(plan.reclassify, [0]);
    assert.deepEqual(plan.fromShare, [{ index: 2, resolved: { strength: 0.111, strength_tier: "critical", strength_basis: "disclosed" } }]);

    const fixed = withStrength(optum, { strength: 0.6, strength_tier: "important", strength_basis: "classified" });
    assert.deepEqual(Object.keys(fixed), Object.keys(optum));
    assert.deepEqual(tierRecomputePlan([fixed]), { fromShare: [], reclassify: [] });
  });
});
