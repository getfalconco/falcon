import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildGraphFromResearchDir, type GraphHygieneDiagnostics } from "./buildGraph.js";
import {
  canonicalCounterparty,
  canonicalCounterpartyKey,
  sanitizeCounterpartyTicker,
} from "./canonical.js";
import type { ValidatedEdge } from "./types.js";

describe("graph hygiene: canonicalCounterpartyKey", () => {
  it("collapses legal-form variants, dotted abbreviations and SEC title junk", () => {
    assert.equal(canonicalCounterpartyKey("Samsung Electronics Co., Ltd."), "samsung electronics");
    assert.equal(canonicalCounterpartyKey("Samsung"), "samsung electronics");
    assert.equal(canonicalCounterpartyKey("Huawei Technologies Co. Ltd."), "huawei technologies");
    assert.equal(canonicalCounterpartyKey("Huawei"), "huawei technologies");
    assert.equal(
      canonicalCounterpartyKey("Hon Hai Precision Industry Co., Ltd."),
      "hon hai precision industry",
    );
    assert.equal(canonicalCounterpartyKey("Foxconn Technology Group"), "hon hai precision industry");
    assert.equal(canonicalCounterpartyKey("AMD"), "advanced micro devices");
    assert.equal(canonicalCounterpartyKey("ADVANCED MICRO DEVICES INC"), "advanced micro devices");
    assert.equal(canonicalCounterpartyKey("ASML Holding N.V."), "asml holding");
    assert.equal(canonicalCounterpartyKey("Qualcomm Incorporated"), "qualcomm");
    assert.equal(canonicalCounterpartyKey("QUALCOMM INC/DE"), "qualcomm");
    assert.equal(canonicalCounterpartyKey("NORTHROP GRUMMAN CORP /DE/"), "northrop grumman");
    assert.equal(canonicalCounterpartyKey("The Boeing Company"), "boeing");
    assert.equal(canonicalCounterpartyKey("U.S. Department of Defense"), "us department of defense");
    assert.equal(canonicalCounterpartyKey("Department of Defense"), "us department of defense");
    assert.equal(canonicalCounterpartyKey("Komatsu Financial L.P."), "komatsu financial");
  });

  it("does not mangle names that merely contain a slash or a single token", () => {
    assert.equal(canonicalCounterpartyKey("Siemens Mobility A/S"), "siemens mobility a s");
    assert.equal(canonicalCounterpartyKey("Co"), "co");
    assert.equal(canonicalCounterpartyKey("Volvo Penta AB"), "volvo penta");
    assert.equal(canonicalCounterpartyKey("OpenAI", { applyAliases: false }), "openai");
    assert.equal(canonicalCounterpartyKey("Samsung", { applyAliases: false }), "samsung");
  });
});

describe("graph hygiene: sanitizeCounterpartyTicker", () => {
  it("clears the SKHY blocklist entry and keeps real symbols", () => {
    assert.deepEqual(sanitizeCounterpartyTicker("SKHY"), { ticker: null, clearedReason: "blocklist" });
    assert.deepEqual(sanitizeCounterpartyTicker("skhy"), { ticker: null, clearedReason: "blocklist" });
    assert.deepEqual(sanitizeCounterpartyTicker("tsm"), { ticker: "TSM", clearedReason: null });
    assert.deepEqual(sanitizeCounterpartyTicker(null), { ticker: null, clearedReason: null });
    assert.deepEqual(sanitizeCounterpartyTicker("  "), { ticker: null, clearedReason: null });
  });

  it("applies an optional symbol catalog", () => {
    const knownTickers = new Set(["TSM", "AMD"]);
    assert.deepEqual(sanitizeCounterpartyTicker("TSM", { knownTickers }), {
      ticker: "TSM",
      clearedReason: null,
    });
    assert.deepEqual(sanitizeCounterpartyTicker("AOMFF", { knownTickers }), {
      ticker: null,
      clearedReason: "not_in_catalog",
    });
    // An empty catalog means "no catalog" — never clears everything.
    assert.deepEqual(sanitizeCounterpartyTicker("AOMFF", { knownTickers: new Set() }), {
      ticker: "AOMFF",
      clearedReason: null,
    });
  });

  it("canonicalCounterparty gives the per-edge node id", () => {
    assert.deepEqual(
      canonicalCounterparty({ counterparty_name: "SK Hynix Inc.", counterparty_ticker: "SKHY" }),
      { id: "name:sk hynix", ticker: null },
    );
    assert.deepEqual(canonicalCounterparty({ counterparty_name: "Samsung", counterparty_ticker: null }), {
      id: "name:samsung electronics",
      ticker: null,
    });
    assert.deepEqual(
      canonicalCounterparty({ counterparty_name: "Intel Corp.", counterparty_ticker: "intc" }),
      { id: "INTC", ticker: "INTC" },
    );
  });
});

describe("graph hygiene: buildGraphFromResearchDir", () => {
  const mkEdge = (
    root: string,
    name: string,
    ticker: string | null,
    category: ValidatedEdge["category"],
    subtype: string,
    quote: string,
  ): ValidatedEdge => ({
    root_ticker: root,
    counterparty_name: name,
    counterparty_ticker: ticker,
    counterparty_type: ticker ? "public_company" : "private_company",
    category,
    subtype,
    strength: 0.6,
    strength_tier: "important",
    strength_basis: "classified",
    epistemic_label: "VERIFIED",
    confidence: 0.9,
    evidence: [{ quote, source_url: "https://sec.gov/x", located_at: "10-K Item 1/1A" }],
    valid_from: "2026-02-25",
    shared_evidence_group: "ev_test",
  });

  async function writeFixture(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-graph-hygiene-"));
    const nvda = [
      mkEdge("NVDA", "Samsung Electronics Co., Ltd.", null, "supplier", "wafer_fabrication", "We utilize Samsung Electronics Co., Ltd. foundries"),
      mkEdge("NVDA", "Samsung", null, "supplier", "memory", "We purchase memory from Samsung"),
      mkEdge("NVDA", "Samsung", null, "competitor", "", "We compete with Samsung"),
      mkEdge("NVDA", "Huawei Technologies Co. Ltd.", null, "competitor", "", "Huawei Technologies Co. Ltd. competes"),
      mkEdge("NVDA", "Huawei", null, "customer", "", "Huawei is a customer"),
      mkEdge("NVDA", "SK Hynix Inc.", "SKHY", "supplier", "memory", "We purchase memory from SK Hynix Inc."),
      mkEdge("NVDA", "AMD", null, "competitor", "", "We compete with AMD"),
      mkEdge("NVDA", "Intel Corporation", "INTC", "competitor", "", "We compete with Intel Corporation"),
    ];
    const amd = [
      mkEdge("AMD", "Intel Corp.", "INTC", "competitor", "", "We compete with Intel Corp."),
      mkEdge("AMD", "Taiwan Semiconductor Manufacturing Company Limited", "TSM", "supplier", "foundry", "TSMC makes our wafers"),
      mkEdge("AMD", "Samsung Electronics", null, "supplier", "foundry", "Samsung Electronics makes wafers"),
    ];
    const intc = [mkEdge("INTC", "TSMC", null, "competitor", "", "We compete with TSMC")];
    await writeFile(path.join(dir, "NVDA.json"), JSON.stringify(nvda));
    await writeFile(
      path.join(dir, "NVDA.meta.json"),
      JSON.stringify({ companyName: "NVIDIA CORP", filingDate: "2026-02-25", accessionNumber: "0001045810-26-000021" }),
    );
    await writeFile(path.join(dir, "AMD.json"), JSON.stringify(amd));
    await writeFile(path.join(dir, "AMD.meta.json"), JSON.stringify({ companyName: "ADVANCED MICRO DEVICES INC" }));
    await writeFile(path.join(dir, "INTC.json"), JSON.stringify(intc));
    await writeFile(path.join(dir, "INTC.meta.json"), JSON.stringify({ companyName: "INTEL CORP" }));
    return dir;
  }

  it("collapses Samsung / Huawei variants, folds AMD and TSMC onto ticker nodes, clears SKHY", async () => {
    const dir = await writeFixture();
    try {
      let diag: GraphHygieneDiagnostics | undefined;
      const graph = await buildGraphFromResearchDir(dir, { onDiagnostics: (d) => (diag = d) });

      // No edge dropped.
      assert.equal(graph.edgeCount, 12);
      assert.equal(graph.edges.length, 12);

      // Samsung: one node, most complete label, all four edges (3 NVDA + 1 AMD) attached.
      const samsungNodes = graph.nodes.filter((n) => /samsung/i.test(n.id));
      assert.equal(samsungNodes.length, 1);
      assert.equal(samsungNodes[0]!.id, "name:samsung electronics");
      assert.equal(samsungNodes[0]!.label, "Samsung Electronics Co., Ltd.");
      assert.equal(graph.reverseIndex["name:samsung electronics"]!.length, 4);
      assert.deepEqual(
        graph.reverseIndex["name:samsung electronics"]!.map((e) => e.counterparty_name).sort(),
        ["Samsung", "Samsung", "Samsung Electronics", "Samsung Electronics Co., Ltd."],
      );

      // Huawei: one node.
      const huaweiNodes = graph.nodes.filter((n) => /huawei/i.test(n.id));
      assert.equal(huaweiNodes.length, 1);
      assert.equal(huaweiNodes[0]!.label, "Huawei Technologies Co. Ltd.");
      assert.equal(graph.reverseIndex["name:huawei technologies"]!.length, 2);

      // "AMD" name → AMD ticker node (root), and counterparty_ticker set so propagation sees it.
      assert.equal(graph.nodes.some((n) => n.id === "name:amd"), false);
      const amdEdge = graph.edges.find((e) => e.root_ticker === "NVDA" && e.counterparty_name === "AMD")!;
      assert.equal(amdEdge.counterparty_id, "AMD");
      assert.equal(amdEdge.counterparty_ticker, "AMD");
      assert.equal(graph.nodes.find((n) => n.id === "AMD")!.kind, "ticker");

      // "TSMC" name → TSM ticker node (tickered counterparty from AMD's file).
      const tsmcEdge = graph.edges.find((e) => e.counterparty_name === "TSMC")!;
      assert.equal(tsmcEdge.counterparty_id, "TSM");
      assert.equal(tsmcEdge.counterparty_ticker, "TSM");
      assert.equal(graph.nodes.some((n) => n.id === "name:taiwan semiconductor manufacturing"), false);

      // SKHY rejected: name node kept, ticker cleared, no SKHY node.
      const hynix = graph.edges.find((e) => e.counterparty_name === "SK Hynix Inc.")!;
      assert.equal(hynix.counterparty_ticker, null);
      assert.equal(hynix.counterparty_id, "name:sk hynix");
      assert.equal(graph.nodes.some((n) => n.id === "SKHY"), false);
      assert.equal(graph.nodes.find((n) => n.id === "name:sk hynix")!.kind, "name");

      // Real tickers untouched; INTC node is a ticker node with both inbound edges.
      assert.equal(graph.reverseIndex["INTC"]!.length, 2);
      assert.equal(
        graph.edges.find((e) => e.root_ticker === "AMD" && e.counterparty_ticker === "TSM")!.counterparty_id,
        "TSM",
      );

      // Node set: NVDA, AMD, INTC, TSM, name:samsung electronics, name:huawei technologies, name:sk hynix.
      assert.deepEqual(
        graph.nodes.map((n) => n.id).sort(),
        ["AMD", "INTC", "NVDA", "TSM", "name:huawei technologies", "name:samsung electronics", "name:sk hynix"],
      );

      // Diagnostics.
      assert.ok(diag);
      assert.deepEqual(diag!.clearedTickers, [
        { ticker: "SKHY", counterparty_name: "SK Hynix Inc.", root_ticker: "NVDA", reason: "blocklist", nodeId: "name:sk hynix" },
      ]);
      // AMD is a fold (one legacy id → ticker node), not a cluster; TSM absorbed "name:tsmc".
      const clusterIds = diag!.collapsedClusters.map((c) => c.nodeId).sort((a, b) => (a < b ? -1 : 1));
      assert.deepEqual(clusterIds, ["TSM", "name:huawei technologies", "name:samsung electronics"]);
      const samsungCluster = diag!.collapsedClusters.find((c) => c.nodeId === "name:samsung electronics")!;
      assert.deepEqual(samsungCluster.legacyIds, ["name:samsung", "name:samsung electronics"]);
      assert.equal(samsungCluster.edgeCount, 4);
      assert.deepEqual(
        diag!.foldedIntoTicker.map((f) => `${f.root_ticker}:${f.counterparty_name}->${f.ticker}`),
        ["INTC:TSMC->TSM", "NVDA:AMD->AMD"],
      );

      // Deterministic: a second build yields identical node/edge ids.
      const again = await buildGraphFromResearchDir(dir);
      assert.deepEqual(again.nodes, graph.nodes);
      assert.deepEqual(
        again.edges.map((e) => e.id),
        graph.edges.map((e) => e.id),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clears tickers outside a supplied catalog but never blocklisted ones", async () => {
    const dir = await writeFixture();
    try {
      let diag: GraphHygieneDiagnostics | undefined;
      const graph = await buildGraphFromResearchDir(dir, {
        knownTickers: new Set(["INTC"]),
        onDiagnostics: (d) => (diag = d),
      });
      const tsmEdge = graph.edges.find(
        (e) => e.root_ticker === "AMD" && /Taiwan Semiconductor/.test(e.counterparty_name),
      )!;
      assert.equal(tsmEdge.counterparty_ticker, null);
      assert.equal(tsmEdge.counterparty_id, "name:taiwan semiconductor manufacturing");
      // The INTC "TSMC" name edge now lands on the same name node (no TSM ticker node to fold onto).
      assert.equal(graph.reverseIndex["name:taiwan semiconductor manufacturing"]!.length, 2);
      assert.deepEqual(
        diag!.clearedTickers.map((c) => `${c.ticker}:${c.reason}`).sort(),
        ["SKHY:blocklist", "TSM:not_in_catalog"],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
