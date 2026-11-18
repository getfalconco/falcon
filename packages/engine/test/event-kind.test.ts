import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyCompany, item202Section, needsText, readKindText, reportingWindow, type KindInput, type PeriodicReport } from "../src/study/event-kind.ts";

const BOILER =
  "This information is intended to be furnished under Item 2.02 of Form 8-K and shall not be deemed filed for purposes of Section 18 of the Securities Exchange Act of 1934.";

describe("item202Section", () => {
  it("starts at the Item 2.02 heading and stops at the signatures", () => {
    const text = `UNITED STATES SECURITIES AND EXCHANGE COMMISSION FORM 8-K Check the appropriate box ... Item 2.02 Results of Operations and Financial Condition. On October 21, 2026, Tesla, Inc. released its financial results for the quarter ended September 30, 2026. ${BOILER} Item 9.01 Financial Statements and Exhibits. 99.1 Update. SIGNATURES Pursuant to the requirements ...`;
    const s = item202Section(text);
    assert.match(s, /^Item 2\.02 Results/);
    assert.match(s, /Item 9\.01/);
    assert.doesNotMatch(s, /SIGNATURES|UNITED STATES/);
  });
});

describe("readKindText", () => {
  const kind = (t: string) => readKindText(t)?.kind ?? null;

  it("Tesla: production and deliveries is an operational update, the quarterly update is earnings", () => {
    assert.equal(kind("EX-99.1 Tesla Q3 2026 Vehicle Production, Deliveries & Deployments AUSTIN, Texas, October 2, 2026 - In the third quarter, we produced over 447,000 vehicles and delivered over 497,000"), "operational_update");
    assert.equal(kind("Tesla Fourth Quarter 2023 Production and Deliveries"), "operational_update");
    assert.equal(kind("TESLA DELIVERS 17,400 VEHICLES IN Q4 2015. Our vehicle deliveries should not be relied on as an indicator of our quarterly financial results."), "operational_update");
    assert.equal(kind("Tesla's quarterly results are preliminary and remain subject to the completion of Tesla's customary quarterly close."), "preliminary");
    // Deliveries releases name the coming results date: not results themselves.
    assert.equal(kind("Tesla Q3 2026 Vehicle Production & Deliveries. In the third quarter, we delivered over 497,000 vehicles. Tesla will post its financial results for the third quarter of 2026 after market close on Wednesday, October 22, 2026."), "operational_update");
    assert.equal(kind("Tesla Vehicle Production & Deliveries and Date for Financial Results & Webcast for First Quarter 2022 In the first quarter, we produced over 305,000 vehicles. Our net income and cash flow results will be announced along with the rest of our financial performance when we announce Q1 earnings."), "operational_update");
    assert.equal(kind("Tesla Third Quarter 2025 Production, Deliveries & Deployments. What : Tesla Q3 2025 Financial Results and Q&A Webcast When : Wednesday, October 22, 2025"), "operational_update");
    // A retailer's quarterly release quotes its monthly sales: still earnings.
    assert.equal(kind("Costco Wholesale Corporation Reports Fourth Quarter and Fiscal Year 2024 Operating Results. Net sales for the retail month of August, the five weeks ended September 1, increased 7.1 percent."), "earnings");
    assert.equal(kind(`Item 2.02 Results of Operations and Financial Condition. On October 21, 2026, Tesla, Inc. released its financial results for the quarter ended September 30, 2026 by posting its Third Quarter 2026 Update on its website. ${BOILER}`), "earnings");
  });

  it("results releases", () => {
    assert.equal(kind("Sysco issued a press release announcing its results of operations and financial condition for its third quarter of fiscal year 2026"), "earnings");
    assert.equal(kind("Acme Reports Fourth Quarter and Full Year 2024 Results"), "earnings");
    assert.equal(kind("issued a news release reporting results for the three-month period ended May 31, 2024"), "earnings");
    assert.equal(kind("On May 1, the Company issued a press release announcing its results for the quarter ended March 31 and will host a conference call at 5 pm."), "earnings");
  });

  it("preliminary results and guidance updates", () => {
    assert.equal(kind("Advanced Micro Devices, Inc. announced preliminary financial results for its third quarter ended September 24, 2022"), "preliminary");
    assert.equal(kind("The Company expects to report revenue of approximately $1.2 billion for the fourth quarter"), "preliminary");
    assert.equal(kind("Intuit Inc. issued a press release updating its financial outlook for the fiscal quarter ended April 30, 2020."), "preliminary");
    assert.equal(kind("Lilly Announces 2023 Financial Guidance"), "preliminary");
    assert.equal(kind("Sezzle Inc. announced that it will release its third quarter 2026 results on Wednesday, November 4, 2026, and host a conference call at 5:00 p.m Eastern Time on the same day, to discuss the third quarter 2026 results."), "other");
    assert.equal(kind("Ingredion issued a press release announcing its expectation that its earnings per share for the second quarter will be below guidance."), "preliminary");
    assert.equal(kind("Vornado Realty Trust issued a press release announcing certain items to be included in its first quarter 2019 results."), "preliminary");
    assert.equal(kind("Occidental is providing the following summary of Fourth Quarter 2023 Earnings Considerations"), "preliminary");
    assert.equal(kind("On January 20, 2022, ICF International, Inc. announced it will release its fourth quarter and full year 2021 earnings results after the market closes on February 24, 2022."), "other");
  });

  it("monthly sales and traffic", () => {
    assert.equal(kind("Costco reported net sales of $20.1 billion for the retail month of October, the four weeks ended November 2"), "operational_update");
    assert.equal(kind("The Company reported comparable sales for the five-week period ended March 1"), "operational_update");
    assert.equal(kind("monthly sales results for October"), "operational_update");
    assert.equal(kind("Southwest Airlines reports October traffic results"), "operational_update");
  });

  it("boilerplate and conference calls do not decide", () => {
    assert.equal(kind("These non-GAAP measures do not include certain items that may have a material impact upon our reported financial results."), null);
    assert.equal(kind("The Company will host a conference call to discuss the transaction."), null);
    assert.equal(kind("Relevant slides from the presentation at the J.P. Morgan Healthcare Conference"), "other");
    assert.equal(kind(""), null);
  });
});

describe("reporting windows and classification", () => {
  // Tesla-like: a 10-K for 2025, a 10-Q for Q1 2026.
  const reports: PeriodicReport[] = [
    { form: "10-Q", filed: "2025-10-23", period: "2025-09-30" },
    { form: "10-K", filed: "2026-01-29", period: "2025-12-31" },
    { form: "10-Q", filed: "2026-04-23", period: "2026-03-31" },
    { form: "10-Q", filed: "2026-07-24", period: "2026-06-30" },
  ];

  it("a window runs from the quarter end to the report's filing (+3 days)", () => {
    assert.equal(reportingWindow("2026-01-02", reports)?.form, "10-K");
    assert.equal(reportingWindow("2026-01-28", reports)?.form, "10-K");
    assert.equal(reportingWindow("2026-02-05", reports)?.form, "10-K"); // within the grace days (release after the report)
    assert.equal(reportingWindow("2026-02-15", reports), null); // mid-quarter
    assert.equal(reportingWindow("2026-04-02", reports)?.filed, "2026-04-23");
  });

  const f = (accession: string, filed: string, text?: KindInput["text"], form = "8-K"): KindInput => ({ accession, form, filed, ...(text !== undefined ? { text } : {}) });

  it("needsText: amendments, shared windows and filings outside any window", () => {
    const fs = [f("q4-del", "2026-01-02"), f("q4-earn", "2026-01-28"), f("q1-earn", "2026-04-22"), f("mid", "2026-02-20"), f("amend", "2026-04-24", undefined, "8-K/A"), f("q2-earn", "2026-07-22")];
    assert.deepEqual([...needsText(fs, reports)].sort(), ["amend", "mid", "q4-del", "q4-earn"]);
  });

  it("Tesla: deliveries become operational updates, the results stay earnings", () => {
    const op = { kind: "operational_update" as const, cue: "production and deliveries" };
    const earn = { kind: "earnings" as const, cue: "results for the period ended" };
    const out = classifyCompany(
      [
        f("q4-del", "2026-01-02", op),
        f("q4-earn", "2026-01-28", earn),
        f("q1-del", "2026-04-02", op),
        f("q1-earn", "2026-04-22", null), // generic 8-K wording, exhibit says nothing telling
        f("q2-earn", "2026-07-22"),
        f("amend", "2026-07-23", null, "8-K/A"),
        f("mid", "2026-02-20", null),
      ],
      reports,
    );
    const k = (a: string) => out.get(a)!.kind;
    assert.deepEqual(
      ["q4-del", "q4-earn", "q1-del", "q1-earn", "q2-earn", "amend", "mid"].map(k),
      ["operational_update", "earnings", "operational_update", "earnings", "earnings", "other", "other"],
    );
    assert.match(out.get("q4-del")!.reason, /text: production and deliveries; one of 2 Item 2\.02 8-Ks before the 10-K filed 2026-01-29/);
    assert.match(out.get("q1-earn")!.reason, /filing closest to the report/);
    assert.match(out.get("q2-earn")!.reason, /only Item 2\.02 8-K between the 2026-06-30 quarter end and its 10-Q filed 2026-07-24 \(2 days before/);
    assert.match(out.get("amend")!.reason, /amendment \(8-K\/A\) of the Item 2\.02 8-K filed 2026-07-22/);
  });

  it("a pre-announcement before the release is preliminary; a lone 'preliminary' release is the earnings release", () => {
    const pre = { kind: "preliminary" as const, cue: "preliminary results" };
    const earn = { kind: "earnings" as const, cue: "quarter results" };
    const a = classifyCompany([f("pre", "2026-01-10", pre), f("rel", "2026-01-27", earn)], reports);
    assert.deepEqual([a.get("pre")!.kind, a.get("rel")!.kind], ["preliminary", "earnings"]);
    // Two filings, both worded preliminary (a utility's "preliminary unaudited earnings"): the last is the release.
    const b = classifyCompany([f("pre", "2026-01-10", pre), f("rel", "2026-01-27", pre)], reports);
    assert.deepEqual([b.get("pre")!.kind, b.get("rel")!.kind], ["preliminary", "earnings"]);
    const c = classifyCompany([f("only", "2026-01-27", pre)], reports);
    assert.equal(c.get("only")!.kind, "earnings");
    assert.match(c.get("only")!.reason, /text says preliminary results/);
  });

  it("a release's slides or supplement filed days apart are companions, not a second earnings event", () => {
    const earn = { kind: "earnings" as const, cue: "results for the period ended" };
    const out = classifyCompany([f("pr", "2026-04-21", earn), f("slides", "2026-04-22", earn), f("late", "2026-04-23", null)], reports);
    assert.deepEqual(["pr", "slides", "late"].map((a) => out.get(a)!.kind), ["earnings", "other", "other"]);
    assert.match(out.get("slides")!.reason, /companion of the earnings release filed 2026-04-21/);
  });

  it("two separate results-worded filings in a window: the release is the one at the company's usual lag", () => {
    const earn = { kind: "earnings" as const, cue: "quarter results" };
    // No usual lag known: the first is the release, a later one re-files or finalizes it.
    const out = classifyCompany([f("rel", "2026-01-12", earn), f("final", "2026-01-28", earn)], reports);
    assert.deepEqual([out.get("rel")!.kind, out.get("final")!.kind], ["earnings", "other"]);
    assert.match(out.get("final")!.reason, /the window's release is the one filed 2026-01-12 \(the first\)/);
    // Usual lag ~22 days (three windows with one release each): a pre-announcement 8 days after the quarter end is not the release.
    const more: PeriodicReport[] = [...reports, { form: "10-Q", filed: "2026-10-28", period: "2026-09-30" }, { form: "10-Q", filed: "2025-07-30", period: "2025-06-30" }];
    const lag = classifyCompany(
      [f("q3-25", "2025-10-22"), f("q2-25", "2025-07-23"), f("q2-26", "2026-07-22"), f("pre", "2026-10-08", earn), f("rel26", "2026-10-22", earn)],
      more,
    );
    assert.deepEqual([lag.get("pre")!.kind, lag.get("rel26")!.kind], ["preliminary", "earnings"]);
    assert.match(lag.get("pre")!.reason, /usual 22 days after the quarter end/);
  });
});
