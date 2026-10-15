import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  disclosedShare,
  extractEgo,
  neighbourRows,
  normalizeLinks,
  roleOf,
  sharedHoldings,
  strongestInfluence,
  tabOf,
  type RawGraphEdge,
} from "./stock-graph.js";

const URL = "https://www.sec.gov/Archives/edgar/data/1/x.htm";

function edge(root: string, cp: string, category: string, extra: Partial<RawGraphEdge> = {}): RawGraphEdge {
  const isTicker = /^[A-Z]{1,5}$/.test(cp);
  return {
    root_ticker: root,
    counterparty_id: isTicker ? cp : `name:${cp.toLowerCase()}`,
    counterparty_ticker: isTicker ? cp : null,
    counterparty_name: isTicker ? `${cp} Inc.` : cp,
    counterparty_type: "public_company",
    category,
    subtype: "",
    strength: 0.6,
    strength_tier: "important",
    confidence: 0.9,
    evidence_quote: `${root} names ${cp}`,
    source_url: URL,
    filing_date: "2026-02-04",
    accession_number: "0000000000-26-000001",
    ...extra,
  };
}

/**
 * NVDA's filing names TSM (supplier, critical) and AMD (competitor).
 * TSM's filing names NVDA as a customer (19% disclosed) and ASML as a supplier.
 * AAPL's filing names TSM as a supplier. MSFT names NVDA as a supplier.
 */
const EDGES: RawGraphEdge[] = [
  edge("NVDA", "TSM", "supplier", { strength: 1, strength_tier: "critical" }),
  edge("NVDA", "AMD", "competitor", { strength: 0.3, strength_tier: "marginal" }),
  edge("NVDA", "U.S. Government", "dependency", { counterparty_type: "government", strength: 1, strength_tier: "critical", confidence: 0.99 }),
  edge("TSM", "NVDA", "customer", { strength: 0.19, strength_tier: "critical" }),
  edge("TSM", "ASML", "supplier", { strength: 1, strength_tier: "critical" }),
  edge("AAPL", "TSM", "supplier", { strength: 1, strength_tier: "critical" }),
  edge("MSFT", "NVDA", "supplier"),
  edge("NVDA", "LowConf", "supplier", { confidence: 0.3 }),
  edge("NVDA", "NoQuote", "supplier", { evidence_quote: "" }),
  edge("NVDA", "NoUrl", "supplier", { source_url: "" }),
  edge("ZZZ", "YYY", "supplier"),
];

function graphFor(ticker: string, keep: string[] = []) {
  const { links, names } = normalizeLinks(EDGES, { minConfidence: 0.5, formOf: (t) => (t === "TSM" ? "20-F" : "10-K") });
  return extractEgo(links, names, ticker, { keep });
}

describe("normalizeLinks", () => {
  it("keeps filing-backed links at or above the confidence floor", () => {
    const { links } = normalizeLinks(EDGES, { minConfidence: 0.5 });
    const named = links.map((l) => l.named);
    assert.ok(!named.includes("name:lowconf"));
    assert.ok(!named.includes("name:noquote"));
    assert.ok(!named.includes("name:nourl"));
    assert.ok(named.includes("TSM"));
  });

  it("reads a disclosed share back from the strength, and none from a tier weight", () => {
    assert.equal(disclosedShare(0.19), 19);
    assert.equal(disclosedShare(0.298), 29.8);
    assert.equal(disclosedShare(0.6), null);
    assert.equal(disclosedShare(1), null);
    assert.equal(disclosedShare(0.3), null);
    assert.equal(disclosedShare(null), null);
  });

  it("fills the form from the filer's meta when the edge lacks it", () => {
    const g = graphFor("NVDA");
    const tsm = g.links.find((l) => l.filer === "TSM" && l.named === "NVDA");
    assert.equal(tsm?.form, "20-F");
    assert.equal(tsm?.share, 19);
  });
});

describe("extractEgo", () => {
  it("collects the first and second ring around the stock", () => {
    const g = graphFor("NVDA");
    const hop = Object.fromEntries(g.nodes.map((n) => [n.id, n.hop]));
    assert.equal(hop.NVDA, 0);
    assert.equal(hop.TSM, 1);
    assert.equal(hop.AMD, 1);
    assert.equal(hop.MSFT, 1);
    assert.equal(hop.ASML, 2);
    assert.equal(hop.AAPL, 2);
    assert.equal(hop.ZZZ, undefined, "unrelated links stay out");
    assert.equal(g.researched, true);
    assert.equal(g.name, "NVDA Inc.");
  });

  it("caps the outer ring but keeps links to the reader's holdings", () => {
    const { links, names } = normalizeLinks(EDGES, { minConfidence: 0.5 });
    const capped = extractEgo(links, names, "NVDA", { maxOuterLinks: 0 });
    assert.equal(capped.truncated, true);
    assert.ok(!capped.nodes.some((n) => n.id === "AAPL"));
    const kept = extractEgo(links, names, "NVDA", { maxOuterLinks: 0, keep: ["AAPL"] });
    assert.ok(kept.nodes.some((n) => n.id === "AAPL" && n.hop === 2));
  });

  it("answers an unresearched stock from the filings that name it", () => {
    const g = graphFor("ASML");
    assert.equal(g.researched, false);
    assert.ok(g.nodes.some((n) => n.id === "TSM" && n.hop === 1));
  });

  it("returns an empty graph for a stock nothing names", () => {
    const g = graphFor("QQQQ");
    assert.equal(g.links.length, 0);
    assert.equal(g.nodes.length, 1);
  });
});

describe("roles and categories", () => {
  it("reads a link from both ends", () => {
    const { links } = normalizeLinks([edge("TSM", "NVDA", "customer")]);
    assert.equal(roleOf(links[0]!, "NVDA"), "customer");
    assert.equal(roleOf(links[0]!, "TSM"), "supplier");
    const dep = normalizeLinks([edge("AAPL", "QCOM", "dependency")]).links[0]!;
    assert.equal(roleOf(dep, "QCOM"), "dependency");
    assert.equal(roleOf(dep, "AAPL"), "dependent");
  });

  it("maps roles and partner subtypes onto the four groups", () => {
    assert.equal(tabOf("supplier", ""), "suppliers");
    assert.equal(tabOf("customer", ""), "customers");
    assert.equal(tabOf("dependent", ""), "customers");
    assert.equal(tabOf("competitor", ""), "competitors");
    assert.equal(tabOf("dependency", "regulatory authority"), "dependencies");
    assert.equal(tabOf("partner", "licensor"), "suppliers");
    assert.equal(tabOf("partner", "wafer foundry"), "suppliers");
    assert.equal(tabOf("partner", "licensee"), "customers");
    assert.equal(tabOf("partner", "distributor"), "customers");
    assert.equal(tabOf("partner", "joint venture"), "dependencies");
  });

  it("groups the first ring by what each neighbour is to the stock", () => {
    const rows = neighbourRows(graphFor("NVDA"));
    assert.deepEqual(rows.suppliers.map((r) => r.id), ["TSM"]);
    assert.deepEqual(rows.competitors.map((r) => r.id), ["AMD"]);
    assert.deepEqual(rows.customers.map((r) => r.id), ["MSFT"]);
    assert.equal(rows.customers[0]!.inbound, true);
    assert.ok(rows.dependencies.some((r) => r.id === "name:u.s. government"));
  });
});

describe("the two questions", () => {
  it("names the strongest company link, never a government", () => {
    const top = strongestInfluence(graphFor("NVDA"));
    assert.ok(top);
    assert.equal(top.id, "TSM");
    assert.equal(top.link.tier, "critical");
  });

  it("passes over a stronger link to a government or a commodity", () => {
    const { links, names } = normalizeLinks([
      edge("X", "U.S. Government", "dependency", { counterparty_type: "government", strength: 1, strength_tier: "critical", confidence: 0.99 }),
      edge("X", "Lithium", "dependency", { counterparty_type: "commodity", strength: 1, strength_tier: "critical", confidence: 0.99 }),
      edge("X", "AAA", "supplier", { strength: 0.3, strength_tier: "marginal", confidence: 0.6 }),
    ]);
    assert.equal(strongestInfluence(extractEgo(links, names, "X"))?.id, "AAA");
  });

  it("prefers a disclosed share among equal tiers", () => {
    const { links, names } = normalizeLinks([
      edge("X", "AAA", "customer", { strength: 1, strength_tier: "critical" }),
      edge("X", "BBB", "customer", { strength: 0.22, strength_tier: "critical" }),
    ]);
    const top = strongestInfluence(extractEgo(links, names, "X"));
    assert.equal(top?.id, "BBB");
    assert.equal(top?.link.share, 22);
  });

  it("returns null when nothing is linked", () => {
    assert.equal(strongestInfluence(graphFor("QQQQ")), null);
  });

  it("finds holdings linked to the same companies", () => {
    const g = graphFor("NVDA", ["AAPL", "MSFT"]);
    const shared = sharedHoldings(g, ["AAPL", "NVDA", "MSFT", "ORCL"]);
    assert.deepEqual(shared, [{ ticker: "AAPL", shared: [{ id: "TSM", ticker: "TSM", name: "TSM Inc." }] }]);
  });
});
