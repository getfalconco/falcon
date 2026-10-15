import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONTEXT_MAX_HELD, holdingsOneHop, parseStockContextRequest } from "./stock-context";
import type { LinkEdge } from "./earnings-links";

const backed = (e: Partial<LinkEdge>): LinkEdge => ({
  source_url: "https://www.sec.gov/Archives/edgar/data/1/000.htm",
  evidence_quote: "a quote",
  accession_number: "0000000000-26-000001",
  confidence: 0.9,
  ...e,
});

describe("holdingsOneHop", () => {
  const edges: LinkEdge[] = [
    backed({ root_ticker: "NVDA", counterparty_ticker: "TSM", category: "supplier", strength_tier: "critical", form: "10-K", filing_date: "2026-02-20" }),
    backed({ root_ticker: "AAPL", counterparty_ticker: "nvda", category: "Customer", strength_tier: "marginal" }),
    backed({ root_ticker: "NVDA", counterparty_ticker: "AMD", category: "competitor", strength_tier: "important", confidence: 0.7 }),
    backed({ root_ticker: "AMD", counterparty_ticker: "NVDA", category: "competitor", strength_tier: "important", confidence: 0.95 }),
    // Not filing backed: no accession number.
    { root_ticker: "NVDA", counterparty_ticker: "MSFT", category: "customer", source_url: "https://www.sec.gov/x", evidence_quote: "q" },
    // Not about NVDA.
    backed({ root_ticker: "AAPL", counterparty_ticker: "TSM", category: "supplier", strength_tier: "critical" }),
    // A self link.
    backed({ root_ticker: "NVDA", counterparty_ticker: "NVDA", category: "related" }),
  ];

  it("names the holdings one filing-backed hop away, in either direction, strongest first", () => {
    const links = holdingsOneHop(edges, "nvda", ["TSM", "AAPL", "AMD", "MSFT", "XOM", "NVDA"], (filer) => (filer === "AAPL" ? "10-K" : null));
    assert.deepEqual(
      links.map((l) => [l.ticker, l.category, l.namedBy, l.named, l.form]),
      [
        ["TSM", "supplier", "NVDA", "TSM", "10-K"],
        ["AMD", "competitor", "AMD", "NVDA", null],
        ["AAPL", "customer", "AAPL", "NVDA", "10-K"],
      ],
    );
    assert.equal(links[0]!.filingDate, "2026-02-20");
  });

  it("is empty with no holdings, or none nearby", () => {
    assert.deepEqual(holdingsOneHop(edges, "NVDA", []), []);
    assert.deepEqual(holdingsOneHop(edges, "NVDA", ["XOM"]), []);
    assert.deepEqual(holdingsOneHop([], "NVDA", ["TSM"]), []);
  });
});

describe("parseStockContextRequest", () => {
  it("cleans the ticker and the held list", () => {
    assert.deepEqual(parseStockContextRequest({ ticker: " nvda ", held: ["aapl", "AAPL", "../x", 4, "BRK.B"] }), {
      ticker: "NVDA",
      held: ["AAPL", "BRK.B"],
    });
  });

  it("refuses a request that is not one", () => {
    assert.equal(parseStockContextRequest(null), null);
    assert.equal(parseStockContextRequest({ ticker: "", held: [] }), null);
    assert.equal(parseStockContextRequest({ ticker: "NVDA" }), null);
    assert.equal(parseStockContextRequest({ ticker: "NVDA", held: Array(CONTEXT_MAX_HELD + 1).fill("A") }), null);
  });
});
