import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  daysBetween,
  rankRelations,
  sectorsFromCalendar,
  selectFirstReading,
  untrackedTickers,
  upcomingEarnings,
  type ReadingEdge,
} from "./first-reading";

function edge(root: string, cp: string | null, category: string, extra: Partial<ReadingEdge> = {}): ReadingEdge {
  return {
    root_ticker: root,
    counterparty_ticker: cp,
    counterparty_name: cp ? `${cp} Inc` : "Private Co",
    category,
    confidence: 0.95,
    strength: 0.3,
    strength_tier: "marginal",
    filing_date: "2026-02-25",
    form: "10-K",
    ...extra,
  };
}

const EDGES: ReadingEdge[] = [
  edge("NVDA", "AMD", "competitor"),
  edge("NVDA", "TSM", "supplier", { strength: 0.6, strength_tier: "important" }),
  edge("NVDA", "MU", "supplier"),
  edge("NVDA", null, "partner"),
  edge("AAPL", "TSM", "supplier", { strength: 0.9, strength_tier: "critical" }),
  edge("TSM", "NVDA", "customer", { form: "20-F", filing_date: "2026-04-10" }),
];

describe("daysBetween", () => {
  it("counts whole calendar days and refuses anything that is not a date", () => {
    assert.equal(daysBetween("2026-10-10", "2026-10-22"), 12);
    assert.equal(daysBetween("2026-10-10", "2026-10-10"), 0);
    assert.equal(daysBetween("2026-10-10", "2026-10-09"), -1);
    assert.equal(daysBetween("2026-10-10", "soon"), null);
  });
});

describe("rankRelations", () => {
  it("only reads edges that touch the reader's names, strongest supply link first", () => {
    const facts = rankRelations(["NVDA"], EDGES);
    assert.deepEqual(facts[0], {
      kind: "relation",
      counterparty: "TSM",
      root: "NVDA",
      category: "supplier",
      form: "10-K",
      filingDate: "2026-02-25",
    });
    assert.ok(facts.every((f) => f.root === "NVDA" || f.counterparty === "NVDA"));
    assert.ok(!facts.some((f) => f.root === "AAPL"));
  });

  it("keeps one fact per pair of companies, whichever filing names it", () => {
    const pairs = rankRelations(["NVDA"], EDGES).map((f) => [f.root, f.counterparty].sort().join("|"));
    assert.equal(new Set(pairs).size, pairs.length);
  });

  it("ranks a ticker above a named private company, and supply above a rival", () => {
    const order = rankRelations(["NVDA"], EDGES).map((f) => f.counterparty);
    assert.ok(order.indexOf("MU") < order.indexOf("AMD"));
    assert.equal(order.at(-1), "Private Co");
  });

  it("puts first an edge between two of the reader's own names", () => {
    const first = rankRelations(["AAPL", "NVDA", "TSM"], EDGES)[0]!;
    assert.deepEqual([first.root, first.counterparty], ["AAPL", "TSM"]);
  });

  it("leaves the form out when the graph did not record it, and skips unknown categories", () => {
    const facts = rankRelations(["X"], [edge("X", "Y", "supplier", { form: undefined }), edge("X", "Z", "rumour")]);
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.form, null);
  });
});

describe("upcomingEarnings", () => {
  const rows = [
    { ticker: "NVDA", date: "2026-10-22", estimated: false },
    { ticker: "NVDA", date: "2027-01-20", estimated: true },
    { ticker: "AAPL", date: "2026-10-30", estimated: true },
    { ticker: "MSFT", date: "2026-10-12", estimated: false },
    { ticker: "AMD", date: "2026-10-01", estimated: false },
  ];

  it("takes each held name's next date within the horizon, soonest first", () => {
    assert.deepEqual(upcomingEarnings(["NVDA", "AAPL", "AMD"], rows, "2026-10-10"), [
      { kind: "earnings", ticker: "NVDA", date: "2026-10-22", days: 12, estimated: false },
      { kind: "earnings", ticker: "AAPL", date: "2026-10-30", days: 20, estimated: true },
    ]);
  });

  it("ignores names the reader does not have and dates already past", () => {
    assert.deepEqual(upcomingEarnings(["AMD"], rows, "2026-10-10"), []);
  });
});

describe("selectFirstReading", () => {
  const earnings = [{ ticker: "NVDA", date: "2026-10-22", estimated: false }];

  it("gives the strongest link and the nearest report, as in the spec's example", () => {
    const facts = selectFirstReading({ tickers: ["NVDA"], edges: EDGES, earnings, today: "2026-10-10" });
    assert.equal(facts.length, 2);
    const [link, report] = facts;
    assert.ok(link?.kind === "relation" && link.counterparty === "TSM" && link.root === "NVDA");
    assert.deepEqual(report, { kind: "earnings", ticker: "NVDA", date: "2026-10-22", days: 12, estimated: false });
  });

  it("fills with a second link when no report is near, preferring another of the reader's names", () => {
    const facts = selectFirstReading({ tickers: ["NVDA", "AAPL"], edges: EDGES, earnings: [], today: "2026-10-10" });
    assert.equal(facts.length, 2);
    const roots = facts.map((f) => (f.kind === "relation" ? f.root : ""));
    assert.deepEqual(new Set(roots), new Set(["AAPL", "NVDA"]));
  });

  it("says nothing it does not have: no names, or names with no data, give no facts", () => {
    assert.deepEqual(selectFirstReading({ tickers: [], edges: EDGES, earnings, today: "2026-10-10" }), []);
    assert.deepEqual(selectFirstReading({ tickers: ["ZZZZ"], edges: EDGES, earnings, today: "2026-10-10" }), []);
  });

  it("never gives more than two", () => {
    const facts = selectFirstReading({
      tickers: ["NVDA", "AAPL", "TSM"],
      edges: EDGES,
      earnings: [...earnings, { ticker: "AAPL", date: "2026-10-11", estimated: false }],
      today: "2026-10-10",
    });
    assert.equal(facts.length, 2);
  });
});

describe("untrackedTickers", () => {
  it("lists the reader's names the Tracker has no history for, once each", () => {
    assert.deepEqual(untrackedTickers(["NVDA", "pltr", "SOFI", "PLTR"], ["NVDA", "TSM"]), ["PLTR", "SOFI"]);
    assert.deepEqual(untrackedTickers(["NVDA"], new Set(["NVDA"])), []);
  });
});

describe("sectorsFromCalendar", () => {
  it("keeps the sectors the app's list shares, in its order, and nothing it cannot place", () => {
    assert.deepEqual(
      sectorsFromCalendar({ NVDA: "Technology", JPM: "Financials", KO: "Consumer Staples", AMT: "Real Estate", X: null }),
      ["technology", "financials", "consumer"],
    );
  });
});
