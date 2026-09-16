import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapPool } from "./asyncPool.js";
import { applyCompetSanity, isAllCapsExhibitLine, isTocLikeSection } from "./sectionSanity.js";
import { assignEvidenceGroups, evidenceQuoteHash } from "./evidenceGroups.js";
import { chunkText, extractItem1ThroughItem2, extractItem3Through5For20F, findLatestAnnualInFilings, htmlToPlainText } from "./fetchFiling.js";
import { dedupeCandidates } from "./dedupe.js";
import { parseCandidateJsonl } from "./extractCandidates.js";
import { isGenericCounterparty } from "./genericGroup.js";
import { isNonNarrativeEvidence } from "./narrativeEvidence.js";
import { normalizeCompanyName, counterpartyNameInQuote } from "./normalize.js";
import { preAuditCandidates } from "./preAudit.js";
import { matchTicker } from "./tickerMatch.js";
import type { CandidateEdge, ValidatedEdge } from "./types.js";

describe("mapPool", () => {
  it("runs with concurrency and preserves order", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const order: number[] = [];
    const results = await mapPool(items, 3, async (n) => {
      order.push(n);
      await new Promise((r) => setTimeout(r, 5));
      return n * 2;
    });
    assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
    assert.equal(order.length, 7);
  });
});

describe("findLatestAnnualInFilings", () => {
  it("picks newest exact 10-K and ignores 10-K/A", () => {
    const hit = findLatestAnnualInFilings({
      form: ["8-K", "10-K/A", "10-K", "10-K"],
      filingDate: ["2026-07-01", "2026-03-01", "2025-02-19", "2026-02-18"],
      accessionNumber: ["a", "b", "c", "d"],
      primaryDocument: ["a.htm", "b.htm", "c.htm", "d.htm"],
    });
    assert.ok(hit);
    assert.equal(hit!.form, "10-K");
    assert.equal(hit!.filingDate, "2026-02-18");
    assert.equal(hit!.accessionNumber, "d");
  });

  it("returns null when no annual forms", () => {
    assert.equal(
      findLatestAnnualInFilings({
        form: ["8-K", "S-8 POS"],
        filingDate: ["2026-07-01", "2026-07-01"],
        accessionNumber: ["a", "b"],
        primaryDocument: ["a.htm", "b.htm"],
      }),
      null,
    );
  });
});

describe("normalizeCompanyName", () => {
  it("strips legal suffixes and punctuation", () => {
    assert.equal(normalizeCompanyName("Microsoft Corporation"), "microsoft");
    assert.equal(normalizeCompanyName("Alphabet Inc."), "alphabet");
    assert.equal(normalizeCompanyName("SAP SE"), "sap");
  });
});

describe("htmlToPlainText + Item 1 span", () => {
  it("strips ix:header before tag removal", () => {
    const html = `<ix:header>dei:EntityRegistrantName us-gaap:Assets</ix:header><body>Item 1. Business real text</body>`;
    const plain = htmlToPlainText(html);
    assert.ok(!plain.includes("dei:EntityRegistrantName"));
    assert.ok(plain.includes("Item 1"));
  });

  it("strips tags and finds Item 1–2 span", () => {
    const filler = "x".repeat(45_000) + " competition competes ";
    const html = `<html><script>bad()</script><style>.a{}</style><body>
      Item 1. Business ${filler}
      Item 2. Properties more
    </body></html>`;
    const plain = htmlToPlainText(html);
    assert.ok(!plain.includes("bad()"));
    const { text, sectionMethod } = extractItem1ThroughItem2(plain);
    assert.equal(sectionMethod, "item_span_last");
    assert.ok(text.toLowerCase().includes("item 1"));
    assert.ok(!text.toLowerCase().includes("item 2. properties"));
  });

  it("matches Item 1 with dash separator", () => {
    const filler = "x".repeat(45_000) + " competition competes ";
    const plain = `Item 1 - Business ${filler} Item 2 - Properties end`;
    const { sectionMethod } = extractItem1ThroughItem2(plain);
    assert.equal(sectionMethod, "item_span_last");
  });

  it("uses last Item 1 Business match (skips early TOC hit)", () => {
    const filler = "x".repeat(45_000) + " competition competes ";
    const plain = `Item 1. Business toc ${"y".repeat(500)} Item 1. Business ${filler} Item 2. Properties end`;
    const { sectionMethod, text } = extractItem1ThroughItem2(plain);
    assert.equal(sectionMethod, "item_span_last");
    assert.ok(text.includes(filler.slice(0, 100)));
    assert.ok(!text.includes("toc"));
  });

  it("ends at Item 3 Legal or Part II when Item 2 is too early", () => {
    const filler = "z".repeat(45_000) + " competition competes ";
    const plain = `Item 1. Business ${filler} Item 3. Legal Proceedings tail`;
    const { sectionMethod, text } = extractItem1ThroughItem2(plain);
    assert.equal(sectionMethod, "item_span_last");
    assert.ok(text.includes(filler.slice(0, 100)));
    assert.ok(!text.includes("Legal Proceedings tail"));
  });

  it("extends short 10-K past early Item 2 until section >= 60k", () => {
    // First end anchor (~42k) is short; later Item 3 pushes past 60k.
    // Trailing filler keeps Item 3 before the final-30% exclusion zone.
    const early = "e".repeat(42_000) + " competition competes ";
    const more = "m".repeat(25_000) + " supplier customer ";
    const tailPad = "t".repeat(200_000);
    const plain =
      `Item 1. Business ${early} Item 2. Properties mid ${more} Item 3. Legal Proceedings end ${tailPad}`;
    const { sectionMethod, text } = extractItem1ThroughItem2(plain);
    assert.equal(sectionMethod, "item_span_last");
    assert.ok(text.length >= 60_000, `expected >=60k, got ${text.length}`);
    assert.ok(text.includes(more.slice(0, 80)));
    assert.ok(!text.includes("Legal Proceedings end"));
  });

  it("uses anchor_windowed when no end anchor (150k cap)", () => {
    const prefix = "p".repeat(50_000);
    const filler = "q".repeat(200_000);
    const plain = `${prefix} Item 1. Business ${filler}`;
    const { sectionMethod, text } = extractItem1ThroughItem2(plain);
    assert.equal(sectionMethod, "anchor_windowed");
    assert.ok(text.length >= 150_000);
  });

  it("skips Item 1 — Business — cross-references", () => {
    const body = "z".repeat(45_000) + " competition competes ";
    const plain = `Item 1. Business toc Item 1 — Business ${body} Item 2. Properties end Item 1 — Business — See manufacturing note ${"t".repeat(40_000)}`;
    const { sectionMethod, text } = extractItem1ThroughItem2(plain);
    assert.equal(sectionMethod, "item_span_last");
    assert.ok(text.includes(body.slice(0, 100)));
    assert.ok(!text.includes("See manufacturing"));
  });

  it("rejects Item 1 Business in final 30% (exhibits tail)", () => {
    const body =
      "a".repeat(50_000) + " competition competes competitors " + "a".repeat(50_000);
    const tail = "b".repeat(20_000);
    const plain = `Item 1. Business ${body} Item 2. Properties mid ${"c".repeat(50_000)} Item 1. Business ${tail}`;
    const { sectionMethod, text } = extractItem1ThroughItem2(plain);
    assert.notEqual(sectionMethod, "fallback_60pct");
    assert.ok(text.includes(body.slice(0, 100)));
    assert.ok(!text.includes(tail.slice(0, 100)));
  });
});

describe("sectionSanity", () => {
  it("extends section when compet mentions are sparse", () => {
    const base = "x".repeat(50_000);
    const { text, contentSuspect } = applyCompetSanity(`${base} tail`, 0, 30_000);
    assert.ok(text.length > 30_000);
    assert.equal(contentSuspect, true);
  });

  it("accepts supplier/customer as content signals", () => {
    const body = "x".repeat(20_000) + " our supplier and key customer ";
    const { contentSuspect } = applyCompetSanity(body, 0, body.length);
    assert.equal(contentSuspect, false);
  });

  it("detects ALL-CAPS exhibit quotes", () => {
    assert.ok(isAllCapsExhibitLine("LAND LEASE AGREEMENT BETWEEN TSMC AND GOVERNMENT"));
    assert.ok(!isAllCapsExhibitLine("We compete with Intel and AMD in microprocessors."));
  });

  it("detects TOC-like 20-F section heads", () => {
    const toc =
      "ITEM 3. KEY INFORMATION 3 ITEM 4. INFORMATION ON THE COMPANY 14 ITEM 5. OPERATING AND FINANCIAL";
    assert.ok(isTocLikeSection(toc));
    assert.ok(!isTocLikeSection("Item 3. Key Information\nWe compete with Samsung and Intel."));
  });
});

describe("20-F Item 3–5 span", () => {
  it("finds Item 3 Key Information through Item 6 Directors", () => {
    const filler = "x".repeat(16_000) + " competition competes ";
    const plain = `Item 3. Key Information intro ${filler} Item 6. Directors and Senior Management`;
    const { text, sectionMethod } = extractItem3Through5For20F(plain);
    assert.equal(sectionMethod, "item_span_last");
    assert.ok(text.toLowerCase().includes("item 3"));
    assert.ok(!text.toLowerCase().includes("item 6. directors"));
  });
});

describe("chunkText", () => {
  it("chunks with overlap", () => {
    const text = "a".repeat(50_000);
    const chunks = chunkText(text, 24_000, 1_000);
    assert.ok(chunks.length >= 2);
    assert.equal(chunks[0]!.length, 24_000);
  });
});

describe("dedupeCandidates", () => {
  it("keeps highest confidence per name+category", () => {
    const candidates: CandidateEdge[] = [
      {
        counterparty_name: "Acme Inc",
        counterparty_type: "public_company",
        category: "customer",
        subtype: "oem",
        disclosed_revenue_dependency_pct: null,
        evidence_quote: "Acme is a customer",
        evidence_quotes: ["Acme is a customer"],
        confidence: 0.7,
        chunk_index: 0,
      },
      {
        counterparty_name: "Acme Corporation",
        counterparty_type: "public_company",
        category: "customer",
        subtype: "oem",
        disclosed_revenue_dependency_pct: 10,
        evidence_quote: "Acme Corporation accounts for 10%",
        evidence_quotes: ["Acme Corporation accounts for 10%"],
        confidence: 0.9,
        chunk_index: 1,
      },
    ];
    const { kept, rejected, merged } = dedupeCandidates(candidates);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.confidence, 0.9);
    assert.equal(merged.length, 1);
    assert.equal(rejected.length, 0);
  });

  it("merges evidence quotes from duplicates (max 3, skip identical)", () => {
    const candidates: CandidateEdge[] = [
      {
        counterparty_name: "Acme Inc",
        counterparty_type: "public_company",
        category: "customer",
        subtype: "oem",
        disclosed_revenue_dependency_pct: null,
        evidence_quote: "Acme is a customer",
        evidence_quotes: ["Acme is a customer"],
        confidence: 0.7,
        chunk_index: 0,
      },
      {
        counterparty_name: "Acme Corporation",
        counterparty_type: "public_company",
        category: "customer",
        subtype: "oem",
        disclosed_revenue_dependency_pct: 10,
        evidence_quote: "Acme Corporation accounts for 10%",
        evidence_quotes: ["Acme Corporation accounts for 10%"],
        confidence: 0.9,
        chunk_index: 1,
      },
      {
        counterparty_name: "Acme Corp",
        counterparty_type: "public_company",
        category: "customer",
        subtype: "oem",
        disclosed_revenue_dependency_pct: null,
        evidence_quote: "Acme is a customer",
        evidence_quotes: ["Acme is a customer"],
        confidence: 0.8,
        chunk_index: 2,
      },
    ];
    const { kept } = dedupeCandidates(candidates);
    assert.equal(kept[0]!.evidence_quotes.length, 2);
  });
});

describe("parseCandidateJsonl", () => {
  it("parses JSONL line by line and skips bad lines", () => {
    const raw = [
      '{"counterparty_name":"Apple","counterparty_type":"public_company","category":"competitor","subtype":"","disclosed_revenue_dependency_pct":null,"evidence_quote":"We compete with Apple","confidence":0.9}',
      "not json",
      '{"counterparty_name":"Google","counterparty_type":"public_company","category":"competitor","subtype":"","disclosed_revenue_dependency_pct":null,"evidence_quote":"We compete with Google","confidence":0.85}',
    ].join("\n");
    const { candidates, unparseableLines } = parseCandidateJsonl(raw, 0);
    assert.equal(candidates.length, 2);
    assert.equal(unparseableLines, 1);
  });

  it("ignores empty lines and fence-only lines", () => {
    const raw = [
      "",
      "```json",
      "```",
      '{"counterparty_name":"Apple","counterparty_type":"public_company","category":"competitor","subtype":"","disclosed_revenue_dependency_pct":null,"evidence_quote":"We compete with Apple and others","confidence":0.9}',
    ].join("\n");
    const { candidates, unparseableLines } = parseCandidateJsonl(raw, 0);
    assert.equal(candidates.length, 1);
    assert.equal(unparseableLines, 0);
  });
});

describe("isNonNarrativeEvidence", () => {
  it("rejects short quotes and XBRL qnames", () => {
    assert.equal(isNonNarrativeEvidence("too short"), true);
    assert.equal(isNonNarrativeEvidence("dei:EntityRegistrantName foo bar baz"), true);
    assert.equal(
      isNonNarrativeEvidence(
        "We compete with Apple and Google in mobile markets worldwide today.",
      ),
      false,
    );
  });
});

describe("isGenericCounterparty", () => {
  it("rejects generic group names", () => {
    assert.equal(isGenericCounterparty("various suppliers"), true);
    assert.equal(isGenericCounterparty("OEMs"), true);
    assert.equal(isGenericCounterparty("competitors"), true);
    assert.equal(isGenericCounterparty("Apple Inc."), false);
  });
});

describe("preAuditCandidates", () => {
  it("rejects fabricated evidence before dedupe can promote it", () => {
    const chunk = "We compete with Apple and Google in mobile markets worldwide today.";
    const chunks = [chunk];
    const candidates: CandidateEdge[] = [
      {
        counterparty_name: "Apple",
        counterparty_type: "public_company",
        category: "competitor",
        subtype: "",
        disclosed_revenue_dependency_pct: null,
        evidence_quote: "We compete with Apple and Google in mobile markets worldwide today.",
        evidence_quotes: [
          "We compete with Apple and Google in mobile markets worldwide today.",
        ],
        confidence: 0.95,
        chunk_index: 0,
      },
      {
        counterparty_name: "Samsung",
        counterparty_type: "public_company",
        category: "competitor",
        subtype: "",
        disclosed_revenue_dependency_pct: null,
        evidence_quote: "totally fabricated quote about Samsung partnership",
        evidence_quotes: ["totally fabricated quote about Samsung partnership"],
        confidence: 0.99,
        chunk_index: 0,
      },
    ];
    const { survivors, rejected } = preAuditCandidates(candidates, chunks);
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0]!.counterparty_name, "Apple");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.reason, "quote not found in source (hallucinated evidence)");
  });
});

describe("matchTicker", () => {
  const secEntries = [
    { ticker: "HONA", title: "Honeywell Arena Inc" },
    { ticker: "MSFT", title: "MICROSOFT CORP" },
  ];

  it("resolves alias before SEC list (Honeywell -> HON, not HONA)", () => {
    assert.deepEqual(matchTicker("Honeywell", secEntries), { ticker: "HON", method: "alias" });
    assert.deepEqual(matchTicker("Honeywell Aerospace Defense", secEntries), {
      ticker: "HON",
      method: "alias",
    });
  });

  it("exact SEC title match only — no prefix fallback", () => {
    assert.deepEqual(matchTicker("Honeywell Arena Inc", secEntries), {
      ticker: "HONA",
      method: "exact",
    });
    assert.deepEqual(matchTicker("Microsoft Corporation", secEntries), {
      ticker: "MSFT",
      method: "exact",
    });
  });

  it("returns null for foreign-listed or private names", () => {
    assert.deepEqual(matchTicker("Samsung Electronics", secEntries), {
      ticker: null,
      method: null,
    });
    assert.deepEqual(matchTicker("Continental AG", secEntries), { ticker: null, method: null });
  });
});

describe("assignEvidenceGroups", () => {
  const base = (quote: string, name: string): ValidatedEdge => ({
    root_ticker: "MSFT",
    counterparty_name: name,
    counterparty_ticker: null,
    counterparty_type: "public_company",
    category: "supplier",
    subtype: "",
    strength: 0.6,
    strength_tier: "important",
    strength_basis: "classified",
    epistemic_label: "VERIFIED",
    confidence: 0.9,
    evidence: [{ quote, source_url: "https://sec.gov", located_at: "10-K Item 1/1A" }],
    valid_from: "2026-01-01",
    shared_evidence_group: "",
  });

  it("assigns same group id for identical evidence quotes", () => {
    const grouped = assignEvidenceGroups([
      base("We rely on Acme for components.", "Acme"),
      base("We rely on Acme for components.", "Beta"),
      base("Separate disclosure text.", "Gamma"),
    ]);
    assert.equal(grouped[0]!.shared_evidence_group, grouped[1]!.shared_evidence_group);
    assert.notEqual(grouped[0]!.shared_evidence_group, grouped[2]!.shared_evidence_group);
  });

  it("treats whitespace-normalized quotes as identical", () => {
    const hashA = evidenceQuoteHash("foo  bar");
    const hashB = evidenceQuoteHash("foo bar");
    assert.equal(hashA, hashB);
  });
});

describe("counterpartyNameInQuote", () => {
  it("accepts when normalized name appears in quote", () => {
    assert.equal(
      counterpartyNameInQuote("Apple Inc.", "We compete with Apple and Google in mobile."),
      true,
    );
    assert.equal(
      counterpartyNameInQuote(
        "Honeywell Aerospace & Defense",
        "suppliers include Honeywell Aerospace & Defense and Safran",
      ),
      true,
    );
  });

  it("accepts first token (>=4 chars) when full name is abbreviated in quote", () => {
    assert.equal(
      counterpartyNameInQuote(
        "Honeywell Aerospace Defense",
        "suppliers include Honeywell and Safran",
      ),
      true,
    );
  });

  it("rejects when name is absent from quote", () => {
    assert.equal(
      counterpartyNameInQuote("Samsung", "We compete with Apple and Google in mobile."),
      false,
    );
  });
});
