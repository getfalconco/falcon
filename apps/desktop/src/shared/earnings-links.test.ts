import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { indexLinks, isFilingBacked, readsThrough, type LinkEdge } from "./earnings-links";

function edge(root: string, other: string | null, over: Partial<LinkEdge> = {}): LinkEdge {
  return {
    root_ticker: root,
    counterparty_ticker: other,
    category: "supplier",
    strength_tier: "important",
    confidence: 0.95,
    evidence_quote: "We depend on Taiwan Semiconductor Manufacturing Company for our wafers.",
    source_url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000012/nvda-20260125.htm",
    accession_number: "0001045810-26-000012",
    filing_date: "2026-02-25",
    ...over,
  };
}

const held = new Set(["NVDA", "AMD", "AAPL"]);
const watch = new Set(["ASML", "MSFT"]);

describe("filing-backed links", () => {
  it("needs an SEC address, the quote and the accession number", () => {
    assert.equal(isFilingBacked(edge("NVDA", "TSM")), true);
    assert.equal(isFilingBacked(edge("NVDA", "TSM", { source_url: "https://example.com/blog" })), false);
    assert.equal(isFilingBacked(edge("NVDA", "TSM", { evidence_quote: " " })), false);
    assert.equal(isFilingBacked(edge("NVDA", "TSM", { accession_number: null })), false);
    assert.equal(isFilingBacked(edge("NVDA", "TSM", { source_url: undefined })), false);
  });
});

describe("reads through to", () => {
  it("finds the reader's names linked in either direction", () => {
    const index = indexLinks([
      // NVDA's 10-K names TSM.
      edge("NVDA", "TSM"),
      // TSM's 20-F names ASML.
      edge("TSM", "ASML", { category: "supplier", strength_tier: "critical" }),
    ]);
    const links = readsThrough(index, "TSM", held, watch, (filer) => (filer === "TSM" ? "20-F" : "10-K"));
    assert.deepEqual(
      links.map((l) => [l.ticker, l.held, l.watchlist, l.namedBy, l.named, l.form, l.tier]),
      [
        ["NVDA", true, false, "NVDA", "TSM", "10-K", "important"],
        ["ASML", false, true, "TSM", "ASML", "20-F", "critical"],
      ],
    );
  });

  it("keeps only filing-backed, confident links the filing calls material", () => {
    const index = indexLinks([
      edge("NVDA", "TSM", { strength_tier: "marginal" }),
      edge("AMD", "TSM", { confidence: 0.6 }),
      edge("AAPL", "TSM", { source_url: "https://news.example.com/x" }),
      edge("MSFT", "TSM", { strength_tier: undefined }),
      edge("TSM", null),
      edge("TSM", "TSM"),
    ]);
    assert.deepEqual(readsThrough(index, "TSM", held, watch), []);
  });

  it("names only the reader's own companies", () => {
    const index = indexLinks([edge("QCOM", "TSM"), edge("AVGO", "TSM")]);
    assert.deepEqual(readsThrough(index, "TSM", held, watch), []);
  });

  it("puts held names first, then critical before important, at most three, one per company", () => {
    const index = indexLinks([
      edge("ASML", "TSM", { strength_tier: "critical" }),
      edge("NVDA", "TSM", { strength_tier: "important", confidence: 0.9 }),
      edge("NVDA", "TSM", { strength_tier: "critical", category: "dependency", confidence: 0.85 }),
      edge("AMD", "TSM"),
      edge("AAPL", "TSM", { confidence: 0.82 }),
      edge("MSFT", "TSM"),
    ]);
    const links = readsThrough(index, "TSM", held, watch);
    assert.deepEqual(
      links.map((l) => [l.ticker, l.tier, l.category]),
      [
        ["NVDA", "critical", "dependency"],
        ["AMD", "important", "supplier"],
        ["AAPL", "important", "supplier"],
      ],
    );
  });

  it("carries the form when the edge has it, and the filer's when it does not", () => {
    const index = indexLinks([edge("NVDA", "TSM", { form: "10-K" }), edge("AMD", "TSM")]);
    const links = readsThrough(index, "TSM", held, watch, () => null);
    assert.deepEqual(
      links.map((l) => [l.ticker, l.form]),
      [
        ["AMD", null],
        ["NVDA", "10-K"],
      ],
    );
  });
});
