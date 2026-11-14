import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { htmlToText } from "../src/text.ts";
import { dailyIndexUrl, itemCodeOf, nyWallToIso, parseAtom, parseDailyIndex, parseEfts, parseSecHeader, parseSubmissionDocuments } from "../src/feed/edgar.ts";
import { parseOwnershipDocument, ownerRole } from "../src/feed/form4.ts";
import { latestAnnual, matchListed, normalizeCompanyName, parseListings } from "../src/feed/companies.ts";
import { findClusters, findSingles, insiderGroups, isRoutine, purchasesOf, toEvent, type Purchase } from "../src/detectors/insider.ts";
import { leadQuote, ntEvent, parseNtNotice, reasonQuote, restatementEvent, tickedYesNo } from "../src/detectors/distress.ts";
import { antiPump, checkFindings, contractEvent, graphCustomers, guidanceEvents, itemSection, parseUsd, routesToContract, statedPct } from "../src/detectors/eightk.ts";
import { businessDayIndex, displayName, personName, usd } from "../src/detectors/util.ts";
import { checkedQuote, numbersNotIn } from "../src/detectors/llm.ts";
import { detectAll } from "../src/detectors/index.ts";
import { parse13D } from "../src/detectors/activist.ts";
import type { Detector, DetectorEvent } from "../src/detectors/types.ts";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "detectors");
const read = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8");

describe("EDGAR feed", () => {
  it("reads the daily form index, columns from the right", () => {
    const rows = parseDailyIndex(read("form.20261113.excerpt.idx"));
    assert.ok(rows.length >= 10);
    const r = rows.find((x) => x.companyName === "101 HUNTINGTON HOLDINGS LLC")!;
    assert.equal(r.form, "4");
    assert.equal(r.cik, "0001208476");
    assert.equal(r.dateFiled, "2026-11-13");
    assert.equal(r.accession, "0001193125-26-461179");
    assert.ok(rows.some((x) => x.form === "NT 10-Q" && x.companyName === "Charlie's Holdings, Inc."));
    assert.equal(dailyIndexUrl("2026-11-13"), "https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/form.20261113.idx");
  });

  it("reads Atom entries with items and acceptance instants", () => {
    const xml = `<feed><entry>
<title>8-K - MACROGENICS INC (0001125345) (Filer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1125345/000112534526000077/0001125345-26-000077-index.htm"/>
<summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-11-13 &lt;b&gt;AccNo:&lt;/b&gt; 0001125345-26-000077 &lt;b&gt;Size:&lt;/b&gt; 6 MB
&lt;br&gt;Item 7.01: Regulation FD Disclosure
&lt;br&gt;Item 9.01: Financial Statements and Exhibits
</summary>
<updated>2026-11-13T17:28:39-05:00</updated>
<id>urn:tag:sec.gov,2008:accession-number=0001125345-26-000077</id>
</entry></feed>`;
    const [e] = parseAtom(xml);
    assert.equal(e!.form, "8-K");
    assert.equal(e!.cik, "0001125345");
    assert.equal(e!.role, "Filer");
    assert.deepEqual(e!.items, ["7.01", "9.01"]);
    assert.equal(e!.acceptedAt, "2026-11-13T22:28:39.000Z");
    assert.equal(e!.dateFiled, "2026-11-13");
  });

  it("turns SEC header wall time (New York) into UTC across the clock change", () => {
    assert.equal(nyWallToIso("20261113182120"), "2026-11-13T23:21:20.000Z"); // EST
    assert.equal(nyWallToIso("20260715093000"), "2026-07-15T13:30:00.000Z"); // EDT
  });

  it("reads acceptance, items and filer from an index-headers page", () => {
    const h = parseSecHeader(read("8k-index-headers-0002105965-26-000046.html"));
    assert.equal(h.accession, "0002105965-26-000046");
    assert.equal(h.form, "8-K");
    assert.equal(h.acceptedAt, "2026-11-13T21:13:06.000Z");
    assert.deepEqual(h.items, ["8.01", "9.01"]);
    assert.equal(h.filerCik, "0002105965");
    assert.equal(h.sic, "6022");
    assert.equal(itemCodeOf("Entry into a Material Definitive Agreement"), "1.01");
    assert.equal(itemCodeOf("Non-Reliance on Previously Issued Financial Statements or a Related Audit Report or Completed Interim Review"), "4.02");
  });

  it("reads efts hits, one per accession", () => {
    const hit = (adsh: string, items: string[]) => ({ _source: { adsh, form: "8-K", ciks: ["0000824142"], items, file_date: "2026-11-13", sics: ["3585"], display_names: ["AAON"] } });
    const r = parseEfts({ hits: { total: { value: 3 }, hits: [hit("a-1", ["1.01", "9.01"]), hit("a-1", ["1.01", "9.01"]), hit("a-2", ["7.01"])] } });
    assert.equal(r.total, 3);
    assert.equal(r.filings.length, 2);
    assert.deepEqual(r.filings[0]!.items, ["1.01", "9.01"]);
  });

  it("splits a submission text into documents", () => {
    const docs = parseSubmissionDocuments(read("nt10q-0001193125-26-460615.txt"));
    assert.equal(docs[0]!.type, "NT 10-Q");
  });
});

describe("Form 4", () => {
  it("parses owners, relationship, transactions and the 10b5-1 flag", () => {
    const d = parseOwnershipDocument(read("form4-0000905148-26-004807.txt"))!;
    assert.equal(d.issuerTradingSymbol, "STWD");
    assert.equal(d.owners[0]!.name, "Pollack Jonathan Lee");
    assert.equal(d.owners[0]!.isDirector, true);
    assert.equal(ownerRole(d.owners[0]!), "Director");
    assert.equal(d.aff10b5One, false);
    const p = d.transactions.filter((t) => t.code === "P");
    assert.equal(p.length, 2);
    assert.equal(p[0]!.shares, 85000);
    assert.equal(p[0]!.pricePerShare, 11.8361);
    assert.equal(p[1]!.directOrIndirect, "I");
    assert.equal(parseOwnershipDocument(read("form4-0000897069-26-001928.txt"))!.aff10b5One, true);
  });

  const qualify = (f: string) => {
    const d = parseOwnershipDocument(read(f))!;
    return purchasesOf(d, "acc", "2026-11-13T21:00:00.000Z", "https://www.sec.gov/x", d.issuerTradingSymbol);
  };

  it("keeps an open-market common purchase by a director", () => {
    const r = qualify("form4-0000905148-26-004807.txt");
    assert.equal(r.purchases.length, 2);
    assert.ok(Math.abs(r.purchases.reduce((s, p) => s + p.value, 0) - (85000 * 11.8361 + 84800 * 11.8795)) < 1);
  });

  it("drops 10b5-1, preferred stock and DRIP purchases", () => {
    assert.deepEqual(qualify("form4-0000897069-26-001928.txt").dropped.map((d) => d.reason), ["10b5-1 flag"]);
    assert.ok(qualify("form4-0000040417-26-000056.txt").dropped.every((d) => d.reason === "not common stock"));
    assert.equal(qualify("form4-0000040417-26-000056.txt").purchases.length, 0);
    const drip = qualify("form4-0000894671-26-000069.txt");
    assert.equal(drip.purchases.length, 0);
    assert.equal(drip.dropped[0]!.reason, "offering or plan purchase, not open market");
  });
});

function purchase(over: Partial<Purchase> & { owner: string; accession: string; date: string; acceptedAt: string }): Purchase {
  const { owner, ...rest } = over;
  return {
    issuerCik: "0000000001",
    issuerName: "ACME CORP",
    ticker: "ACME",
    owners: [{ cik: owner, name: `Owner ${owner}`, isDirector: true, isOfficer: false, isTenPercentOwner: false, isOther: false, officerTitle: null, otherText: null }],
    securityTitle: "Common Stock",
    shares: 1000,
    price: 20,
    value: 20000,
    raw: { shares: "1000", price: "20" },
    indexUrl: `https://www.sec.gov/${over.accession}`,
    ...rest,
  };
}

describe("insider clusters", () => {
  it("counts business days across a weekend", () => {
    assert.equal(businessDayIndex("2026-11-16") - businessDayIndex("2026-11-13"), 1); // Fri -> Mon
    assert.equal(businessDayIndex("2026-11-14"), businessDayIndex("2026-11-16")); // Sat maps to Mon
  });

  it("anchors a cluster on the filing that brings the third insider", () => {
    const ps = [
      purchase({ owner: "1", accession: "a1", date: "2026-11-09", acceptedAt: "2026-11-10T20:00:00Z" }),
      purchase({ owner: "2", accession: "a2", date: "2026-11-10", acceptedAt: "2026-11-11T20:00:00Z" }),
      purchase({ owner: "3", accession: "a3", date: "2026-11-13", acceptedAt: "2026-11-13T21:00:00Z" }),
      purchase({ owner: "4", accession: "a4", date: "2026-11-13", acceptedAt: "2026-11-13T22:00:00Z" }),
    ];
    const cs = findClusters(ps);
    assert.equal(cs.length, 1);
    assert.equal(cs[0]!.anchor.accession, "a3");
    assert.equal(cs[0]!.insiders, 4); // a4 joined the open cluster
  });

  it("does not cluster purchases more than 5 business days apart", () => {
    const ps = [
      purchase({ owner: "1", accession: "a1", date: "2026-11-02", acceptedAt: "2026-11-03T20:00:00Z" }),
      purchase({ owner: "2", accession: "a2", date: "2026-11-03", acceptedAt: "2026-11-04T20:00:00Z" }),
      purchase({ owner: "3", accession: "a3", date: "2026-11-09", acceptedAt: "2026-11-10T21:00:00Z" }),
    ];
    assert.equal(findClusters(ps).length, 0);
  });

  it("counts joint filers as one insider", () => {
    const joint = purchase({ owner: "1", accession: "a1", date: "2026-11-10", acceptedAt: "2026-11-10T20:00:00Z" });
    joint.owners = [...joint.owners, { ...joint.owners[0]!, cik: "9" }];
    const ps = [joint, purchase({ owner: "9", accession: "a2", date: "2026-11-10", acceptedAt: "2026-11-10T21:00:00Z" }), purchase({ owner: "3", accession: "a3", date: "2026-11-11", acceptedAt: "2026-11-11T21:00:00Z" })];
    const g = insiderGroups(ps);
    assert.equal(g.get("1"), g.get("9"));
    assert.equal(findClusters(ps).length, 0);
  });

  it("flags single officer or director purchases of $100k or more", () => {
    const big = purchase({ owner: "1", accession: "a1", date: "2026-11-10", acceptedAt: "2026-11-10T20:00:00Z", shares: 10000, value: 200000 });
    const small = purchase({ owner: "2", accession: "a2", date: "2026-11-10", acceptedAt: "2026-11-10T20:00:00Z" });
    const tenPct = purchase({ owner: "3", accession: "a3", date: "2026-11-10", acceptedAt: "2026-11-10T20:00:00Z", value: 500000 });
    tenPct.owners = [{ ...tenPct.owners[0]!, isDirector: false, isTenPercentOwner: true }];
    assert.deepEqual(findSingles([big, small, tenPct]).map((c) => c.anchor.accession), ["a1"]);
  });

  it("tells routine insiders by the same month in each of 3 prior years", () => {
    assert.equal(isRoutine(["2025-11-05", "2024-11-20", "2023-11-02", "2026-03-01"], "2026-11", null), true);
    assert.equal(isRoutine(["2025-11-05", "2023-11-02"], "2026-11", null), false);
    assert.equal(isRoutine(["2025-11-05"], "2026-11", "2025-01-01"), null); // list cut short
  });

  it("builds a filed-facts event with magnitude as % of market value", () => {
    const ps = ["1", "2", "3"].map((o, i) => purchase({ owner: o, accession: `a${i}`, date: "2026-11-10", acceptedAt: `2026-11-10T2${i}:00:00Z`, value: 100000, shares: 5000 }));
    const [c] = findClusters(ps);
    const e = toEvent(c!, { usd: 1e9, source: "test" }, { byCik: new Map() });
    assert.equal(e.id, "insider_cluster-a2");
    assert.equal(e.title, "3 insiders bought $300,000 of Acme Corp stock on Nov 10, 2026");
    assert.equal(e.magnitude, 0.03);
    assert.equal(e.sign, 1);
    assert.equal(e.propagates, "own");
    assert.equal(e.sources.length, 3);
    assert.equal(e.sources[0]!.url, "https://www.sec.gov/a2");
    assert.equal(usd(1_234_567), "$1.23M");
  });
});

describe("NT late filings", () => {
  const doc = parseSubmissionDocuments(read("nt10q-0001193125-26-460615.txt"))[0]!;
  const text = htmlToText(doc.body);

  it("reads Part III and Part IV(3) of a Form 12b-25", () => {
    const n = parseNtNotice(text, "NT 10-Q");
    assert.equal(n.subjectForm, "10-Q");
    assert.ok(n.reason.startsWith("Karyopharm Therapeutics Inc."));
    assert.ok(!/State below in reasonable detail/.test(n.reason));
    assert.equal(n.significantChange, true);
    assert.ok(n.changeNarrative!.startsWith("The Company expects that its results of operations"));
    assert.ok(!/Karyopharm Therapeutics Inc\.\s*$/.test(n.changeNarrative!));
  });

  it("builds the event with verbatim quotes", () => {
    const n = parseNtNotice(text, "NT 10-Q");
    const e = ntEvent({ accession: "0001193125-26-460615", form: "NT 10-Q", cik: "0001503802", ticker: "KPTI", companyName: "Karyopharm Therapeutics Inc.", acceptedAt: "2026-11-13T21:00:00.000Z", indexUrl: "https://www.sec.gov/x", notice: n, docText: text });
    assert.equal(e.title, "Karyopharm Therapeutics Inc. filed a late-filing notice for its 10-Q");
    assert.equal(e.sign, -1);
    assert.equal(e.quotes.length, 2);
    assert.equal(e.watchOnlyReasons.length, 0);
  });

  it("quotes the sentence that gives the cause, not the form's stock sentence", () => {
    const r = "The Company is unable, without unreasonable effort or expense, to file its Form 10-Q within the prescribed period. The delay is due to the pending review of an impairment charge by the Company's auditor.";
    assert.equal(reasonQuote(r), "The delay is due to the pending review of an impairment charge by the Company's auditor.");
    const one = "The Company will not, without unreasonable effort and expense, be able to file its Form 10-Q because it requires additional time to complete its liquidity analysis.";
    assert.equal(reasonQuote(one), one);
  });

  it("leaves out the Part IV(3) narrative when No is ticked", () => {
    const t = "PART III - NARRATIVE\nState below in reasonable detail the reasons why the report could not be filed within the prescribed period.\nThe Company needs more time to finish its audit of inventory.\nPART IV - OTHER INFORMATION\n(3) Is it anticipated that any significant change in results of operations from the corresponding period for the last fiscal year will be reflected by the earnings statements to be included in the subject report or portion thereof? ☐ Yes ☒ No\nIf so, attach an explanation of the anticipated change, both narratively and quantitatively, and, if appropriate, state the reasons why a reasonable estimate of the results cannot be made.\nSpecial Note Regarding Forward-Looking Statements and other boilerplate text here.\nACME CORP\n(Name of Registrant as Specified in Charter)";
    const n = parseNtNotice(t, "NT 10-Q");
    assert.equal(n.significantChange, false);
    assert.equal(n.changeNarrative, null);
    assert.equal(n.reasonQuote, "The Company needs more time to finish its audit of inventory.");
  });

  it("reads tick boxes in the common layouts", () => {
    assert.equal(tickedYesNo("☒ Yes ☐ No"), true);
    assert.equal(tickedYesNo("☐ Yes ☒ No"), false);
    assert.equal(tickedYesNo("Yes [X] No [ ]"), true);
    assert.equal(tickedYesNo("[ ] Yes [X] No"), false);
    assert.equal(tickedYesNo("þ Yes ¨ No"), true);
    assert.equal(tickedYesNo("Yes No"), null);
    assert.equal(leadQuote("Short. This is a long enough sentence to be quoted from the notice text."), "This is a long enough sentence to be quoted from the notice text.");
  });
});

describe("8-K routing and checks", () => {
  const aaon = htmlToText(read("8k-101-aaon-20261110.htm"));

  it("drops financing 1.01s by item and finds the item text", () => {
    assert.equal(routesToContract(["1.01", "9.01"]), true);
    assert.equal(routesToContract(["1.01", "2.03", "9.01"]), false);
    assert.equal(routesToContract(["1.02"]), true);
    assert.equal(routesToContract(["7.01"]), false);
    const s = itemSection(aaon, "1.01")!;
    assert.ok(s.startsWith("On November 10, 2026"));
    assert.ok(!s.includes("Financial Statements and Exhibits"));
  });

  it("parses stated dollar values", () => {
    assert.equal(parseUsd("$250.0 million"), 250e6);
    assert.equal(parseUsd("approximately $1.2 billion"), 1.2e9);
    assert.equal(parseUsd("$50,000.00"), 50000);
    assert.equal(parseUsd("no value"), null);
  });

  it("keeps only verbatim quotes and numbers that are in the filing", () => {
    assert.ok(checkedQuote("The 2026 Loan Agreement adds a $250.0 million term loan facility", aaon));
    assert.equal(checkedQuote("The 2026 Loan Agreement adds a $300.0 million term loan facility", aaon), null);
    assert.deepEqual(numbersNotIn("a $250.0 million term loan", aaon), []);
    assert.deepEqual(numbersNotIn("a $275 million term loan", aaon), ["275"]);
  });

  it("caps a contract at Watch for an unlisted counterparty, an offering or going-concern text", () => {
    const pump = antiPump("There is substantial doubt about the Company's ability to continue as a going concern.", [{ form: "S-3", filingDate: "2026-11-01" }], "3585", "2026-11-13T21:00:00Z");
    assert.equal(pump.goingConcern, true);
    assert.equal(pump.recentOffering, "S-3 filed 2026-11-01");
    const doc = "On November 10, 2026, Acme Corp entered into a Supply Agreement with Widget Holdings LLC for the purchase of parts. The agreement has a total value of $12.5 million.";
    const e = contractEvent({
      k: { accession: "acc", form: "8-K", items: ["1.01", "9.01"], acceptedAt: "2026-11-13T21:00:00Z", indexUrl: "https://www.sec.gov/x" },
      listing: { cik: "0000000001", name: "ACME CORP", ticker: "ACME", exchange: "Nasdaq" },
      company: "Acme Corp",
      doc,
      answer: {
        agreement_type: "supply_or_purchase",
        is_termination: false,
        counterparty: "Widget Holdings LLC",
        counterparty_is_government: false,
        filer_role: "customer_or_buyer",
        value_text: "$12.5 million",
        term_text: "",
        exclusivity: "not_stated",
        quote_counterparty: "On November 10, 2026, Acme Corp entered into a Supply Agreement with Widget Holdings LLC for the purchase of parts.",
        quote_value: "The agreement has a total value of $12.5 million.",
        quote_term: "",
        quote_exclusivity: "",
      },
      revenue: { value: 125e6, fiscalYearEnd: "2025-12-31" },
      counterparty: null,
      pump,
    })!;
    assert.equal(e.eventType, "contract_material");
    assert.equal(e.magnitude, 10);
    assert.equal(e.sign, 1);
    assert.deepEqual(e.watchOnlyReasons, ["counterparty is not a listed SEC filer", "going-concern language", "recent offering (S-3 filed 2026-11-01)"]);
    assert.equal(e.quotes.length, 2);
  });

  it("drops a value the model states but the quote does not hold", () => {
    const doc = "Acme Corp entered into a Supply Agreement with Widget Holdings LLC for the purchase of parts.";
    const e = contractEvent({
      k: { accession: "acc", form: "8-K", items: ["1.02"], acceptedAt: "2026-11-13T21:00:00Z", indexUrl: "https://www.sec.gov/x" },
      listing: { cik: "1", name: "ACME CORP", ticker: "ACME", exchange: "Nasdaq" },
      company: "Acme Corp",
      doc,
      answer: { agreement_type: "supply_or_purchase", counterparty: "Widget Holdings LLC", counterparty_is_government: false, filer_role: "other", value_text: "$40 million", term_text: "", exclusivity: "exclusive", quote_counterparty: doc, quote_value: "", quote_term: "", quote_exclusivity: "" },
      revenue: { value: 1e8, fiscalYearEnd: "2025-12-31" },
      counterparty: null,
      pump: { goingConcern: false, recentOffering: null, shell: false },
    })!;
    assert.equal(e.eventType, "contract_termination");
    assert.equal(e.sign, -1);
    assert.equal(e.facts.value, null);
    assert.equal(e.magnitude, null);
    assert.equal(e.facts.exclusivity, "not_stated");
  });

  it("reads restatement scope only from quotes found in the filing", () => {
    const doc = "On November 12, 2026, the Audit Committee concluded that the Company's previously issued financial statements for the fiscal year ended December 31, 2025 should no longer be relied upon. The error relates to the timing of revenue recognition for certain bill-and-hold arrangements.";
    const base = { k: { accession: "acc", form: "8-K", items: ["4.02"], acceptedAt: "2026-11-13T21:00:00Z", indexUrl: "https://www.sec.gov/x" }, ticker: "ACME", cik: "1", company: "Acme Corp", doc };
    const good = restatementEvent({ ...base, answer: { is_non_reliance: true, revenue_restated: "yes", periods: "fiscal year ended December 31, 2025", reason: "timing of revenue recognition", quote_scope: doc.split(". ")[0] + ".", quote_reason: "The error relates to the timing of revenue recognition for certain bill-and-hold arrangements." } })!;
    assert.equal(good.facts.revenueRestated, "yes");
    assert.match(good.title, /including revenue/);
    assert.equal(good.watchOnlyReasons.length, 0);
    const made = restatementEvent({ ...base, answer: { is_non_reliance: true, revenue_restated: "yes", periods: "fiscal year 2024", reason: "x", quote_scope: "invented sentence about nothing at all", quote_reason: "another invented sentence here" } })!;
    assert.equal(made.facts.revenueRestated, "unclear");
    assert.ok(made.watchOnlyReasons.length > 0);
    assert.equal(restatementEvent({ ...base, answer: { is_non_reliance: false } }), null);
  });

  it("turns triage labels into signed guidance events with checked quotes", () => {
    const doc = "Acme now expects fiscal 2026 revenue of $4.2 billion, up from its prior outlook of $4.0 billion, an increase of 5%. Acme also announced a dividend.";
    const findings = checkFindings(
      { findings: [{ label: "guidance_raise", quote: "Acme now expects fiscal 2026 revenue of $4.2 billion, up from its prior outlook of $4.0 billion, an increase of 5%.", change_text: "5%" }, { label: "capex_cut", quote: "Acme cut capex by 20%.", change_text: "20%" }, { label: "none", quote: "", change_text: "" }] },
      doc,
    );
    assert.deepEqual(findings.map((f) => f.label), ["guidance_raise"]);
    const es = guidanceEvents({ k: { accession: "acc", form: "8-K", items: ["7.01", "9.01"], acceptedAt: "2026-11-13T21:00:00Z", indexUrl: "https://www.sec.gov/x" }, cik: "1", ticker: "ACME", company: "Acme", suppliers: ["TSM"], findings });
    assert.equal(es.length, 1);
    assert.equal(es[0]!.eventType, "guidance_up");
    assert.equal(es[0]!.family, "F2");
    assert.equal(es[0]!.magnitude, 5);
    assert.equal(es[0]!.propagates, "linked");
    assert.equal(statedPct("down 3.5 percent", -1), -3.5);
  });

  it("takes the watch set of customers from the graph", () => {
    const g = { generatedAt: "", names: {}, edges: [
      { id: "1", from: "NVDA", to: "TSM", toName: "TSMC", category: "supplier", tier: "critical", disclosedSharePct: null, quote: "", form: "10-K", filedAt: "", url: "", origin: "" },
      { id: "2", from: "AMKR", to: "AAPL", toName: "Apple", category: "customer", tier: "important", disclosedSharePct: 10, quote: "", form: "10-K", filedAt: "", url: "", origin: "" },
      { id: "3", from: "AMD", to: "NVDA", toName: "NVIDIA", category: "competitor", tier: "important", disclosedSharePct: null, quote: "", form: "10-K", filedAt: "", url: "", origin: "" },
    ] } as Parameters<typeof graphCustomers>[0];
    const c = graphCustomers(g);
    assert.deepEqual([...c.keys()].sort(), ["AAPL", "NVDA"]);
    assert.deepEqual(c.get("NVDA"), ["TSM"]);
  });
});

describe("companies", () => {
  it("prefers a listed row per CIK and matches names loosely", () => {
    const l = parseListings({ fields: ["cik", "name", "ticker", "exchange"], data: [[1, "Acme Holdings, Inc.", "ACMEF", "OTC"], [1, "Acme Holdings, Inc.", "ACME", "Nasdaq"], [2, "Widget Corp /DE/", "WDG", "NYSE"]] });
    assert.equal(l.byCik.get("0000000001")!.ticker, "ACME");
    assert.equal(normalizeCompanyName("Widget Corp /DE/"), "widget");
    assert.equal(matchListed("Widget Corporation", l)!.ticker, "WDG");
    assert.equal(matchListed("Unknown Private LLC", l), null);
  });

  it("matches a subsidiary named after its listed parent", () => {
    const l = parseListings({ fields: ["cik", "name", "ticker", "exchange"], data: [[3, "BioNTech SE", "BNTX", "Nasdaq"], [4, "ON Semiconductor Corp", "ON", "Nasdaq"]] });
    assert.equal(matchListed("BioNTech US Inc.", l)!.ticker, "BNTX");
    assert.equal(matchListed("On Track Logistics", l), null);
  });

  it("writes insider and company names for reading", () => {
    assert.equal(personName("BIGLARI, SARDAR"), "Sardar Biglari");
    assert.equal(personName("MULLEE SPENCER EDWARD"), "Spencer Edward Mullee");
    assert.equal(personName("BARTELS ROBERT E JR"), "Robert E Bartels Jr");
    assert.equal(personName("DE ANGOITIA ALFONSO"), "Alfonso De Angoitia");
    assert.equal(personName("Basswood Capital Management, L.L.C."), "Basswood Capital Management, L.L.C.");
    assert.equal(displayName("MP Materials Corp. / DE"), "MP Materials Corp.");
    assert.equal(displayName("Six Flags Entertainment Corporation/NEW"), "Six Flags Entertainment Corporation");
  });

  it("picks the latest fiscal year's revenue as first filed", () => {
    const r = latestAnnual(
      [
        { start: "2024-01-01", end: "2024-12-31", val: 90, form: "10-K", filed: "2025-02-20" },
        { start: "2025-01-01", end: "2025-12-31", val: 100, form: "10-K", filed: "2026-02-20" },
        { start: "2025-01-01", end: "2025-12-31", val: 101, form: "10-K", filed: "2027-02-20" },
        { start: "2025-10-01", end: "2025-12-31", val: 30, form: "10-K", filed: "2026-02-20" },
      ],
      "Revenues",
    )!;
    assert.equal(r.value, 100);
    assert.equal(r.fiscalYearEnd, "2025-12-31");
  });
});

describe("Schedule 13D", () => {
  it("reads the cover and Item 4", () => {
    const d = parse13D(read("sc13d-0001072613-26-000890.txt"))!;
    assert.equal(d.issuerName, "Coursera, Inc.");
    assert.equal(d.percentOfClass, "5.1");
    assert.equal(d.dateOfEvent, "11/05/2026");
    assert.ok(d.reportingPersons.includes("New Enterprise Associates 13, L.P."));
    assert.ok(d.purpose.startsWith("The Funds acquired the Firm Shares"));
  });
});

describe("registry", () => {
  it("runs every detector and keeps going when one fails", async () => {
    const ok: Detector = { eventTypes: ["distress_nt"], detect: async () => [{ id: "x" } as DetectorEvent] };
    const bad: Detector = { eventTypes: ["insider_cluster"], detect: async () => { throw new Error("boom"); } };
    const lines: string[] = [];
    const out = await detectAll({ since: new Date(0), until: new Date(1), llmBudgetUsd: 0, dryRun: true, log: (l) => lines.push(l) }, [bad, ok]);
    assert.equal(out.length, 1);
    assert.match(lines[0]!, /insider_cluster failed: boom/);
  });
});
