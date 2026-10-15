import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildGraphFromResearchDir } from "./buildGraph.js";
import { dedupeCandidates } from "./dedupe.js";
import { backfillGraph, backfillRootEdges, stringifyLike } from "./disclosedShareBackfill.js";
import { disclosedShareFromEvidence, disclosedShareOfEdge, quoteStatesPct } from "./strength.js";
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
