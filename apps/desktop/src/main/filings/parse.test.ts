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
  materialWeaknessSentence,
  riskHeadings,
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

  it("finds a 10-Q's Part II Item 1A, with the item and its title in separate blocks", () => {
    const { blocks } = read("tenq-unchanged.html");
    const risk = findSection(blocks, "risk");
    assert.ok(risk);
    assert.ok(saysNoMaterialChanges(sectionText(blocks, risk)));
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

  it("tells group headings from risk factors", () => {
    assert.ok(isGroupHeading("Risks Related to Our Business, Operations and Industry"));
    assert.ok(isGroupHeading("General Risks"));
    assert.ok(!isGroupHeading("Our stock price is subject to volatility."));
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
    assert.deepEqual(concentrationFacts("Direct sales to our two largest customers accounted for 29.8% and 11.1% of our net sales for 2025."), []);
    assert.deepEqual(concentrationFacts("Sales to Initech accounted for 6% of our net revenue."), []);
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
