import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  changeWindow,
  insiderItems,
  linkItems,
  priceEstimateItem,
  readYahooChanges,
  recordEstimate,
  revisionItems,
  shortInterestItem,
  sortItems,
  type GraphEdgeForChanges,
} from "./changes";
import { form4Totals } from "./form4";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-15T16:00:00Z");

const n = (raw: number) => ({ raw, fmt: String(raw) });

/** The shape Yahoo sends (NVDA, 2026-10-15), trimmed. */
const MODULES = {
  earningsTrend: {
    trend: [
      {
        period: "0q",
        endDate: "2026-10-31",
        epsTrend: { current: n(2.47325), "7daysAgo": n(2.47325), "30daysAgo": n(2.47269), epsTrendCurrency: "USD" },
        epsRevisions: { upLast7days: n(0), upLast30days: n(0), downLast30days: n(1), downLast7Days: n(1) },
      },
      {
        period: "+1y",
        endDate: "2028-01-31",
        epsTrend: { current: n(15.9146), "7daysAgo": n(15.79923), "30daysAgo": n(15.56753), epsTrendCurrency: "USD" },
        epsRevisions: { upLast7days: n(3), upLast30days: n(7), downLast30days: n(0), downLast7Days: n(0) },
      },
      {
        period: "+1q",
        endDate: "2027-01-31",
        epsTrend: { current: n(2.7), "7daysAgo": n(2.7), "30daysAgo": n(2.7) },
        epsRevisions: { upLast7days: n(0), upLast30days: n(0), downLast30days: n(0), downLast7Days: n(0) },
      },
      { period: "-1q", endDate: "2026-07-31" },
    ],
  },
  defaultKeyStatistics: {
    sharesShort: n(311389688),
    sharesShortPriorMonth: n(298301619),
    shortPercentOfFloat: n(0.0134),
    dateShortInterest: { raw: 1790726400, fmt: "2026-09-30" },
    sharesShortPreviousMonthDate: { raw: 1788134400, fmt: "2026-08-31" },
  },
  financialData: { targetMeanPrice: n(328.72), numberOfAnalystOpinions: n(59), financialCurrency: "USD" },
};

describe("changeWindow", () => {
  it("is seven days without a visit, or with a recent one", () => {
    const none = changeWindow(null, NOW);
    assert.equal(none.since, "2026-10-08");
    assert.equal(none.sinceVisit, false);
    assert.equal(changeWindow(NOW - 2 * DAY, NOW).since, "2026-10-08");
  });
  it("reaches back to an older visit, at most ninety days", () => {
    const w = changeWindow(NOW - 20 * DAY, NOW);
    assert.equal(w.since, "2026-09-25");
    assert.equal(w.sinceVisit, true);
    assert.equal(w.days, 20);
    assert.equal(changeWindow(NOW - 400 * DAY, NOW).days, 90);
  });
});

describe("readYahooChanges and revisionItems", () => {
  const read = readYahooChanges(MODULES);

  it("keeps the four forward periods, the short interest pair and the mean price estimate", () => {
    assert.deepEqual(read.trend.map((t) => t.period), ["0q", "+1y", "+1q"]);
    assert.equal(read.trend[0]!.down7, 1, "the provider's capital D is read");
    assert.equal(read.short?.date, "2026-09-30");
    assert.equal(read.short?.previousDate, "2026-08-31");
    assert.deepEqual(read.priceEstimate, { value: 328.72, analysts: 59, currency: "USD" });
  });

  it("uses the seven-day figures for a week and the thirty-day ones for longer, skipping periods with no change", () => {
    const week = revisionItems(read.trend, 7, "2026-10-15");
    assert.deepEqual(week.map((i) => [i.period, i.days, i.up, i.down]), [
      ["0q", 7, 0, 1],
      ["+1y", 7, 3, 0],
    ]);
    assert.equal(week[1]!.epsBefore, 15.79923);
    const month = revisionItems(read.trend, 20, "2026-10-15");
    assert.deepEqual(month.map((i) => [i.period, i.days, i.up, i.down]), [
      ["0q", 30, 0, 1],
      ["+1y", 30, 7, 0],
    ]);
    assert.match(month[1]!.fact, /7 analysts revised up and 0 revised down in the last 30 days/);
    assert.equal(month[0]!.date, "2026-10-15");
  });

  it("reads nothing from a missing reply", () => {
    assert.deepEqual(readYahooChanges(null), { trend: [], short: null, priceEstimate: null });
  });
});

describe("shortInterestItem", () => {
  const read = readYahooChanges(MODULES).short;
  it("lists a report settled shortly before the window opened", () => {
    const item = shortInterestItem(read, "2026-10-08")!;
    assert.equal(item.date, "2026-09-30");
    assert.equal(item.shares, 311389688);
    assert.equal(item.previousShares, 298301619);
    assert.match(item.fact, /a change of 4\.4%/);
  });
  it("leaves out an older report", () => {
    assert.equal(shortInterestItem(read, "2026-10-20"), null);
    assert.equal(shortInterestItem(null, "2026-10-08"), null);
  });
});

describe("price estimate history", () => {
  it("keeps one reading a day and drops readings past the history", () => {
    let h = recordEstimate([], "2026-06-01", { value: 100, analysts: 10, currency: "USD" });
    h = recordEstimate(h, "2026-09-15", { value: 300, analysts: 50, currency: "USD" });
    h = recordEstimate(h, "2026-10-15", { value: 320, analysts: 55, currency: "USD" });
    h = recordEstimate(h, "2026-10-15", { value: 328.72, analysts: 59, currency: "USD" });
    assert.deepEqual(h.map((p) => p.d), ["2026-09-15", "2026-10-15"]);
    assert.equal(h[1]!.v, 328.72);
  });

  it("compares with the reading closest to thirty days back", () => {
    const h = [
      { d: "2026-08-20", v: 280, n: 50 },
      { d: "2026-09-14", v: 300, n: 55 },
      { d: "2026-09-16", v: 305, n: 55 },
      { d: "2026-10-15", v: 328.72, n: 59 },
    ];
    const item = priceEstimateItem(h, "2026-10-15", "USD")!;
    assert.equal(item.previousDate, "2026-09-14");
    assert.equal(item.previous, 300);
    assert.equal(item.value, 328.72);
    assert.equal(item.analysts, 59);
  });

  it("says nothing without a reading 26 to 45 days back, or without today's", () => {
    assert.equal(priceEstimateItem([{ d: "2026-10-01", v: 300, n: 1 }, { d: "2026-10-15", v: 310, n: 1 }], "2026-10-15", null), null);
    assert.equal(priceEstimateItem([{ d: "2026-09-15", v: 300, n: 1 }], "2026-10-15", null), null);
  });
});

const FORM4 = (lines: string, extra = "") => `<?xml version="1.0"?>
<ownershipDocument>
  <reportingOwner><reportingOwnerId><rptOwnerName>Huang Jen Hsun</rptOwnerName></reportingOwnerId>
  <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>President and CEO</officerTitle></reportingOwnerRelationship></reportingOwner>
  ${extra}
  <nonDerivativeTable>${lines}</nonDerivativeTable>
</ownershipDocument>`;

const line = (code: string, shares: number, price: number | null, date: string) => `<nonDerivativeTransaction>
  <transactionDate><value>${date}</value></transactionDate>
  <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>${code}</transactionCode></transactionCoding>
  <transactionAmounts><transactionShares><value>${shares}</value></transactionShares>
  <transactionPricePerShare>${price === null ? "" : `<value>${price}</value>`}</transactionPricePerShare>
  <transactionAcquiredDisposedCode><value>${code === "P" ? "A" : "D"}</value></transactionAcquiredDisposedCode></transactionAmounts>
</nonDerivativeTransaction>`;

describe("form4Totals", () => {
  it("totals every sale line and keeps the plan box", () => {
    const xml = FORM4(
      line("S", 1000, 180.5, "2026-10-09") + line("S", 500, 181, "2026-10-10") + line("M", 9000, 10, "2026-10-09") + line("F", 300, 180, "2026-10-09"),
      "<aff10b5One>1</aff10b5One>",
    );
    const t = form4Totals(xml)!;
    assert.equal(t.code, "S");
    assert.equal(t.shares, 1500);
    assert.equal(t.value, Math.round(1000 * 180.5 + 500 * 181));
    assert.equal(t.date, "2026-10-10");
    assert.equal(t.plan, true);
    assert.equal(t.role, "President and CEO");
  });
  it("is null for a form with only grants, exercises and tax lines", () => {
    assert.equal(form4Totals(FORM4(line("A", 100, 0, "2026-10-09") + line("F", 30, 180, "2026-10-09"))), null);
    assert.equal(form4Totals("<html>not a form</html>"), null);
  });
  it("leaves the value unknown when a counted line has no price", () => {
    const t = form4Totals(FORM4(line("P", 200, null, "2026-10-09")))!;
    assert.equal(t.code, "P");
    assert.equal(t.value, null);
    assert.equal(t.plan, false);
  });
});

describe("insiderItems", () => {
  const totals = (code: "P" | "S", value: number, date: string, plan = false) => ({ name: "A", role: "director", code, shares: 10, value, date, plan });
  it("lists forms filed in the window, newest first, and marks plan trades", () => {
    const items = insiderItems(
      [
        { accession: "a1", filedAt: "2026-10-01", url: "u1", totals: totals("S", 5e6, "2026-09-30") },
        { accession: "a2", filedAt: "2026-10-10", url: "u2", totals: totals("S", 2e6, "2026-10-08", true) },
        { accession: "a3", filedAt: "2026-10-12", url: "u3", totals: totals("P", 1e5, "2026-10-11") },
      ],
      "2026-10-08",
    );
    assert.deepEqual(items.map((i) => i.id), ["ins:a3", "ins:a2"]);
    assert.equal(items[1]!.plan, true);
    assert.match(items[1]!.fact, /Rule 10b5-1/);
    assert.equal(items[0]!.source.url, "u3");
  });
});

describe("linkItems", () => {
  const edge = (id: string, root: string, other: string, category = "supplier", tier = "critical"): GraphEdgeForChanges => ({
    id,
    root_ticker: root,
    counterparty_ticker: other,
    counterparty_name: `${other} Inc.`,
    category,
    strength_tier: tier,
    confidence: 0.9,
    evidence_quote: "quote",
    source_url: "https://www.sec.gov/Archives/x.htm",
    accession_number: "0001",
    filing_date: "2026-02-20",
  });
  const edges = [edge("e1", "NVDA", "TSM"), edge("e2", "AMD", "NVDA", "competitor", "marginal"), edge("e3", "NVDA", "MU"), { ...edge("e4", "NVDA", "AVGO"), source_url: "https://example.com" }];

  it("on a first visit, lists links whose extraction ran inside the window", () => {
    const items = linkItems(edges, "NVDA", {
      since: "2026-10-08",
      today: "2026-10-15",
      previous: null,
      graphDate: "2026-08-26",
      builtOn: (filer) => (filer === "AMD" ? "2026-10-10" : "2026-08-22"),
    });
    assert.deepEqual(items.map((i) => [i.counterparty, i.direction, i.date]), [["AMD", "named", "2026-10-10"]]);
    assert.equal(items[0]!.counterpartyName, null);
  });

  it("after a visit, lists the links that were not there, filing-backed only", () => {
    const items = linkItems(edges, "NVDA", {
      since: "2026-09-01",
      today: "2026-10-15",
      previous: new Set(["e1"]),
      graphDate: "2026-09-20",
      builtOn: () => null,
    });
    assert.deepEqual(items.map((i) => i.counterparty), ["MU", "AMD"]);
    assert.equal(items[0]!.date, "2026-09-20");
    assert.equal(items[0]!.counterpartyName, "MU Inc.");
  });
});

describe("sortItems", () => {
  it("puts the newest first", () => {
    const read = readYahooChanges(MODULES);
    const items = sortItems([...revisionItems(read.trend, 7, "2026-10-15"), shortInterestItem(read.short, "2026-10-08")!]);
    assert.equal(items[items.length - 1]!.kind, "short_interest");
  });
});
