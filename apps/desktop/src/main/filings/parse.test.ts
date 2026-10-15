import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  auditorName,
  companyKey,
  concentrationFacts,
  findSection,
  goingConcernSentence,
  headingKey,
  htmlBlocks,
  isGroupHeading,
  LARGEST_CUSTOMER,
  looksLikeTableRow,
  materialWeaknessSentence,
  readDocument,
  RISK_MAX_HEADINGS,
  riskHeadings,
  riskReadability,
  sameAuditor,
  saysNoMaterialChanges,
  sectionText,
  soleSourceSentences,
} from "./parse";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(HERE, "fixtures", name), "utf8");

function read(name: string) {
  const html = fixture(name);
  const blocks = htmlBlocks(html);
  return { html, blocks, text: blocks.map((b) => b.text).join("\n") };
}

describe("htmlBlocks", () => {
  it("measures emphasis from tags and inline styles, and skips hidden XBRL", () => {
    const blocks = htmlBlocks(
      '<div style="display:none"><ix:header>0000000001</ix:header></div>' +
        '<div><span style="font-weight:700">Bold heading here</span></div>' +
        '<div><span style="font-weight:400">plain</span> <b>bold</b></div>' +
        "<p><i>The lead sentence is set in italic.</i> The body follows in roman type.</p>",
    );
    assert.equal(blocks[0]!.text, "Bold heading here");
    assert.equal(blocks[0]!.emph, 1);
    assert.ok(blocks[1]!.emph > 0.3 && blocks[1]!.emph < 0.6);
    assert.equal(blocks[2]!.lead, "The lead sentence is set in italic.");
    assert.ok(!blocks.some((b) => b.text.includes("0000000001")));
  });

  it("decodes entities and keeps the nearest anchor", () => {
    const blocks = htmlBlocks('<div id="sec"><span>Ernst &amp; Young&#160;LLP &#8217;s</span></div>');
    assert.equal(blocks[0]!.text, "Ernst & Young LLP \u2019s");
    assert.equal(blocks[0]!.anchor, "sec");
  });

  it("survives unbalanced tags", () => {
    const blocks = htmlBlocks("<div><b>Open bold<div>still bold</div></span></span><p>after</p>");
    assert.deepEqual(
      blocks.map((b) => b.text),
      ["Open bold", "still bold", "after"],
    );
  });
});

describe("readDocument", () => {
  it("records where each id lands, the in-document links a block holds, its table row and its font size", () => {
    const { blocks, ids } = readDocument(
      '<table><tr><td><div>Risk Factors</div></td><td><div><a href="#rf"><span style="font-size:9pt">12</span></a></div></td></tr></table>' +
        '<div id="rf"><span style="font-size:16px">Heading</span></div><p>Body <span style="font-size:9pt">text</span></p>',
    );
    assert.deepEqual(
      blocks.map((b) => [b.text, b.row, b.links, b.size]),
      [
        ["Risk Factors", 1, null, null],
        ["12", 1, ["rf"], 9],
        ["Heading", null, null, 12],
        ["Body text", null, null, null],
      ],
    );
    assert.equal(ids.get("rf"), 2);
  });
});

describe("headingKey", () => {
  it("drops a trailing page number but keeps an item number", () => {
    assert.equal(headingKey("Item 1A. | Risk Factors | 12"), "item 1a risk factors");
    assert.equal(headingKey("ITEM 4."), "item 4");
  });
});

describe("findSection", () => {
  it("finds Item 1A past the table of contents", () => {
    const { blocks } = read("tenk-2025.html");
    const risk = findSection(blocks, "risk");
    assert.ok(risk);
    assert.equal(risk.anchor, "i_item1a");
    assert.match(blocks[risk.start]!.text, /^The risks described below/);
    assert.match(blocks[risk.end]!.text, /^ITEM 1B/);
  });

  it("reads \"no material changes from any of the risk factors\" as no material changes", () => {
    assert.ok(saysNoMaterialChanges("There are no material changes from any of the risk factors previously disclosed in our 2025 Form 10-K in response to Part I, Item 1A."));
  });

  it("finds a 10-Q's Part II Item 1A, with the item and its title in separate blocks", () => {
    const { blocks } = read("tenq-unchanged.html");
    const risk = findSection(blocks, "risk");
    assert.ok(risk);
    assert.ok(saysNoMaterialChanges(sectionText(blocks, risk)));
  });

  it("follows the table of contents' links in an integrated report, ending at the next entry", () => {
    const { html, blocks } = read("tenk-integrated.html");
    const risk = findSection(readDocument(html), "risk");
    assert.ok(risk);
    assert.equal(risk.via, "toc");
    assert.equal(risk.anchor, "c_rf");
    assert.match(blocks[risk.start]!.text, /^The following summarizes/);
    assert.equal(blocks[risk.end]!.text, "Executive Officers");
    // The headings are set in a larger face, not in bold: read by size. A bulleted run-in lead is not one.
    assert.deepEqual(
      riskHeadings(blocks, risk).map((h) => h.text),
      ["We are in a highly competitive and rapidly changing industry.", "We rely upon a complex global supply chain.", "Changes in our effective tax rate may impact our net income."],
    );
  });

  it("without the links, the heading search runs into the financial statements, and the guard says so", () => {
    const { blocks } = read("tenk-integrated.html");
    const total = blocks.reduce((n, b) => n + b.text.length, 0);
    const risk = findSection(blocks, "risk");
    assert.ok(risk);
    assert.equal(risk.via, "heading");
    const heads = riskHeadings(blocks, risk);
    assert.ok(heads.some((h) => h.text.startsWith("Net income (loss)")));
    assert.deepEqual(riskReadability(risk, heads, total, true), { readable: false, reason: "share" });
  });

  it("finds a 20-F's Risk Factors sub-item and stops at Item 4", () => {
    const { blocks } = read("twentyf-lines.html");
    const risk = findSection(blocks, "risk");
    assert.ok(risk);
    assert.match(blocks[risk.end]!.text, /^ITEM 4/);
  });
});

describe("riskHeadings", () => {
  it("reads each risk factor heading verbatim, with its group", () => {
    const { blocks } = read("tenk-2025.html");
    const heads = riskHeadings(blocks, findSection(blocks, "risk")!);
    assert.deepEqual(
      heads.map((h) => h.text),
      [
        "The risks described below are not the only ones we face.",
        "Our revenue depends on a small number of customers, and the loss of any of them could harm our results.",
        "Our operating results fluctuate from quarter to quarter, which makes them difficult to predict.",
        "Climate change may have a long-term impact on our business.",
        "The market price of our common stock in fiscal 2024 has been volatile and may continue to be volatile.",
        "We have never paid dividends on our common stock.",
      ],
    );
    assert.equal(heads[1]!.group, "Risks Related to Our Business");
    assert.equal(heads[4]!.group, "Risks Related to Our Common Stock");
  });

  it("takes a bold run that opens a paragraph as its heading", () => {
    const { blocks } = read("tenk-2026.html");
    const heads = riskHeadings(blocks, findSection(blocks, "risk")!).map((h) => h.text);
    assert.ok(heads.includes("We depend on Umbrella Materials as the sole source of our wafers."));
  });

  it("joins a heading printed over several lines", () => {
    const { blocks } = read("twentyf-lines.html");
    const heads = riskHeadings(blocks, findSection(blocks, "risk")!).map((h) => h.text);
    assert.deepEqual(heads, [
      "The market value of our shares may fluctuate due to the volatility of, and government intervention in, the R.O.C. securities market.",
      "Since we procure some of our raw materials from sole-sourced suppliers, our supply could be disrupted.",
    ]);
  });

  it("strips a bullet a heading opens with, and starts a new heading at each bullet", () => {
    const blocks = htmlBlocks(
      "<p><b>Item 1A. Risk Factors</b></p><p><b>Risks Related to Our Business</b></p>" +
        "<p><b>\u2022Pharmaceutical research and development is very costly and highly uncertain.</b></p><p>Body.</p>" +
        "<p><b>\u2022We face intense competition from multinational companies.</b></p><p>Body.</p><p><b>Item 1B. Unresolved Staff Comments</b></p>",
    );
    assert.deepEqual(
      riskHeadings(blocks, findSection(blocks, "risk")!).map((h) => [h.group, h.text]),
      [
        ["Risks Related to Our Business", "Pharmaceutical research and development is very costly and highly uncertain."],
        ["Risks Related to Our Business", "We face intense competition from multinational companies."],
      ],
    );
  });

  it("parts headings printed one after another without a full stop, unless a line breaks off mid-phrase", () => {
    const blocks = htmlBlocks(
      "<p><b>D. Risk Factors</b></p>" +
        "<p><b>Our future success depends on our ability to respond</b></p><p><b>in a timely manner to developments in the industry</b></p>" +
        "<p><b>The semiconductor industry can be cyclical, and we may be adversely affected by</b></p><p><b>Any downturn</b></p>" +
        "<p><b>We derive most of our revenues from a small number of products</b></p><p>Body.</p><p><b>ITEM 4. INFORMATION ON THE COMPANY</b></p>",
    );
    assert.deepEqual(
      riskHeadings(blocks, findSection(blocks, "risk")!).map((h) => h.text),
      [
        "Our future success depends on our ability to respond in a timely manner to developments in the industry",
        "The semiconductor industry can be cyclical, and we may be adversely affected by Any downturn",
        "We derive most of our revenues from a small number of products",
      ],
    );
  });

  it("tells group headings from risk factors", () => {
    assert.ok(isGroupHeading("Risks Related to Our Business, Operations and Industry"));
    assert.ok(isGroupHeading("General Risks"));
    assert.ok(!isGroupHeading("Our stock price is subject to volatility."));
  });
});

describe("riskReadability", () => {
  const section = (chars: number) => ({ start: 0, end: 1, anchor: null, chars, via: "toc" as const });
  const heads = (texts: string[]) => texts.map((text) => ({ text, group: null }));
  const RISKS = heads([
    "We are in a highly competitive and rapidly changing industry.",
    "We rely upon a complex global supply chain.",
    "Changes in our effective tax rate may impact our net income.",
    "Our stock price is subject to volatility.",
    "We face risks related to our debt obligations.",
  ]);

  it("passes a section of risk statements that holds a third of the document", () => {
    assert.deepEqual(riskReadability(section(340), RISKS, 1000, true), { readable: true });
  });

  it("a section holding most of the document is no section: half for an annual report, four fifths for a 10-Q", () => {
    assert.deepEqual(riskReadability(section(510), RISKS, 1000, true), { readable: false, reason: "share" });
    // A 10-Q that repeats every risk factor runs to two thirds of its text (AMD).
    assert.deepEqual(riskReadability(section(640), RISKS, 1000, false), { readable: true });
    assert.deepEqual(riskReadability(section(810), RISKS, 1000, false), { readable: false, reason: "share" });
  });

  it("too many headings, table rows or titles are not risk factors", () => {
    const many = heads(Array.from({ length: RISK_MAX_HEADINGS + 1 }, (_, i) => `We may face risk number ${i} of many kinds.`));
    assert.deepEqual(riskReadability(section(100), many, 1000, true), { readable: false, reason: "count" });
    const rows = heads([
      ...RISKS.map((h) => h.text),
      "Net revenue $ 13,577 $ 12,667 Cost of sales 8,211 7,902",
      "Three Months Ended (In Millions; Unaudited) Jun 27, 2026 Jun 28, 2025",
    ]);
    assert.deepEqual(riskReadability(section(100), rows, 1000, true), { readable: false, reason: "table_rows" });
    const titles = heads([
      "We rely upon a complex global supply chain.",
      "Certification of the Chief Executive Officer pursuant to Rule 13a-14(a) of the Exchange Act",
      "Acme Corporation Compensation Recoupment Policy, effective October 2, 2023",
      "Reuse rate of parts returned from the field and factory",
      "Information About Our Executive Officers and Directors",
    ]);
    assert.deepEqual(riskReadability(section(100), titles, 1000, true), { readable: false, reason: "not_sentences" });
  });

  it("knows a table row or a footnote from a heading", () => {
    assert.ok(looksLikeTableRow("Net income (loss) attributable to Intel $ (3,728) $ (821) Earnings (loss) per share attributable to Intel"));
    assert.ok(looksLikeTableRow("1 Employee headcount includes our core Intel workforce as well as employees at Mobileye and other subsidiaries."));
    assert.ok(!looksLikeTableRow("The market price of our common stock in fiscal 2025 has been volatile and may continue to be volatile."));
    assert.ok(!looksLikeTableRow("We do not expect to pay any cash dividends in the foreseeable future, except for the 7.00% dividend on our Mandatory Convertible Preferred Stock."));
  });
});

describe("red flag readers", () => {
  it("going concern: the auditor's paragraph counts, policy text does not", () => {
    assert.equal(goingConcernSentence(read("tenk-2025.html").text), null);
    assert.match(goingConcernSentence(read("tenk-2026.html").text) ?? "", /going concern/);
    assert.equal(goingConcernSentence("If we cannot raise capital, there could be substantial doubt about our ability to continue as a going concern."), null);
  });

  it("material weakness: only in the controls item, and not when negated", () => {
    const a = read("tenk-2025.html");
    assert.equal(materialWeaknessSentence(sectionText(a.blocks, findSection(a.blocks, "controls"))), null);
    const b = read("tenk-2026.html");
    assert.match(materialWeaknessSentence(sectionText(b.blocks, findSection(b.blocks, "controls"))) ?? "", /not effective/);
    assert.equal(materialWeaknessSentence("A material weakness could result in a misstatement of our financial statements."), null);
  });

  it("reads the auditor from the cover tag, else the signature", () => {
    const a = read("tenk-2025.html");
    assert.equal(auditorName(a.html, a.text), "Ernst & Young LLP");
    assert.equal(auditorName("", "Report of Independent Registered Public Accounting Firm\n/s/ Deloitte & Touche LLP\nSan Jose"), "Deloitte & Touche LLP");
    // Spans that split a word (a 20-F laid out from a PDF) join; a block parts words.
    assert.equal(
      auditorName('<ix:nonNumeric name="dei:AuditorName"><span>Pric</span><span>ewaterhouseCoopers</span><span> Accountants N.V.</span></ix:nonNumeric>', ""),
      "PricewaterhouseCoopers Accountants N.V.",
    );
    assert.equal(auditorName('<ix:nonNumeric name="dei:AuditorName"><div>KPMG</div><div>LLP</div></ix:nonNumeric>', ""), "KPMG LLP");
    assert.ok(sameAuditor("PricewaterhouseCoopers LLP", "PricewaterhouseCoopers, LLP"));
    assert.ok(!sameAuditor("Ernst & Young LLP", "KPMG LLP"));
  });

  it("customer concentration: single names, the respectively shape, lettered customers", () => {
    const facts = concentrationFacts(read("tenk-2026.html").text);
    assert.deepEqual(
      facts.map((f) => [f.label, f.pct, f.basis]),
      [
        ["Globex Corporation", 24, "revenue"],
        ["Hooli Inc.", 11, "revenue"],
      ],
    );
    assert.deepEqual(
      concentrationFacts("Sales to direct Customers A, B and C represented 12%, 11% and 11% of total revenue, respectively, for fiscal year 2025.").map((f) => [f.label, f.pct]),
      [
        ["Customer A", 12],
        ["Customer B", 11],
        ["Customer C", 11],
      ],
    );
    assert.deepEqual(concentrationFacts("For fiscal 2026, sales to one customer represented 28.1% of total net sales.").map((f) => [f.label, f.pct]), [["One customer", 28.1]]);
  });

  it("customer concentration leaves out places, plural groups and shares under 10%", () => {
    assert.deepEqual(concentrationFacts("Sales to customers located outside of the United States represented 29.1% of net sales in fiscal 2026."), []);
    assert.deepEqual(concentrationFacts("Sales to Initech accounted for 6% of our net revenue."), []);
    assert.deepEqual(concentrationFacts("No sales to an individual customer or country other than the United States accounted for more than 10% of revenue for fiscal years 2026, 2025, or 2024."), []);
    // Several customers together: one share for the group, matched across years by the group's own words.
    assert.deepEqual(concentrationFacts("Our ten largest customers accounted for 72% of our net sales in 2025.").map((f) => [f.label, f.pct]), [["Our ten largest customers", 72]]);
  });

  it("customer concentration: a share each for unnamed customers gives the largest", () => {
    assert.deepEqual(
      concentrationFacts("Direct sales to our two largest customers accounted for 29.8% and 11.1% of our net sales for 2025.").map((f) => [f.label, f.pct]),
      [[LARGEST_CUSTOMER, 29.8]],
    );
    assert.deepEqual(
      concentrationFacts("As of June 30, 2026, three customers accounted for 23.0%, 17.1%, and 12.5% of our accounts receivable balance.").map((f) => [f.label, f.pct, f.basis]),
      [[LARGEST_CUSTOMER, 23, "receivables"]],
    );
    // Two customers with one share each year is the group's share, not each one's.
    assert.deepEqual(
      concentrationFacts("Two customers accounted for 25% and 22% of revenue in fiscal 2026 and 2025, respectively.").map((f) => [f.label, f.pct]),
      [["Two customers", 25]],
    );
  });

  it("customer concentration keeps the latest year only, in whatever order the years run", () => {
    const text =
      "For the fiscal year ended June 30, 2026, sales to one customer represented 28.1% of total net sales. " +
      "For the fiscal year ended June 30, 2025, sales to four customers represented 31.9%, 11.5%, 11.3%, and 11.1% of total net sales.";
    assert.deepEqual(concentrationFacts(text).map((f) => [f.label, f.pct]), [["One customer", 28.1]]);
    assert.deepEqual(concentrationFacts("Apple accounted for 12% and 18% of our revenue in fiscal 2025 and 2026, respectively.").map((f) => [f.label, f.pct]), [["Apple", 18]]);
    assert.deepEqual(concentrationFacts("In 2025, 2024 and 2023 one customer accounted for 29.8%, 30.8% and 27.7% of total net sales, respectively.").map((f) => [f.label, f.pct]), [["One customer", 29.8]]);
  });

  it("customer concentration tables: net sales and receivables apart, the latest year's column", () => {
    const table = (caption: string, header: string[], rows: string[][]) =>
      `<p>${caption}</p><table><tr>${header.map((h) => `<td>${h}</td>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table><p>*Below 10%</p>`;
    const html =
      "<p>Concentration of Credit Risk</p>" +
      table("Significant customer information is as follows:", ["", "June 30, 2025", "June 30, 2024"], [["Percentage of accounts receivable", "", ""], ["Customer A", "33.4%", "15.4%"], ["Customer B", "13.6%", "*"], ["Customer C", "*", "44.8%"]]) +
      "<p>Concentration of Customer Risk</p>" +
      table("Significant customer information is as follows:", ["", "2023", "2024", "2025"], [["Percentage of total net sales", "", "", ""], ["Customer A", "*", "20.0 %", "20.9 %"], ["Customer B (1)", "*", "*", "11.5 %"]]) +
      // Places and suppliers are no customers.
      table("Net sales by geographic region:", ["", "2025", "2024"], [["United States", "59.4%", "68.0%"], ["Asia", "25.0%", "19.4%"]]) +
      table("Two suppliers accounted for below percentage of total purchases:", ["", "2025", "2024"], [["Supplier A", "64.4%", "65.4%"]]) +
      // A table that gives net sales and receivables side by side cannot be told apart: left out.
      table("Customers over 10% of net sales and accounts receivable:", ["", "Net sales 2025", "Receivables 2025"], [["Customer A", "15%", "22%"]]) +
      // Named customers where the table speaks of customers.
      table("Revenue from customers that accounted for 10% or more of total revenue:", ["", "Fiscal 2025", "Fiscal 2024"], [["Globex Corporation", "24%", "18%"], ["Total", "24%", "18%"]]);
    const doc = readDocument(html);
    const text = doc.blocks.map((b) => b.text).join(String.fromCharCode(10));
    assert.deepEqual(
      concentrationFacts(text, doc.blocks).map((f) => [f.basis, f.label, f.pct]),
      [
        ["receivables", "Customer A", 33.4],
        ["receivables", "Customer B", 13.6],
        ["revenue", "Customer A", 20.9],
        ["revenue", "Customer B", 11.5],
        ["revenue", "Globex Corporation", 24],
      ],
    );
  });

  it("sole and single source sentences", () => {
    const s = soleSourceSentences(read("tenk-2026.html").text);
    assert.ok(s.some((x) => /Umbrella Materials is our sole supplier/.test(x)));
  });

  it("company names reduce to the words that identify them", () => {
    assert.equal(companyKey("Apple Inc."), "apple");
    assert.equal(companyKey("OpenAI OpCo, LLC"), "openai");
    assert.equal(companyKey("Taiwan Semiconductor Manufacturing Company Limited"), "taiwan semiconductor manufacturing");
  });
});
