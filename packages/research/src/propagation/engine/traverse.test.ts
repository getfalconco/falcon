import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { counterpartyKey, indexGraph, loadGraphIndexSync } from "./graph.js";
import { REVERSE_ROLES, capCandidates, compareCandidates, forwardRole, isTradableCounterparty, reverseRole, traverse } from "./traverse.js";
import { edge, realGraphPath, syntheticGraph } from "./test-fixtures.js";

describe("graph reader", () => {
  it("stamps the version and indexes forward/reverse edges", () => {
    const g = syntheticGraph();
    assert.equal(g.version.pipelineVersion, 5);
    assert.equal(g.version.generatedAt, "2026-08-13T22:38:11.325Z");
    assert.equal(g.forward.get("NVDA")?.length, 7);
    assert.equal(g.reverse.get("NVDA")?.length, 3);
    assert.ok(g.roots.has("NVDA") && g.roots.has("MSFT") && g.roots.has("ACME"));
  });

  it("keys name-only counterparties by their name id and tickered ones by ticker", () => {
    assert.equal(counterpartyKey({ counterparty_ticker: "tsm", counterparty_id: "TSM" }), "TSM");
    assert.equal(counterpartyKey({ counterparty_ticker: null, counterparty_id: "name:samsung" }), "name:samsung");
  });

  it("tolerates a file with missing fields", () => {
    const g = indexGraph({});
    assert.equal(g.edges.length, 0);
    assert.equal(g.version.generatedAt, "unknown");
    assert.equal(g.version.pipelineVersion, 0);
  });
});

describe("traversal (§4)", () => {
  const g = syntheticGraph();

  it("forward edges keep their category as the role", () => {
    const r = traverse(g, "NVDA");
    const tsm = r.candidates.find((c) => c.target === "TSM");
    assert.ok(tsm);
    assert.equal(tsm.relationship.role, "supplier");
    assert.equal(tsm.relationship.via, "forward");
    assert.equal(tsm.ticker, "TSM");
  });

  it("golden: a TSM event reaches NVDA as a customer through NVDA's own supplier edge", () => {
    const r = traverse(g, "TSM");
    assert.equal(r.candidates.length, 1);
    const nvda = r.candidates[0];
    assert.equal(nvda.target, "NVDA");
    assert.equal(nvda.relationship.role, "customer");
    assert.equal(nvda.relationship.via, "reverse");
    assert.equal(nvda.relationship.subtype, "wafer_fabrication");
    assert.match(nvda.relationship.evidence_quote, /TSMC/);
  });

  it("inverts every reverse role as specified", () => {
    assert.deepEqual(REVERSE_ROLES, {
      supplier: "customer",
      customer: "supplier",
      competitor: "competitor",
      partner: "partner",
      dependency: "depended_on_by",
    });
    assert.equal(reverseRole("dependency"), "depended_on_by");
    assert.equal(forwardRole("dependency"), "dependency");
    assert.equal(forwardRole("unknown"), null);
  });

  it("MSFT listing NVDA as supplier makes MSFT NVDA's customer; a competitor pair asserted both ways merges", () => {
    const r = traverse(g, "NVDA");
    const msftCustomer = r.candidates.find((c) => c.target === "MSFT" && c.relationship.role === "customer");
    assert.ok(msftCustomer, "reverse customer present");
    assert.equal(msftCustomer.relationship.tier, "critical");
    assert.equal(msftCustomer.relationship.via, "reverse");
    // MSFT also appears as a forward competitor — a distinct relationship.
    const msftComp = r.candidates.find((c) => c.target === "MSFT" && c.relationship.role === "competitor");
    assert.ok(msftComp);

    const amd = r.candidates.filter((c) => c.target === "AMD");
    assert.equal(amd.length, 1, "competitor pair deduped to one relationship");
    // The reverse edge outranks (important > marginal): it wins, the forward is merged.
    assert.equal(amd[0].relationship.tier, "important");
    assert.equal(amd[0].relationship.via, "both");
    assert.deepEqual([...amd[0].relationship.edge_ids].sort(), ["AMD:NVDA:competitor", "NVDA:AMD:competitor"]);
    assert.equal(amd[0].relationship.merged_evidence.length, 1);
  });

  it("a company that lists the root as a dependency is depended_on_by the root", () => {
    const r = traverse(g, "NVDA");
    const acme = r.candidates.find((c) => c.target === "ACME");
    assert.ok(acme);
    assert.equal(acme.relationship.role, "depended_on_by");
  });

  it("name-only counterparties are legitimate targets with no ticker", () => {
    const r = traverse(g, "NVDA");
    const samsung = r.candidates.find((c) => c.target === "name:samsung electronics");
    assert.ok(samsung);
    assert.equal(samsung.ticker, null);
    assert.equal(samsung.label, "Samsung Electronics");
    assert.equal(samsung.relationship.role, "supplier");
  });

  it("orders by strength tier desc, confidence desc, tickered before name-only", () => {
    const r = traverse(g, "NVDA");
    const tiers = r.candidates.map((c) => c.relationship.tier);
    const rank = { critical: 3, important: 2, marginal: 1 } as const;
    for (let i = 1; i < tiers.length; i++) assert.ok(rank[tiers[i - 1]] >= rank[tiers[i]]);
    assert.equal(r.candidates[0].relationship.tier, "critical");
    const sorted = [...r.candidates].sort(compareCandidates);
    assert.deepEqual(sorted.map((c) => c.target + c.relationship.role), r.candidates.map((c) => c.target + c.relationship.role));
  });

  it("counts edges seen and caps with overflow, never silently", () => {
    const r = traverse(g, "NVDA");
    assert.equal(r.edges_seen, 10);
    const { kept, overflow } = capCandidates(r.candidates, 3);
    assert.equal(kept.length, 3);
    assert.equal(overflow, r.candidates.length - 3);
    assert.deepEqual(capCandidates([1, 2], 5), { kept: [1, 2], overflow: 0 });
  });

  it("a root with no edges yields an empty, valid traversal", () => {
    const r = traverse(g, "ZZZZ");
    assert.deepEqual(r, { root_ticker: "ZZZZ", candidates: [], edges_seen: 0, non_tradable: 0 });
  });

  it("self-loops are not targets", () => {
    const self = indexGraph({
      edges: [
        {
          id: "X:X",
          root_ticker: "X",
          counterparty_id: "X",
          counterparty_name: "X",
          counterparty_ticker: "X",
          category: "partner",
          subtype: "",
          confidence: 1,
          evidence_quote: "",
          source_url: "",
          valid_from: "2026-01-01",
        },
      ],
    });
    assert.equal(traverse(self, "X").candidates.length, 0);
  });
});

describe("traversal on the real graph (when present)", () => {
  const file = realGraphPath();
  it("TSM event → NVDA appears as customer via NVDA's wafer_fabrication supplier edge", { skip: !file }, () => {
    const g = loadGraphIndexSync(file!);
    assert.ok(g.version.pipelineVersion >= 5);
    const r = traverse(g, "TSM");
    const nvda = r.candidates.find((c) => c.target === "NVDA");
    assert.ok(nvda, "NVDA reachable from TSM");
    assert.equal(nvda.relationship.role, "customer");
    assert.equal(nvda.relationship.via, "reverse");
    assert.equal(nvda.relationship.subtype, "wafer_fabrication");
    // QCOM and AMD also list TSM as a foundry supplier → customers of TSM.
    const roles = new Map(r.candidates.map((c) => [c.target, c.relationship.role]));
    assert.equal(roles.get("QCOM"), "customer");
    assert.equal(roles.get("AMD"), "customer");
  });

  it("NVDA reaches name-only and tickered counterparties without editing the graph", { skip: !file }, () => {
    const g = loadGraphIndexSync(file!);
    const before = JSON.stringify(g.edges.slice(0, 3));
    const r = traverse(g, "NVDA");
    assert.ok(r.candidates.length >= 20);
    assert.ok(r.candidates.some((c) => c.ticker === null));
    assert.ok(r.candidates.some((c) => c.target === "TSM" && c.relationship.role === "supplier"));
    assert.equal(JSON.stringify(g.edges.slice(0, 3)), before);
  });
});

describe("isTradableCounterparty", () => {
  it("admits a public company", () => {
    assert.equal(isTradableCounterparty({ counterparty_type: "public_company" }), true);
  });

  it("refuses the kinds that can never carry a price", () => {
    // Measured on the 2026-08-26 graph, these were 371 of 1,001 edges: FDA,
    // Medicaid, NASA, the U.S. Army, private names and product lines. Each one
    // could only ever ship `pricing: unknown` while holding a target slot.
    for (const kind of ["government", "private_company", "product", "commodity", "other"]) {
      assert.equal(isTradableCounterparty({ counterparty_type: kind }), false, kind);
    }
  });

  it("admits an edge written before the field existed", () => {
    // A graph built by an older pipeline must keep behaving exactly as it did,
    // rather than silently losing every target the day this shipped.
    assert.equal(isTradableCounterparty({ counterparty_type: undefined }), true);
    assert.equal(isTradableCounterparty({ counterparty_type: null }), true);
  });
});

describe("traverse — non-tradable counterparties", () => {
  it("keeps a government counterparty out of the candidate list and counts it", () => {
    const graph = indexGraph({ nodes: [], edges: [
      edge("NVDA:TSM:supplier", "NVDA", { ticker: "TSM", name: "Taiwan Semiconductor" }, "supplier", {
        counterparty_type: "public_company",
      }),
      edge("NVDA:fda:dependency", "NVDA", { ticker: null, name: "FDA" }, "dependency", {
        counterparty_type: "government",
      }),
      edge("NVDA:openai:partner", "NVDA", { ticker: null, name: "OpenAI" }, "partner", {
        counterparty_type: "private_company",
      }),
    ] });
    const result = traverse(graph, "NVDA");
    assert.deepEqual(
      result.candidates.map((c) => c.ticker),
      ["TSM"],
    );
    assert.equal(result.non_tradable, 2);
  });

  it("leaves a graph with no counterparty_type untouched", () => {
    const result = traverse(syntheticGraph(), "NVDA");
    assert.equal(result.non_tradable, 0);
    assert.ok(result.candidates.length > 0);
  });
});
