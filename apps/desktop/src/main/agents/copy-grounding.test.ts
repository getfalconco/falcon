import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { EM_DASH, EN_DASH, copyProblems } from "../../shared/copy-rules";
import { cleanModelText, copyIssues, enforceCopy, enforceLine, softenCopy } from "./copy";
import { corpusNumbers, isGrounded, numbersIn, ungroundedNumbers } from "./grounding";
import { focusText, htmlToText, parseConsensus, parseForm4 } from "./sources";

describe("copy rules on model output", () => {
  it("replaces dashes, keeping ranges readable", () => {
    assert.equal(cleanModelText(`Revenue rose${EM_DASH}again${EM_DASH}to a record.`), "Revenue rose, again, to a record.");
    assert.equal(cleanModelText(`Guidance of $54${EN_DASH}56 billion.`), "Guidance of $54 to 56 billion.");
    assert.equal(copyIssues(cleanModelText(`A ${EM_DASH} B ${EN_DASH} C`)).filter((i) => i.includes("dash")).length, 0);
  });

  it("drops emoji, exclamation marks, filler and delve", () => {
    const out = cleanModelText("Great question! Revenue was $57.0 billion \u{1F680}! Let me delve into margins. I hope this helps!");
    assert.equal(out, "Revenue was $57.0 billion. Let me look at margins.");
    assert.equal(cleanModelText("As an AI, I watch filings. The 10-Q is out."), "The 10-Q is out.");
  });

  it("writes a May date numerically so it never reads as a forecast word", () => {
    assert.equal(cleanModelText("Results came out on May 21, 2026."), "Results came out on 2026-05-21.");
    assert.equal(cleanModelText("Results came out on May 21."), "Results came out on 5/21.");
  });

  it("finds advice and forward-looking words", () => {
    assert.deepEqual(copyIssues("Insiders sold shares and analysts expect more."), ['banned word "sell"', 'banned word "expect"']);
    assert.deepEqual(copyIssues("Revenue rose 62% to $57.0 billion."), []);
  });

  it("softens what has a plain synonym", () => {
    assert.equal(softenCopy("Revenue fell short of consensus; the CFO sold 10,000 shares."), "Revenue came in below consensus; the CFO disposed of 10,000 shares.");
    assert.equal(softenCopy("The company expects margins near 75% and raised its price target."), "The company anticipates margins near 75% and raised its analyst price estimate.");
    assert.deepEqual(copyIssues(softenCopy("Sell-side analysts expected a beat.")), []);
  });

  it("drops a sentence nothing can rescue and keeps the rest", () => {
    const out = enforceCopy("Revenue was $57.0 billion. The stock will likely rise. Margin was 73.4%.");
    assert.equal(out, "Revenue was $57.0 billion. Margin was 73.4%.");
    assert.equal(enforceLine("You should buy now!", "Fallback line."), "Fallback line.");
  });

  it("keeps paragraphs and decimal figures intact", () => {
    const out = enforceCopy("Revenue was $30.8 billion.\n\nGross margin was 75.1%, per the U.S. filing.");
    assert.equal(out, "Revenue was $30.8 billion.\n\nGross margin was 75.1%, per the U.S. filing.");
  });
});

describe("grounding", () => {
  const corpus = corpusNumbers("Revenue $57,006 million, up 62%. Data Center revenue was $51,215 million. GAAP gross margin 73.4%. EPS $1.30.");

  it("matches a figure written in other units or at a coarser precision", () => {
    assert.deepEqual(ungroundedNumbers("Revenue was $57.0 billion, up 62%.", corpus), []);
    assert.deepEqual(ungroundedNumbers("Data center revenue was $51.2 billion.", corpus), []);
    assert.deepEqual(ungroundedNumbers("EPS of $1.30 and a 73.4% margin.", corpus), []);
  });

  it("flags figures the material does not contain", () => {
    assert.deepEqual(ungroundedNumbers("Gross margin was 75.0% and EPS $1.45.", corpus), ["75.0", "1.45"]);
  });

  it("ignores labels: dates, quarters, years and small counts", () => {
    assert.deepEqual(ungroundedNumbers("In Q3 2026, on 2026-11-19 and 11/19 at 16:20, 3 segments grew.", corpus), []);
    assert.equal(numbersIn("Q4 FY2027").length, 0);
    assert.equal(isGrounded({ value: 5, decimals: 0, raw: "5" }, []), true);
  });
});

describe("source parsers", () => {
  it("turns filing HTML into lines of text", () => {
    const text = htmlToText("<html><head><style>x{}</style></head><body><p>Revenue&nbsp;was $57.0&#160;billion</p><table><tr><td>Q3</td><td>57,006</td></tr></table></body></html>");
    assert.match(text, /Revenue was \$57\.0 billion/);
    assert.match(text, /Q3 \| 57,006/);
  });

  it("keeps the opening and the paragraphs that name the metrics", () => {
    const long = `${"Intro line. ".repeat(500)}\nUnrelated paragraph.\nData center revenue was $51.2 billion.\n${"Filler. ".repeat(4000)}`;
    const focused = focusText(long, ["data center"], 8000);
    assert.ok(focused.length <= 8000);
    assert.match(focused, /Data center revenue was \$51\.2 billion/);
    assert.doesNotMatch(focused, /Unrelated paragraph/);
  });

  it("reads consensus lines from the provider's modules", () => {
    const read = parseConsensus(
      {
        earningsTrend: {
          trend: [
            { period: "0q", endDate: "2026-10-31", earningsEstimate: { avg: { raw: 1.25 }, numberOfAnalysts: { raw: 40 } }, revenueEstimate: { avg: { raw: 54800000000 } } },
            { period: "+1y", endDate: "2027-01-31", earningsEstimate: { avg: { raw: 5 } } },
          ],
        },
        earningsHistory: { history: [{ quarter: { fmt: "2026-07-31" }, epsActual: { raw: 1.05 }, epsEstimate: { raw: 1.01 } }] },
      },
      "2026-11-18T12:00:00.000Z",
    );
    assert.ok(read);
    assert.deepEqual(read.lines, [
      "Current quarter ending 2026-10-31: EPS estimate 1.25 (40 analysts); revenue estimate 54,800,000,000.",
      "Reported quarter 2026-07-31: EPS actual 1.05, estimate 1.01.",
    ]);
    assert.equal(parseConsensus({}, "x"), null);
  });

  it("reads the first transaction of a Form 4", () => {
    const xml = `<ownershipDocument><reportingOwner><reportingOwnerId><rptOwnerName>Doe Jane</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>CFO</officerTitle></reportingOwnerRelationship></reportingOwner>
      <nonDerivativeTable><nonDerivativeTransaction><transactionDate><value>2026-11-17</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>1000</value></transactionShares><transactionPricePerShare><value>412.5</value></transactionPricePerShare>
      <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>`;
    assert.deepEqual(parseForm4(xml), {
      insiderName: "Doe Jane",
      role: "CFO",
      code: "P",
      shares: 1000,
      price: 412.5,
      value: 412500,
      direction: "acquired",
      date: "2026-11-17",
      plan10b51: false,
    });
    assert.equal(parseForm4("<html>not a form 4</html>"), null);
  });
});

describe("the engine's own strings", () => {
  // Prompts name the banned words in order to ban them; what they produce is
  // checked by the tests above instead. Tests and fakes are not reader copy.
  const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const files = [
    ...fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => path.join(dir, f)),
    ...fs.readdirSync(path.join(dir, "channels")).map((f) => path.join(dir, "channels", f)),
  ].filter((f) => !/\.test\.ts$|test-fakes\.ts$|prompts\.ts$|copy\.ts$/.test(f));

  for (const file of files) {
    it(`${path.basename(file)} keeps the house copy rules`, () => {
      const problems = copyProblems(fs.readFileSync(file, "utf8"), { riskWords: true }).filter(
        // Regex sources and enum values are code, not copy.
        (p) => !/: (release|call|intraday|1d|5d|daily|weekdays|weekly|above|below|inline|unclear)$/.test(p),
      );
      assert.deepEqual(problems, []);
    });
  }
});
