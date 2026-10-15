import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems, textProblems } from "../../../../shared/copy-rules";
import { extractEgo, neighbourRows, normalizeLinks, type RawGraphEdge } from "../../../../shared/stock-graph";
import * as stocktab from "../../../lib/i18n/messages/areas/stocktab";
import { VIEW_H, VIEW_W, egoLayout, isWeak, nodeLabel } from "./ego-layout";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = "https://www.sec.gov/x.htm";

function edge(root: string, cp: string, category: string, tier = "important", confidence = 0.9): RawGraphEdge {
  return {
    root_ticker: root,
    counterparty_id: cp,
    counterparty_ticker: cp,
    counterparty_name: `${cp} Inc.`,
    category,
    subtype: "",
    strength_tier: tier,
    strength: { critical: 1, important: 0.6, marginal: 0.3 }[tier as "critical"],
    confidence,
    evidence_quote: "q",
    source_url: URL,
  };
}

function layoutFor(edges: RawGraphEdge[], ticker: string, prefer: string[] = []) {
  const { links, names } = normalizeLinks(edges, { minConfidence: 0.5 });
  const graph = extractEgo(links, names, ticker, { keep: prefer });
  return egoLayout(graph, neighbourRows(graph), { prefer });
}

describe("egoLayout", () => {
  const many = [
    ...Array.from({ length: 30 }, (_, i) => edge("CAT", `C${i}`, "competitor", "marginal")),
    ...Array.from({ length: 4 }, (_, i) => edge("CAT", `S${i}`, "supplier", "critical")),
    ...Array.from({ length: 12 }, (_, i) => edge(`S${i % 4}`, `O${i}`, "supplier")),
    edge("S0", "AAPL", "customer", "marginal"),
  ];

  it("caps the drawing and keeps every node inside the view", () => {
    const layout = layoutFor(many, "CAT");
    const inner = layout.nodes.filter((n) => n.hop === 1);
    const outer = layout.nodes.filter((n) => n.hop === 2);
    assert.ok(inner.length <= 14);
    assert.ok(outer.length <= 8);
    assert.ok(layout.hiddenNeighbours > 0);
    for (const n of layout.nodes) {
      assert.ok(n.x >= 0 && n.x <= VIEW_W && n.y >= 0 && n.y <= VIEW_H, `${n.id} at ${n.x},${n.y}`);
    }
    // Every group is represented, the suppliers on the left, competitors above.
    const sup = inner.filter((n) => n.tab === "suppliers");
    const comp = inner.filter((n) => n.tab === "competitors");
    assert.equal(sup.length, 4);
    assert.ok(sup.every((n) => n.x < VIEW_W / 2));
    assert.ok(comp.every((n) => n.y < VIEW_H / 2));
  });

  it("draws a holding in the outer ring before stronger strangers", () => {
    const layout = layoutFor(many, "CAT", ["AAPL"]);
    assert.ok(layout.nodes.some((n) => n.id === "AAPL" && n.hop === 2));
  });

  it("draws each neighbour once and every edge between drawn nodes", () => {
    const layout = layoutFor([edge("X", "A", "supplier"), edge("X", "A", "competitor", "marginal"), edge("A", "B", "supplier")], "X");
    assert.equal(layout.nodes.filter((n) => n.id === "A").length, 1);
    const ids = new Set(layout.nodes.map((n) => n.id));
    assert.ok(layout.edges.every((e) => ids.has(e.from) && ids.has(e.to)));
  });

  it("marks marginal and lower confidence links as weak", () => {
    const { links } = normalizeLinks([edge("X", "A", "supplier", "marginal"), edge("X", "B", "supplier", "important", 0.6), edge("X", "C", "supplier")]);
    assert.deepEqual(links.map(isWeak), [true, true, false]);
  });

  it("shortens names to fit a label", () => {
    assert.equal(nodeLabel("TSM", "Taiwan Semiconductor"), "TSM");
    assert.equal(nodeLabel(null, "Samsung Electronics Co., Ltd."), "Samsung");
    assert.equal(nodeLabel(null, "OpenAI OpCo, LLC"), "OpenAI OpCo");
    assert.equal(nodeLabel(null, "Citibank, N.A."), "Citibank");
    assert.equal(nodeLabel(null, "Central Bank of the Republic of China"), "Central Bank");
  });
});

describe("Graph and chain news copy", () => {
  it("follows the house copy rules in every language", () => {
    for (const [lang, table] of Object.entries(stocktab)) {
      for (const [key, text] of Object.entries(table as Record<string, string>)) {
        if (!key.startsWith("stocktab.graph.") && !key.startsWith("stocktab.chain.")) continue;
        assert.deepEqual(textProblems(text), [], `${lang} ${key}`);
        assert.ok(!text.includes("!"), `${lang} ${key}`);
      }
    }
  });

  it("carries every key into every language with its placeholders", () => {
    const en = stocktab.en as Record<string, string>;
    const keys = Object.keys(en).filter((k) => k.startsWith("stocktab.graph.") || k.startsWith("stocktab.chain."));
    for (const [lang, table] of Object.entries(stocktab)) {
      if (lang === "en") continue;
      for (const key of keys) {
        const text = (table as Record<string, string>)[key];
        assert.ok(text, `${lang} misses ${key}`);
        const want = (en[key]!.match(/\{\w+\}/g) ?? []).sort();
        assert.deepEqual((text.match(/\{\w+\}/g) ?? []).sort(), want, `${lang} ${key}`);
      }
    }
  });

  it("keeps the section sources clean", () => {
    for (const file of [
      "../sections/GraphSection.tsx",
      "../sections/ChainNewsSection.tsx",
      "./EgoGraph.tsx",
      "./ego-layout.ts",
      "./use-stock-graph.ts",
    ]) {
      const src = fs.readFileSync(path.join(HERE, file), "utf8");
      assert.deepEqual(copyProblems(src, { jsxText: true }), [], file);
    }
  });
});
