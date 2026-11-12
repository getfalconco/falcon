import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { epsSentence, readMonthlyRevenue, readRelease } from "../src/events.ts";
import { parseEnv } from "../src/env.ts";
import { linksOf, relationFrom, walk, type Graph, type GraphEdge } from "../src/graph.ts";
import { filingsFromSubmissions, parseFilingIndex } from "../src/sec.ts";
import { htmlToText, quoteInDocument, sentences } from "../src/text.ts";
import { parseEarnings, quarterReportedOn, surprisePct } from "../src/yahoo.ts";

describe("text", () => {
  it("turns filing HTML into lines, dropping inline XBRL headers and entities", () => {
    const html = `<html><body><ix:header><ix:hidden>dei:Foo</ix:hidden></ix:header><p>Net sales of $1.622&#160;billion</p><table><tr><td>A</td><td>B</td></tr></table><p>Microchip&#8217;s results</p></body></html>`;
    const text = htmlToText(html);
    assert.ok(!text.includes("dei:Foo"));
    assert.ok(text.includes("Net sales of $1.622 billion"));
    assert.ok(text.includes("Microchip’s results"));
  });

  it("matches a quote across line breaks, curly quotes and table pipes", () => {
    const doc = "We compete mainly with Onto Innovation Inc., and KLA Corp., which manufacture and sell CD,\nthin films";
    assert.ok(quoteInDocument("We compete mainly with Onto Innovation Inc., and KLA Corp., which manufacture and sell CD, thin films", doc));
    assert.ok(!quoteInDocument("We compete mainly with Applied Materials", doc));
  });

  it("matches an elided quote only when the parts sit close together", () => {
    const doc = "the following customers each accounted for more than 10% of total revenues:\nYear Ended June 30, |\n2026 | 2025 |\nTaiwan Semiconductor Manufacturing Company Limited |";
    assert.ok(quoteInDocument("the following customers each accounted for more than 10% of total revenues: ... Taiwan Semiconductor Manufacturing Company Limited", doc));
    const far = `the following customers each accounted for more than 10% of total revenues: ${"x ".repeat(400)} Taiwan Semiconductor Manufacturing Company Limited`;
    assert.ok(!quoteInDocument("the following customers each accounted for more than 10% of total revenues: ... Taiwan Semiconductor Manufacturing Company Limited", far));
  });

  it("does not split sentences after Inc. or Co.", () => {
    assert.deepEqual(sentences("We use Amkor Technology, Inc. and ASE Co. for assembly. Next one."), [
      "We use Amkor Technology, Inc. and ASE Co. for assembly.",
      "Next one.",
    ]);
  });
});

describe("EDGAR", () => {
  it("reads a filing index's documents with their types", () => {
    const html = `<table class="tableFile" summary="Document Format Files"><tr><th>Seq</th></tr>
      <tr><td>1</td><td>8-K</td><td><a href="/ix?doc=/Archives/edgar/data/1/0001/a8k.htm">a8k.htm</a></td><td>8-K</td><td>1</td></tr>
      <tr><td>2</td><td>PRESS RELEASE</td><td><a href="/Archives/edgar/data/1/0001/ex991.htm">ex991.htm</a></td><td>EX-99.1</td><td>2</td></tr></table>`;
    const docs = parseFilingIndex(html);
    assert.equal(docs.length, 2);
    assert.equal(docs[0]!.url, "https://www.sec.gov/Archives/edgar/data/1/0001/a8k.htm");
    assert.equal(docs[1]!.type, "EX-99.1");
  });

  it("reads acceptance stamps with the file's clock (shifted older entries, true current day)", () => {
    // A file rebuilt since 2026-10-03: older entries carry New York's offset twice.
    const sub = {
      cik: "827054",
      name: "MICROCHIP TECHNOLOGY INC",
      filings: {
        recent: {
          accessionNumber: ["a-3", "a-2", "a-1", "a-0"],
          filingDate: ["2026-11-12", "2026-11-05", "2026-10-20", "2026-10-08"],
          // 11-12 entry: true UTC (16:05 ET). Older: shifted (+5h / +4h on top of UTC).
          acceptanceDateTime: ["2026-11-12T21:05:00.000Z", "2026-11-06T02:18:06.000Z", "2026-10-21T00:10:00.000Z", "2026-10-08T20:30:00.000Z"],
          form: ["8-K", "8-K", "8-K", "8-K"],
          items: ["8.01", "2.02,9.01", "8.01", "8.01"],
          primaryDocument: ["d3.htm", "d2.htm", "d1.htm", "d0.htm"],
        },
      },
    };
    const fetchedAtMs = Date.parse("2026-11-12T22:00:00Z");
    const f = filingsFromSubmissions(sub, fetchedAtMs);
    assert.equal(f[0]!.acceptedAt, "2026-11-12T21:05:00.000Z");
    // 2026-11-05 16:18 ET is 21:18 UTC; the file wrote it shifted by 5 hours.
    assert.equal(f[1]!.acceptedAt, "2026-11-05T21:18:06.000Z");
    assert.deepEqual(f[1]!.items, ["2.02", "9.01"]);
    assert.equal(f[1]!.url, "https://www.sec.gov/Archives/edgar/data/827054/a2/d2.htm");
  });
});

describe("earnings releases", () => {
  const release = [
    "EXHIBIT 99.1",
    "MICROCHIP TECHNOLOGY ANNOUNCES FINANCIAL RESULTS FOR",
    "SECOND QUARTER OF FISCAL YEAR 2027",
    "•",
    "Net sales of $1.622 billion, increased 42.2% from the year-ago quarter and up 9.2% sequentially. The midpoint of our guidance provided on August 6, 2026 was net sales of $1.604 billion.",
    "EBITDA was $89.7 million, or 16.8% of revenue, compared to $46.6 million in the same quarter a year ago.",
    '"Our September quarter net sales were above the high end of our guidance, increasing 42.2% year over year," said the CEO.',
    "We expect net sales for the December quarter to be between down 3% and up 1% sequentially, with a midpoint of down 1%.",
    "This release contains forward-looking statements about net sales we expect in the December quarter of $1.6 billion.",
  ].join("\n");

  it("picks the revenue headline, not a margin of revenue", () => {
    const r = readRelease(release);
    assert.match(r.revenue ?? "", /^Net sales of \$1\.622 billion, increased 42\.2%/);
    assert.equal(r.title, "Microchip Technology Announces Financial Results For Second Quarter Of Fiscal Year 2027");
  });

  it("picks the forward outlook, not a line about beating past guidance or boilerplate", () => {
    const r = readRelease(release);
    assert.equal(r.outlook, "We expect net sales for the December quarter to be between down 3% and up 1% sequentially, with a midpoint of down 1%.");
    assert.equal(r.pendingAcquisition, null);
  });

  it("flags suspended guidance and a pending acquisition", () => {
    const r = readRelease(
      "Silicon Labs Reports Third Quarter 2026 Results\nRevenue was $251 million, up 22% year-over-year\nDue to the announced pending acquisition of Silicon Labs by Texas Instruments, Silicon Labs has suspended providing forward-looking guidance.",
    );
    assert.ok(r.guidanceSuspended);
    assert.ok(r.pendingAcquisition);
  });

  it("writes the EPS line from Yahoo's figures", () => {
    const s = epsSentence("Onto Innovation", {
      fiscalQuarter: "3Q2026",
      periodEnd: "2026-09-30",
      reportedDate: "2026-11-09",
      epsActual: 2.44,
      epsEstimate: 2.30202,
      surprisePct: 6,
    });
    assert.equal(s, "Onto Innovation reported EPS of $2.44 for the quarter ended September 30, 2026, 6.0% above the $2.30 consensus estimate.");
  });
});

describe("monthly revenue reports", () => {
  it("reads TSMC's sentence", () => {
    const m = readMonthlyRevenue(
      "TSMC (TWSE: 2330, NYSE: TSM) today announced its net revenue for October 2026: On a consolidated basis, revenue for October 2026 was approximately NT$586.89 billion, an increase of 14.7 percent from September 2026 and an increase of 59.7 percent from October 2025. Revenue for January",
    );
    assert.equal(m?.month, "October 2026");
    assert.equal(m?.yoyPct, 59.7);
    assert.equal(m?.momPct, 14.7);
  });

  it("reads ASE's table", () => {
    const m = readMonthlyRevenue(
      "announces its unaudited consolidated net revenues for October 2026.\nConsolidated net revenues (unaudited)\nOct |\nSept |\n(NT$ Million) |\nNet Revenues |\n88,615 |\n88,130 |\n60,231 |\n+0.6% |\n+47.1% |",
    );
    assert.equal(m?.yoyPct, 47.1);
    assert.equal(m?.momPct, 0.6);
    assert.match(m?.sentence ?? "", /NT\$88,615 million/);
  });

  it("returns null for a 6-K that is not a revenue report", () => {
    assert.equal(readMonthlyRevenue("UMC will attend investor conferences on 2026/11/16"), null);
  });
});

describe("Yahoo earnings", () => {
  const json = {
    quoteSummary: {
      result: [
        {
          earnings: {
            earningsChart: {
              quarterly: [
                { fiscalQuarter: "2Q2026", actual: { raw: 1.66 }, estimate: { raw: 1.60841 }, periodEndDate: { fmt: "2026-06-30" }, reportedDate: { fmt: "2026-08-04" } },
                { fiscalQuarter: "3Q2026", actual: { raw: 2.09 }, estimate: { raw: 1.94529 }, periodEndDate: { fmt: "2026-09-30" }, reportedDate: { fmt: "2026-11-03" } },
              ],
            },
          },
        },
      ],
    },
  };

  it("parses quarters and computes the surprise from actual and estimate", () => {
    const q = parseEarnings(json);
    assert.equal(q.length, 2);
    assert.equal(q[1]!.surprisePct, 7.4);
    assert.equal(surprisePct(-2.03, -1.985), -2.3);
    assert.equal(surprisePct(1, 0), null);
  });

  it("finds the quarter reported on a filing date, a day either side allowed", () => {
    const q = parseEarnings(json);
    assert.equal(quarterReportedOn(q, "2026-11-04")?.fiscalQuarter, "3Q2026");
    assert.equal(quarterReportedOn(q, "2026-11-10"), null);
  });

  it("returns nothing for an error answer", () => {
    assert.deepEqual(parseEarnings({ quoteSummary: { result: null, error: { code: "Not Found" } } }), []);
  });
});

describe("graph", () => {
  const edge = (from: string, to: string, category: GraphEdge["category"], tier: GraphEdge["tier"] = "important"): GraphEdge => ({
    id: `${from}:${category}:${to}`,
    from,
    to,
    toName: to,
    category,
    tier,
    disclosedSharePct: null,
    quote: `${from} names ${to} as ${category} in its annual report.`,
    form: "10-K",
    filedAt: "2026-02-01",
    url: "https://www.sec.gov/Archives/x.htm",
    origin: "test",
  });
  const graph: Graph = {
    generatedAt: "2026-11-12T00:00:00Z",
    names: {},
    edges: [
      edge("NVDA", "TSM", "supplier", "critical"),
      edge("KLAC", "TSM", "customer", "critical"),
      edge("NVDA", "AMD", "competitor", "marginal"),
      edge("ANET", "NVDA", "competitor", "marginal"),
      edge("AMD", "TSM", "supplier", "critical"),
      edge("HPE", "AMD", "supplier", "critical"),
    ],
  };

  it("reads an edge from either side", () => {
    // NVIDIA's 10-K names TSMC a supplier: TSMC is NVIDIA's supplier, NVIDIA is TSMC's customer.
    assert.equal(relationFrom({ from: "NVDA", category: "supplier" }, "NVDA"), "supplier");
    assert.equal(relationFrom({ from: "NVDA", category: "supplier" }, "TSM"), "customer");
    assert.equal(relationFrom({ from: "KLAC", category: "customer" }, "TSM"), "supplier");
    assert.equal(relationFrom({ from: "INTC", category: "partner" }, "NVDA"), "peer");
  });

  it("lists TSMC's direct links", () => {
    const l = linksOf(graph, "TSM").map((x) => `${x.other}:${x.relation}`).sort();
    assert.deepEqual(l, ["AMD:customer", "KLAC:supplier", "NVDA:customer"]);
  });

  it("walks two links only through supply-chain companies, never back or twice", () => {
    const paths = walk(graph, "TSM", 2);
    const d2 = paths.filter((p) => p.degree === 2).map((p) => `${p.ticker} via ${p.via}`).sort();
    // HPE buys AMD processors (AMD is a TSMC customer); ANET is NVIDIA's competitor.
    assert.deepEqual(d2, ["ANET via NVDA", "HPE via AMD"]);
    // AMD is already direct, so NVDA -> AMD does not add it again at degree 2.
    assert.equal(paths.filter((p) => p.ticker === "AMD").length, 1);
    assert.ok(paths.every((p) => p.ticker !== "TSM"));
    assert.equal(paths.find((p) => p.ticker === "HPE")?.edges.length, 2);
  });
});

describe("env", () => {
  it("parses KEY=value lines with quotes and comments", () => {
    const e = parseEnv('A=1\nexport B="two words"\nC=three # note\n# D=4\nE=\'x y\'');
    assert.deepEqual(e, { A: "1", B: "two words", C: "three", E: "x y" });
  });
});
