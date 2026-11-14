/**
 * Graph v1 extraction (src/graph/*): the passage locator, the checks every
 * proposed link must pass, name resolution, the universe ranking and the
 * pilot measurements.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { parseListings } from "../src/feed/companies.ts";
import { loadGraph, walk, type GraphEdge } from "../src/graph.ts";
import { ENGINE_ROOT } from "../src/http.ts";
import { liquidityOf } from "../src/quality.ts";
import type { Filing } from "../src/sec.ts";
import {
  applyVerdict,
  checkLink,
  dedupeEdges,
  edgeIdOf,
  latestAnnual,
  namedIn,
  parseLinks,
  parseSharePct,
  parseVerdicts,
  sameCompany,
  shareBasisOf,
  type ExtractedEdge,
  type RawLink,
} from "../src/graph/extract.ts";
import { chunkPassages, itemOf, locateLinkPassages, reflow } from "../src/graph/locate.ts";
import { graphStats, precisionFrom, recallAgainst, sampleEdges, samePair } from "../src/graph/metrics.ts";
import { displayName, namesAgree, resolveCounterparty } from "../src/graph/resolve.ts";
import { floatFrames, latestFloats, rankUniverse, type Candidate } from "../src/graph/universe.ts";

describe("itemOf", () => {
  it("reads the usual heading shapes", () => {
    assert.equal(itemOf("Item 1A. Risk Factors"), "1A");
    assert.equal(itemOf("ITEM 7. MANAGEMENT'S DISCUSSION"), "7");
    assert.equal(itemOf("Item 1-Business"), "1");
    assert.equal(itemOf("Item 1(a). Risk Factors ."), "1A");
    assert.equal(itemOf("Item 1A. |"), "1A");
    assert.equal(itemOf("PART I, Item 2. Properties"), "2");
  });
  it("ignores prose and long lines", () => {
    assert.equal(itemOf("Items we sell include tools."), null);
    assert.equal(itemOf(`Item 1. ${"x".repeat(300)}`), null);
    assert.equal(itemOf("Item Number | Item |"), null);
  });
});

describe("reflow", () => {
  it("joins lines that break a sentence, keeps table rows and headings", () => {
    const out = reflow([
      "Our business depends on the supply and availability of raw materials, which are",
      "normally readily available.",
      "Item 1A. Risk Factors",
      "Customer | Share |",
      "Short",
    ]);
    assert.deepEqual(out, [
      "Our business depends on the supply and availability of raw materials, which are normally readily available.",
      "Item 1A. Risk Factors",
      "Customer | Share |",
      "Short",
    ]);
  });
});

const TEN_K = [
  "Table of Contents",
  "Item 1. Business",
  "Customers",
  "Sales to Walmart Inc. accounted for 24% of our net sales in fiscal 2026, and no other customer accounted for 10% or more.",
  "We compete with Procter & Gamble and Unilever in most of our categories, and with private label brands.",
  "We use the money we earn to pay for things, which is a sentence about nothing in particular at all.",
  "Item 1A. Risk Factors",
  "We rely on a limited number of suppliers, and resin is purchased from a sole source, Dow Inc., for certain products.",
  "Item 10. Directors, Executive Officers and Corporate Governance",
  "Mr. Smith served as Chief Executive Officer of Kraft Heinz Company and our customers include many retailers.",
].join("\n");

describe("locateLinkPassages", () => {
  it("keeps link passages of the business items, skips director biographies, labels sections", () => {
    const { passages, stats } = locateLinkPassages(TEN_K, "10-K");
    const texts = passages.map((p) => p.text);
    assert.ok(texts.some((t) => t.startsWith("Sales to Walmart")));
    assert.ok(texts.some((t) => t.startsWith("We compete with Procter")));
    assert.ok(texts.some((t) => t.includes("sole source, Dow")));
    assert.ok(!texts.some((t) => t.includes("Kraft Heinz")), "Item 10 is skipped");
    assert.ok(!texts.some((t) => t.includes("about nothing")), "no relation word, no passage");
    const walmart = passages.find((p) => p.text.startsWith("Sales to Walmart"))!;
    assert.equal(walmart.section, "Item 1");
    assert.equal(walmart.heading, "Customers");
    assert.equal(walmart.priority, 3);
    assert.equal(stats.kept, passages.length);
  });
  it("keeps the strongest passages first when the cap binds, in document order", () => {
    const { passages } = locateLinkPassages(TEN_K, "10-K", 130);
    assert.equal(passages.length, 1);
    assert.ok(passages[0]!.text.startsWith("Sales to Walmart"));
  });
  it("labels each passage in chunks and splits by size", () => {
    const { passages } = locateLinkPassages(TEN_K, "10-K");
    const one = chunkPassages(passages);
    assert.equal(one.length, 1);
    assert.ok(one[0]!.startsWith("[Item 1 > Customers] Sales to Walmart"));
    assert.equal(chunkPassages(passages, 150).length, passages.length);
  });
});

function filing(form: string, filedAt: string): Filing {
  return { cik: "1", companyName: "X", form, accession: `a-${form}-${filedAt}`, filedAt, acceptedAt: null, items: [], primaryDocument: "x.htm", primaryDocDescription: "", url: "u", indexUrl: "i" };
}

describe("latestAnnual", () => {
  it("takes the newest original annual report, an amendment only without one", () => {
    assert.equal(latestAnnual([filing("8-K", "2026-03-01"), filing("10-K/A", "2026-02-20"), filing("10-K", "2026-02-10")])?.form, "10-K");
    assert.equal(latestAnnual([filing("6-K", "2026-04-01"), filing("20-F", "2026-03-01")])?.form, "20-F");
    assert.equal(latestAnnual([filing("10-K/A", "2026-02-20")])?.form, "10-K/A");
    assert.equal(latestAnnual([filing("10-Q", "2026-05-01")]), null);
  });
});

describe("share parsing", () => {
  it("reads one share in (0, 100]", () => {
    assert.equal(parseSharePct("14%"), 14);
    assert.equal(parseSharePct("approximately 10.6 percent"), 10.6);
    assert.equal(parseSharePct("none"), null);
    assert.equal(parseSharePct("140%"), null);
  });
  it("names the basis", () => {
    assert.equal(shareBasisOf("represented 17% of our net sales"), "revenue");
    assert.equal(shareBasisOf("17.1 % of the total gross accounts receivable"), "receivables");
    assert.equal(shareBasisOf("about 55% of total merchandise purchased"), "purchases");
    assert.equal(shareBasisOf("a joint venture we own 50 %"), null);
  });
});

describe("namedIn", () => {
  it("accepts the full name, a distinctive word or initials", () => {
    assert.ok(namedIn("Sales to Walmart Inc. were 24%.", "Walmart Inc.", "Walmart Inc."));
    assert.ok(namedIn("Our principal competitor is Nvidia, the market leader.", "Nvidia Corporation", "Nvidia Corporation"));
    assert.ok(namedIn("As GM, Ford and Stellantis are among our largest customers", "General Motors", "General Motors Company"));
  });
  it("rejects a quote that does not name the company", () => {
    assert.ok(!namedIn("Our largest customer accounted for 24% of sales.", "Walmart", "Walmart Inc."));
    assert.ok(!namedIn("We sell to general merchandise retailers.", "General Mills", "General Mills, Inc."));
  });
});

function raw(over: Partial<RawLink>): RawLink {
  return {
    counterparty: "Walmart Inc.",
    name_in_quote: "Walmart Inc.",
    relation: "customer",
    kind: "company",
    quote: "Sales to Walmart Inc. accounted for 24% of our net sales in fiscal 2026",
    section: "Item 1",
    share_text: "24%",
    sole_source: false,
    strength: "disclosed",
    us_ticker: "WMT",
    ...over,
  };
}

describe("checkLink", () => {
  it("keeps a quoted 10% customer with its share as critical", () => {
    const c = checkLink(raw({}), TEN_K, "The Clorox Company");
    assert.ok(c.ok);
    if (c.ok) {
      assert.equal(c.value.sharePct, 24);
      assert.equal(c.value.shareBasis, "revenue");
      assert.equal(c.value.tier, "critical");
    }
  });
  it("drops a quote that is not in the filing, or does not name the company", () => {
    const r1 = checkLink(raw({ quote: "Walmart Inc. is our largest customer by far and has been for years." }), TEN_K, "Clorox");
    assert.deepEqual(r1, { ok: false, reason: "quote not in filing" });
    const r2 = checkLink(raw({ counterparty: "Target Corporation", name_in_quote: "Target" }), TEN_K, "Clorox");
    assert.deepEqual(r2, { ok: false, reason: "counterparty not named in quote" });
  });
  it("strips a copied label or heading in front of the quote", () => {
    const c1 = checkLink(raw({ quote: "[Item 1 > Customers] Sales to Walmart Inc. accounted for 24% of our net sales" }), TEN_K, "Clorox");
    assert.ok(c1.ok);
    const c2 = checkLink(raw({ quote: "Customers: Sales to Walmart Inc. accounted for 24% of our net sales" }), TEN_K, "Clorox");
    assert.ok(c2.ok);
    if (c2.ok) assert.equal(c2.value.quote, "Sales to Walmart Inc. accounted for 24% of our net sales");
  });
  it("keeps no share the quote does not hold, and none for a competitor", () => {
    const c1 = checkLink(raw({ share_text: "31%" }), TEN_K, "Clorox");
    assert.ok(c1.ok && c1.value.sharePct === null);
    const c2 = checkLink(
      raw({ counterparty: "Unilever", name_in_quote: "Unilever", relation: "competitor", quote: "We compete with Procter & Gamble and Unilever in most of our categories", share_text: "", strength: "list" }),
      TEN_K,
      "Clorox",
    );
    assert.ok(c2.ok && c2.value.tier === "marginal" && c2.value.sharePct === null);
  });
  it("needs sole-source wording for a sole source", () => {
    const quote = "resin is purchased from a sole source, Dow Inc., for certain products";
    const c = checkLink(raw({ counterparty: "Dow Inc.", name_in_quote: "Dow Inc.", relation: "supplier", quote, share_text: "", sole_source: true }), TEN_K, "Clorox");
    assert.ok(c.ok && c.value.soleSource && c.value.tier === "critical");
    const c2 = checkLink(raw({ relation: "customer", sole_source: true, share_text: "" }), TEN_K, "Clorox");
    assert.ok(c2.ok && !c2.value.soleSource && c2.value.tier === "important");
  });
  it("drops governments, the filer itself and biographies", () => {
    assert.equal((checkLink(raw({ kind: "government" }), TEN_K, "Clorox") as { reason: string }).reason, "not a company (government)");
    assert.equal((checkLink(raw({}), TEN_K, "Walmart Inc") as { reason: string }).reason, "the filer itself");
    const bio = checkLink(
      raw({ counterparty: "Kraft Heinz Company", name_in_quote: "Kraft Heinz Company", relation: "partner", quote: "Mr. Smith served as Chief Executive Officer of Kraft Heinz Company", share_text: "" }),
      TEN_K,
      "Clorox",
    );
    assert.equal((bio as { reason: string }).reason, "biography");
  });
  it("sameCompany folds legal suffixes", () => {
    assert.ok(sameCompany("Walmart Inc.", "WALMART INC"));
    assert.ok(!sameCompany("Walmart Inc.", "Target Corp"));
  });
});

describe("model answers", () => {
  it("parseLinks drops malformed rows and fills defaults", () => {
    const links = parseLinks({ links: [{ counterparty: "A", quote: "q", relation: "customer", us_ticker: " a " }, { counterparty: "B", quote: "q", relation: "friend" }, "x"] });
    assert.equal(links.length, 1);
    assert.equal(links[0]!.us_ticker, "A");
    assert.equal(links[0]!.kind, "other");
    assert.deepEqual(parseLinks(null), []);
  });
  it("parseVerdicts keys by claim number", () => {
    const v = parseVerdicts({ verdicts: [{ n: 1, supported: true, relation: "supplier" }, { n: 2, supported: false, relation: "none" }, { n: 3, supported: true, relation: "boss" }] });
    assert.equal(v.size, 2);
    assert.equal(v.get(1)!.relation, "supplier");
  });
});

function edge(over: Partial<ExtractedEdge>): ExtractedEdge {
  const e: ExtractedEdge = {
    id: "",
    from: "CLX",
    to: "WMT",
    toName: "Walmart Inc.",
    category: "customer",
    tier: "critical",
    disclosedSharePct: 24,
    quote: "q",
    form: "10-K",
    filedAt: "2026-08-07",
    url: "u",
    origin: "o",
    accession: "a",
    section: "Item 1",
    shareBasis: "revenue",
    soleSource: false,
    resolvedBy: "alias",
    extractor: "m",
    ...over,
  };
  e.id = edgeIdOf(e);
  return e;
}

describe("applyVerdict and dedupeEdges", () => {
  it("drops an unsupported edge, keeps an agreeing one, re-reads a changed relation without its share", () => {
    const e = edge({});
    assert.equal(applyVerdict(e, { n: 1, supported: false, relation: "none" }), null);
    assert.equal(applyVerdict(e, undefined), e);
    assert.equal(applyVerdict(e, { n: 1, supported: true, relation: "customer" })!.verified, true);
    const moved = applyVerdict(e, { n: 1, supported: true, relation: "partner" })!;
    assert.equal(moved.category, "partner");
    assert.equal(moved.extractedAs, "customer");
    assert.equal(moved.disclosedSharePct, null);
    assert.equal(moved.tier, "important");
    assert.equal(moved.id, "CLX:partner:WMT");
  });
  it("keeps one edge per pair and category, the strongest", () => {
    const out = dedupeEdges([edge({ tier: "marginal", disclosedSharePct: null }), edge({}), edge({ to: null, toName: "Acme Ltd", category: "supplier" })]);
    assert.equal(out.length, 2);
    assert.equal(out.find((e) => e.to === "WMT")!.tier, "critical");
    assert.equal(out.find((e) => e.to === null)!.id, "CLX:supplier:acme-ltd");
  });
});

const LISTINGS = parseListings({
  fields: ["cik", "name", "ticker", "exchange"],
  data: [
    [104169, "Walmart Inc.", "WMT", "NYSE"],
    [37996, "FORD MOTOR CO", "F", "NYSE"],
    [6201, "American Airlines Group Inc.", "AAL", "Nasdaq"],
    [4962, "AMERICAN EXPRESS CO", "AXP", "NYSE"],
    [999, "Some OTC Holdings", "SOTC", "OTC"],
    [1000, "Merlin, Inc.", "MRLN", "Nasdaq"],
  ],
});

describe("resolveCounterparty", () => {
  it("uses aliases, then SEC titles, then a checked model ticker", () => {
    assert.deepEqual(resolveCounterparty("Google Cloud", "", LISTINGS), { ticker: "GOOGL", by: "alias" });
    assert.deepEqual(resolveCounterparty("Walmart Inc.", "", LISTINGS), { ticker: "WMT", by: "alias" });
    assert.deepEqual(resolveCounterparty("American Airlines Group", "", LISTINGS), { ticker: "AAL", by: "name" });
    assert.deepEqual(resolveCounterparty("Ford", "F", LISTINGS), { ticker: "F", by: "alias" });
    assert.deepEqual(resolveCounterparty("Ford Otosan", "F", LISTINGS), { ticker: null, by: "unresolved" });
  });
  it("rejects a model ticker whose title disagrees, an OTC listing, or a name kept unresolved", () => {
    assert.deepEqual(resolveCounterparty("American Eagle Outfitters", "AAL", LISTINGS), { ticker: null, by: "unresolved" });
    assert.deepEqual(resolveCounterparty("Some OTC", "SOTC", LISTINGS), { ticker: null, by: "unresolved" });
    assert.deepEqual(resolveCounterparty("Samsung Electronics Co., Ltd.", "SSNLF", LISTINGS), { ticker: null, by: "unresolved" });
    // A one-word listing title must be the whole name: Merlin Entertainments is not Merlin, Inc.
    assert.deepEqual(resolveCounterparty("Merlin Entertainment", "", LISTINGS), { ticker: null, by: "unresolved" });
    assert.deepEqual(resolveCounterparty("Merlin", "", LISTINGS), { ticker: "MRLN", by: "name" });
    // ... unless the model named the same ticker.
    assert.deepEqual(resolveCounterparty("Merlin Labs", "MRLN", LISTINGS), { ticker: "MRLN", by: "name" });
  });
  it("namesAgree compares the shorter name's words", () => {
    assert.ok(namesAgree("Ford", "FORD MOTOR CO"));
    assert.ok(!namesAgree("American Express", "American Airlines Group Inc."));
  });
  it("displayName tidies SEC titles", () => {
    assert.equal(displayName("FORD MOTOR CO"), "Ford Motor");
    assert.equal(displayName("Walmart Inc."), "Walmart");
    assert.equal(displayName("ACME CORP /DE/"), "Acme");
  });
});

describe("universe", () => {
  it("floatFrames covers the last seven quarters, oldest first", () => {
    assert.deepEqual(floatFrames("2026-11-14"), ["CY2025Q2I", "CY2025Q3I", "CY2025Q4I", "CY2026Q1I", "CY2026Q2I", "CY2026Q3I", "CY2026Q4I"]);
  });
  it("latestFloats keeps each filer's latest float", () => {
    const f = latestFloats([
      [{ accn: "a1", cik: 1, entityName: "A", end: "2025-06-30", val: 100 }],
      [
        { accn: "a2", cik: 1, entityName: "A", end: "2026-06-30", val: 200 },
        { accn: "b1", cik: 2, entityName: "B", end: "2026-03-31", val: 50 },
      ],
    ]);
    assert.equal(f.get("0000000001")!.floatUsd, 200);
    assert.equal(f.size, 2);
  });
  it("rankUniverse keeps liquid filers with an annual report, by dollar volume", () => {
    const c = (ticker: string, price: number, dv: number | null, annualForm?: string | null): Candidate => ({
      ticker,
      cik: ticker,
      name: ticker,
      exchange: "NYSE",
      floatUsd: null,
      liquidity: { price, medianDollarVolume20d: dv },
      annualForm,
    });
    const out = rankUniverse([c("A", 50, 9e6, "10-K"), c("B", 50, 90e6, "20-F"), c("C", 4, 90e6, "10-K"), c("D", 50, 1e6, "10-K"), c("E", 50, null, "10-K"), c("F", 50, 80e6, null)], 10);
    assert.deepEqual(out.map((m) => m.ticker), ["B", "A"]);
  });
  it("liquidityOf reads the last close and the 20-day median dollar volume", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ close: 10 + i, rawClose: 20 + i, dollarVolume: (i + 1) * 1e6 }));
    assert.deepEqual(liquidityOf(rows), { price: 44, medianDollarVolume20d: 15.5e6 });
    assert.deepEqual(liquidityOf(rows.slice(0, 5)), { price: 24, medianDollarVolume20d: null });
    assert.equal(liquidityOf([]), null);
  });
});

function g(from: string, to: string | null, toName: string, category: GraphEdge["category"], tier: GraphEdge["tier"] = "important"): GraphEdge {
  return { id: `${from}:${category}:${to ?? toName}`, from, to, toName, category, tier, disclosedSharePct: null, quote: "q", form: "10-K", filedAt: "2026-01-01", url: "u", origin: "o" };
}

describe("metrics", () => {
  const ref = [g("NVDA", "TSM", "TSMC", "supplier"), g("NVDA", null, "SK Hynix Inc.", "supplier", "marginal"), g("NVDA", "AMD", "AMD", "competitor"), g("AMD", "TSM", "TSMC", "supplier")];
  const found = [g("NVDA", "TSM", "Taiwan Semiconductor", "supplier"), g("NVDA", null, "SK Hynix", "supplier"), g("NVDA", "AMD", "AMD", "partner")];
  it("recallAgainst counts pairs and exact categories for the filers asked", () => {
    const r = recallAgainst(ref, found, new Set(["NVDA"]));
    assert.equal(r.reference, 3);
    assert.equal(r.pairs, 3);
    assert.equal(r.exact, 2);
    assert.equal(recallAgainst(ref, found, new Set(["NVDA", "AMD"])).missed.length, 1);
    assert.ok(samePair(ref[1]!, found[1]!));
  });
  it("graphStats counts filers with no edge", () => {
    const s = graphStats(found, ["NVDA", "AMD"]);
    assert.equal(s.perFiler.zero, 1);
    assert.equal(s.perFiler.mean, 1.5);
    assert.equal(s.listedShare, 2 / 3);
  });
  it("sampleEdges is the same every run and a different seed differs", () => {
    const xs = Array.from({ length: 50 }, (_, i) => i);
    assert.deepEqual(sampleEdges(xs, 10), sampleEdges(xs, 10));
    assert.notDeepEqual(sampleEdges(xs, 10), sampleEdges(xs, 10, 7));
    assert.equal(new Set(sampleEdges(xs, 50)).size, 50);
  });
  it("precisionFrom scores stage A and the final graph, with second readings", () => {
    const stageA = new Map([["a", "supplier"], ["b", "partner"], ["c", "partner"], ["d", "customer"]] as const);
    const final = new Map<string, "supplier" | "partner" | "customer" | "competitor" | null>([["a", "supplier"], ["b", null], ["c", "supplier"], ["d", null]]);
    const p = precisionFrom(
      [
        { id: "a", truth: "supplier" },
        { id: "b", truth: "none" },
        { id: "c", truth: "supplier", alt: "partner" },
        { id: "d", truth: "customer" },
      ],
      new Map(stageA),
      final,
    );
    assert.equal(p.stageA.correct, 3);
    assert.equal(p.final.kept, 2);
    assert.equal(p.final.correct, 2);
    assert.equal(p.droppedCorrect, 1);
    assert.equal(p.caught, 1);
  });
});

describe("the pilot graph", () => {
  it("loads in the seed graph's shape and walks", () => {
    const pilot = loadGraph(path.join(ENGINE_ROOT, "data", "graph-pilot.json"));
    assert.ok(pilot.edges.length > 100);
    for (const e of pilot.edges) {
      assert.ok(e.quote.length >= 20 && e.url.startsWith("https://www.sec.gov/Archives/"), e.id);
      assert.ok(["supplier", "customer", "competitor", "partner"].includes(e.category), e.id);
    }
    // Cirrus Logic's 10-K names Apple as its main customer.
    assert.ok(walk(pilot, "AAPL", 1).some((p) => p.ticker === "CRUS" && p.relation === "supplier"));
  });
});
