import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { diffConcentration, diffHeadings } from "./diff";
import { digestOf, type FilingLike } from "./digest";
import { findSection, LARGEST_CUSTOMER, readDocument, riskHeadings, riskReadability } from "./parse";

/**
 * Real EDGAR filings, read end to end. Each fixture (fixtures/edgar/*.html.gz)
 * is the filing's primary document with its markup slimmed to what the reader
 * looks at (ids, in-document links, bold, italic, underline, font size,
 * hidden), the table of contents and the risk factors section kept whole, and
 * the rest of the text replaced by filler of the same length (its ids kept),
 * so a section's share of the document is what it is in the filing. The
 * SMCI reports also keep their customer concentration notes whole.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (name: string) => zlib.gunzipSync(fs.readFileSync(path.join(HERE, "fixtures", "edgar", name))).toString("utf8");

function filingOf(form: string): FilingLike {
  return { cik: "1", form, accession: "x", filedAt: "2026-01-01", items: [], primaryDocument: "x.htm", url: "https://www.sec.gov/Archives/edgar/data/1/x/x.htm" };
}

type Case = {
  file: string;
  form: string;
  via: "toc" | "heading";
  count: number;
  first?: string;
  last?: string;
  /** Headings that must be among those read, verbatim. */
  has?: string[];
  noMaterialChanges?: boolean;
};

const CASES: Case[] = [
  // Integrated reports: the table of contents is the only reliable map.
  {
    file: "intc-10k-2025.html.gz",
    form: "10-K",
    via: "toc",
    count: 19,
    first: "We are in a highly competitive and rapidly changing industry.",
    last: "We are subject to risks associated with environmental, health, safety and product regulations.",
    has: ["We rely upon a complex global supply chain.", "There are a number of risks and uncertainties associated with the U.S. government’s acquisition of significant equity interests in us."],
  },
  { file: "intc-10q-2026q2.html.gz", form: "10-Q", via: "toc", count: 0, noMaterialChanges: false },
  {
    file: "asml-20f-2025.html.gz",
    form: "20-F",
    via: "toc",
    count: 27,
    has: [
      "A high percentage of net sales is derived from a few customers",
      "We are highly dependent on the performance of a limited number of critical suppliers of single-source key components",
      "We are exposed to risks related to the use of artificial intelligence",
    ],
    last: "We may not declare cash dividends, conduct share buybacks at all or in any particular amounts in any given year",
  },
  // Regressions: these read well before and read the same now.
  { file: "nvda-10k-2026.html.gz", form: "10-K", via: "toc", count: 25, has: ["Competition could adversely impact our market share and financial results."] },
  { file: "amd-10k-2025.html.gz", form: "10-K", via: "toc", count: 43, last: "Our stock price is subject to volatility." },
  // A 10-Q that repeats every risk factor: three fifths of its text, and still read.
  { file: "amd-10q-2026q2.html.gz", form: "10-Q", via: "toc", count: 43, noMaterialChanges: false },
  { file: "msft-10k-2026.html.gz", form: "10-K", via: "toc", count: 25, first: "We face intense competition across all markets for our products and services, which could adversely affect our results of operations." },
  { file: "smci-10k-2026.html.gz", form: "10-K", via: "toc", count: 35 },
  { file: "smci-10k-2025.html.gz", form: "10-K", via: "toc", count: 39 },
  { file: "aapl-10k-2025.html.gz", form: "10-K", via: "toc", count: 27, last: "The price of the Company’s stock is subject to volatility." },
  // A bank, a pharma that bullets its headings, a foreign 20-F, a small cap.
  { file: "jpm-10k-2025.html.gz", form: "10-K", via: "toc", count: 45, last: "Various factors could impact JPMorganChase’s workforce." },
  { file: "jpm-10k-2024.html.gz", form: "10-K", via: "toc", count: 44 },
  {
    file: "lly-10k-2024.html.gz",
    form: "10-K",
    via: "toc",
    count: 16,
    first: "Pharmaceutical research and development is very costly and highly uncertain; we may not succeed in developing, licensing, or acquiring commercially successful products sufficient in number or value to replace revenues of products that have lost or will lose intellectual property protection or are displaced by competing products or therapies.",
    last: "Regulatory compliance problems could be damaging to the company.",
  },
  { file: "tsm-20f-2025.html.gz", form: "20-F", via: "heading", count: 25, has: ["Adverse fluctuations in exchange rates could decrease our operating margin and/or revenue."] },
  { file: "aehr-10k-2026.html.gz", form: "10-K", via: "toc", count: 29, has: ["Our stock price is volatile."] },
  { file: "pnc-10q-2026q2.html.gz", form: "10-Q", via: "toc", count: 0, noMaterialChanges: true },
];

describe("real filings", () => {
  for (const c of CASES) {
    it(`${c.file}: ${c.count} risk factor headings, found through the ${c.via === "toc" ? "table of contents" : "item heading"}`, () => {
      const html = load(c.file);
      const section = findSection(readDocument(html), "risk");
      assert.ok(section);
      assert.equal(section.via, c.via);
      const { digest } = digestOf(filingOf(c.form), html);
      assert.equal(digest.riskStatus, "found");
      const texts = digest.headings.map((h) => h.text);
      assert.equal(texts.length, c.count, texts.join("\n"));
      if (c.first) assert.equal(texts[0], c.first);
      if (c.last) assert.equal(texts.at(-1), c.last);
      for (const h of c.has ?? []) assert.ok(texts.includes(h), h);
      if (c.noMaterialChanges !== undefined) assert.equal(digest.noMaterialChanges, c.noMaterialChanges);
      // Nothing a table row or a footnote: every heading reads as a statement of words.
      for (const t of texts) assert.ok(!/\$\s?\(?\d.*\$\s?\(?\d/.test(t), t);
    });
  }

  it("the heading search alone runs Intel's 10-K and ASML's 20-F into the rest of the report; the guard keeps it out", () => {
    for (const [file, form] of [
      ["intc-10k-2025.html.gz", "10-K"],
      ["intc-10q-2026q2.html.gz", "10-Q"],
      ["asml-20f-2025.html.gz", "20-F"],
    ] as const) {
      const { blocks } = readDocument(load(file));
      const total = blocks.reduce((n, b) => n + b.text.length, 0);
      // Blocks alone carry no ids, so only the heading search runs: what the reader did before.
      const section = findSection(blocks, "risk");
      assert.ok(section, file);
      assert.equal(section.via, "heading");
      const verdict = riskReadability(section, riskHeadings(blocks, section), total, form !== "10-Q");
      assert.equal(verdict.readable, false, file);
    }
  });

  it("SMCI: customer shares from the prior year's tables, compared as the largest unnamed customer", () => {
    const now = digestOf(filingOf("10-K"), load("smci-10k-2026.html.gz")).digest.concentration;
    const before = digestOf(filingOf("10-K"), load("smci-10k-2025.html.gz")).digest.concentration;
    // FY2026 states its own year in sentences; the FY2025 and FY2024 shares it repeats are not this year's.
    assert.deepEqual(
      now.map((f) => [f.basis, f.label, f.pct]),
      [
        ["receivables", LARGEST_CUSTOMER, 23],
        ["revenue", "One customer", 28.1],
      ],
    );
    // FY2025 gives its shares in tables only: net sales and accounts receivable apart, the latest column read.
    assert.deepEqual(
      before.map((f) => [f.basis, f.label, f.pct, f.quote]),
      [
        ["receivables", "Customer A", 33.4, "Customer A 33.4% 15.4%"],
        ["receivables", "Customer B", 13.6, "Customer B 13.6% *"],
        ["revenue", "Customer A", 20.9, "Customer A 20.9% 20.0% *"],
        ["revenue", "Customer B", 11.5, "Customer B 11.5% * *"],
        ["revenue", "Customer C", 11.3, "Customer C 11.3% * *"],
        ["revenue", "Customer D", 11.1, "Customer D 11.1% * *"],
      ],
    );
    // Not "One customer 28.1%, not stated the year before": the largest against the largest.
    assert.deepEqual(
      diffConcentration(now, before).map((c) => [c.kind, c.label, c.basis, c.kind === "share" ? [c.pct, c.previousPct] : null]),
      [
        ["share", LARGEST_CUSTOMER, "revenue", [28.1, 20.9]],
        ["share", LARGEST_CUSTOMER, "receivables", [23, 33.4]],
      ],
    );
  });

  it("JPMorgan rewrote its risk factor headings: the same subjects in new words are reworded, not new", () => {
    const now = digestOf(filingOf("10-K"), load("jpm-10k-2025.html.gz")).digest.headings;
    const before = digestOf(filingOf("10-K"), load("jpm-10k-2024.html.gz")).digest.headings;
    const d = diffHeadings(now, before);
    assert.deepEqual([d.kept, d.reworded.length], [16, 26]);
    // What is left is what the 2025 report says for the first time, and what it no longer says.
    assert.deepEqual(
      d.added.map((h) => h.text.slice(0, 60)),
      ["JPMorganChase’s interconnectedness with clients, customers a", "JPMorganChase’s operations, results, and competitive standin", "Various factors could impact JPMorganChase’s workforce."],
    );
    assert.deepEqual(
      d.removed.map((h) => h.text.slice(0, 60)),
      ["JPMorganChase’s ability to attract and retain qualified empl", "Unfavorable changes in immigration or travel policies could "],
    );
    const pair = (start: string) => d.reworded.find((r) => r.now.text.startsWith(start))?.before.text.slice(0, 50);
    assert.equal(pair("JPMorganChase’s liquidity and cost of funding"), "Reductions in JPMorganChase’s credit ratings may a");
    assert.equal(pair("Competition in the financial services industry"), "JPMorganChase faces significant and increasing com");
    assert.equal(pair("Differences in the supervision and regulation"), "Differences and inconsistencies in financial servi");
  });
});
