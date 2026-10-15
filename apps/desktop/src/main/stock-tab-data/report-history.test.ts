import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { YahooQuarter } from "../earnings/earnings-sources";
import { assembleReports, collectReports, leadReports, mergeQuarters, seasonWindow, type Bar, type ReleaseFiling } from "./report-history";
import { linksAround } from "./graph-links";
import { filingsFromSubmissions } from "../agents/edgar";

function q(periodEnd: string, reportedAt: string | null, actual: number | null, estimate: number | null, fiscal: string, revenue: number | null = null): YahooQuarter {
  return {
    periodEnd,
    fiscalQuarter: fiscal,
    reportedAt,
    reportedYmd: reportedAt ? reportedAt.slice(0, 10) : null,
    epsActual: actual,
    epsEstimate: estimate,
    revenueActual: revenue,
  };
}

/** Weekday closes from `from` to `to`, rising 0.1% a day, with set moves on given days. */
function bars(from: string, to: string, jumps: Record<string, number> = {}): Bar[] {
  const out: Bar[] = [];
  let c = 100;
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const ymd = d.toISOString().slice(0, 10);
    c *= 1 + (jumps[ymd] ?? 0.001);
    out.push({ d: ymd, c });
  }
  return out;
}

/** NVDA style: four quarters on Yahoo, released after the close (16:20 New York; Yahoo's `reportedDate` is the true instant). */
const YAHOO: YahooQuarter[] = [
  q("2025-10-31", "2025-11-19T21:20:00.000Z", 1.3, 1.25647, "3Q2026", 57e9),
  q("2026-01-31", "2026-02-25T21:31:25.000Z", 1.62, 1.53812, "4Q2026", 68e9),
  q("2026-04-30", "2026-05-20T20:20:00.000Z", 1.87, 1.77191, "1Q2027", 75e9),
  q("2026-07-31", "2026-08-26T20:20:00.000Z", 2.22, 2.09113, "2Q2027", 82e9),
];

/** The 8-K item 2.02 filings EDGAR lists for the same company, two years of them. */
const FILINGS: ReleaseFiling[] = [
  { acceptedAt: "2024-08-29T00:21:16.000Z", filedAt: "2024-08-28", url: "f-2024-08" },
  { acceptedAt: "2024-11-21T02:21:20.000Z", filedAt: "2024-11-20", url: "f-2024-11" },
  { acceptedAt: "2025-02-27T02:21:32.000Z", filedAt: "2025-02-26", url: "f-2025-02" },
  { acceptedAt: "2025-05-29T00:21:30.000Z", filedAt: "2025-05-28", url: "f-2025-05" },
  { acceptedAt: "2025-08-28T00:22:14.000Z", filedAt: "2025-08-27", url: "f-2025-08" },
  { acceptedAt: "2025-11-20T02:20:44.000Z", filedAt: "2025-11-19", url: "f-2025-11" },
  { acceptedAt: "2025-11-21T14:00:00.000Z", filedAt: "2025-11-21", url: "f-2025-11-amended" },
  { acceptedAt: "2026-02-26T02:31:25.000Z", filedAt: "2026-02-25", url: "f-2026-02" },
  { acceptedAt: "2026-05-21T00:21:19.000Z", filedAt: "2026-05-20", url: "f-2026-05" },
  { acceptedAt: "2026-08-27T00:21:19.000Z", filedAt: "2026-08-26", url: "f-2026-08" },
];

describe("mergeQuarters", () => {
  it("keeps quarters Yahoo has dropped and lays the fresh read over the rest", () => {
    const stored = [q("2025-07-31", "2025-08-27T20:20:00.000Z", 1.05, 1.01, "2Q2026"), ...YAHOO.slice(0, 3)];
    const fresh = [...YAHOO.slice(1)];
    const merged = mergeQuarters(stored, fresh);
    assert.deepEqual(merged.map((x) => x.periodEnd), ["2025-07-31", "2025-10-31", "2026-01-31", "2026-04-30", "2026-07-31"]);
  });
  it("does not let a half-updated read wipe an actual on record", () => {
    const merged = mergeQuarters([YAHOO[3]!], [{ ...YAHOO[3]!, epsActual: null }]);
    assert.equal(merged[0]!.epsActual, 2.22);
  });
});

describe("collectReports", () => {
  it("matches Yahoo's quarters to their filings and adds the older filings as date-only reports", () => {
    const reports = collectReports(YAHOO, FILINGS);
    assert.equal(reports.length, 9, "the amended November filing is the same report");
    const last = reports[reports.length - 1]!;
    assert.equal(last.date, "2026-08-26");
    assert.equal(last.url, "f-2026-08");
    assert.equal(last.hour, "amc");
    const oldest = reports[0]!;
    assert.equal(oldest.quarter, null);
    assert.equal(oldest.date, "2024-08-28");
    assert.equal(oldest.hour, "amc");
  });
});

describe("assembleReports", () => {
  const closes = bars("2024-06-01", "2026-10-15", { "2026-08-27": -0.03, "2026-05-21": 0.032, "2024-11-21": 0.005 });

  it("gives the last eight reports, newest first, with the next session's move after an evening release", () => {
    const rows = assembleReports(YAHOO, FILINGS, closes, "2026-10-15");
    assert.equal(rows.length, 8);
    assert.equal(rows[0]!.date, "2026-08-26");
    assert.equal(rows[0]!.reactionDay, "2026-08-27");
    assert.ok(Math.abs(rows[0]!.move! + 0.03) < 1e-6);
    assert.equal(rows[0]!.fiscalPeriod, "Q2 2027");
    assert.equal(rows[0]!.surprisePct, 6.16);
    assert.equal(rows[0]!.revenueActual, 82e9);
    assert.equal(rows[0]!.source.kind, "yahoo");
    assert.equal(rows[1]!.move !== null && Math.abs(rows[1]!.move - 0.032) < 1e-6, true);
    const filingOnly = rows.slice(4);
    assert.ok(filingOnly.every((r) => r.epsActual === null && r.source.kind === "filing" && r.move !== null));
    assert.equal(rows[7]!.date, "2024-11-20");
  });

  it("shows as many as are on record", () => {
    const rows = assembleReports(YAHOO.slice(2), [], closes, "2026-10-15");
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.time, "amc");
  });

  it("leaves the move out while the reaction session is still trading", () => {
    const rows = assembleReports(YAHOO, FILINGS, bars("2024-06-01", "2026-08-27"), "2026-08-27");
    assert.equal(rows[0]!.date, "2026-08-26");
    assert.equal(rows[0]!.move, null);
  });
});

describe("seasonWindow", () => {
  it("runs from the day after the last report to today, or to the next report when it is earlier", () => {
    assert.deepEqual(seasonWindow("2026-08-26", "2026-11-18", "2026-10-15"), { from: "2026-08-27", to: "2026-10-15" });
  });
  it("reaches back at most a hundred days", () => {
    assert.deepEqual(seasonWindow(null, null, "2026-10-15"), { from: "2026-07-07", to: "2026-10-15" });
    assert.deepEqual(seasonWindow("2025-01-01", null, "2026-10-15").from, "2026-07-07");
  });
});

describe("leadReports", () => {
  it("lists each linked company's latest report inside the season, with its move", () => {
    const leads = leadReports(
      [
        {
          ticker: "TSM",
          category: "supplier",
          direction: "names",
          filingUrl: "https://www.sec.gov/tsm",
          quarters: [q("2026-06-30", "2026-07-16T06:00:00.000Z", 2.47, 2.37, "2Q2026"), q("2026-09-30", "2026-10-16T06:00:00.000Z", null, 2.6, "3Q2026")],
          moves: [{ date: "2026-07-16", reactionDay: "2026-07-16", move: 0.012 }],
        },
        {
          ticker: "MU",
          category: "supplier",
          direction: "names",
          filingUrl: null,
          quarters: [q("2026-08-31", "2026-09-23T20:05:00.000Z", 3.1, 2.9, "4Q2026")],
          moves: [{ date: "2026-09-23", reactionDay: "2026-09-24", move: -0.021 }],
        },
        {
          ticker: "AMD",
          category: "competitor",
          direction: "named",
          filingUrl: null,
          quarters: [q("2026-06-30", "2026-08-05T20:10:00.000Z", 0.48, 0.48, "2Q2026")],
          moves: [],
        },
      ],
      { from: "2026-08-27", to: "2026-10-15" },
      "2026-10-15",
    );
    assert.deepEqual(leads.map((l) => l.ticker), ["MU"]);
    assert.equal(leads[0]!.date, "2026-09-23");
    assert.equal(leads[0]!.move, -0.021);
    assert.equal(leads[0]!.surprisePct, 6.9);
    assert.equal(leads[0]!.fiscalPeriod, "Q4 2026");
  });
});

describe("linksAround", () => {
  const base = { evidence_quote: "q", source_url: "https://www.sec.gov/a", accession_number: "1", confidence: 0.9 };
  it("keeps filing-backed links, one per company, strongest first", () => {
    const links = linksAround(
      [
        { ...base, root_ticker: "NVDA", counterparty_ticker: "AMD", category: "competitor", strength_tier: "marginal", counterparty_name: "AMD" },
        { ...base, root_ticker: "AMD", counterparty_ticker: "NVDA", category: "competitor", strength_tier: "important" },
        { ...base, root_ticker: "NVDA", counterparty_ticker: "TSM", category: "supplier", strength_tier: "critical" },
        { ...base, root_ticker: "NVDA", counterparty_ticker: "INTC", category: "competitor", strength_tier: "critical", confidence: 0.5 },
        { ...base, root_ticker: "NVDA", counterparty_ticker: "QCOM", category: "competitor", source_url: "https://example.com" },
      ],
      "NVDA",
    );
    assert.deepEqual(links.map((l) => [l.ticker, l.tier, l.direction]), [
      ["TSM", "critical", "names"],
      ["AMD", "important", "named"],
    ]);
    assert.equal(links[1]!.name, "AMD", "the name from the weaker link is kept");
  });
  it("filters to one category", () => {
    const links = linksAround(
      [
        { ...base, root_ticker: "NVDA", counterparty_ticker: "AMD", category: "competitor", strength_tier: "marginal" },
        { ...base, root_ticker: "NVDA", counterparty_ticker: "TSM", category: "supplier", strength_tier: "critical" },
      ],
      "NVDA",
      "competitor",
    );
    assert.deepEqual(links.map((l) => l.ticker), ["AMD"]);
  });
});

/**
 * EDGAR's submissions index stamps an older entry of a file SEC rebuilt since
 * 2026-10-03 with the true instant plus New York's offset, and an entry of the
 * current filing day (or of a file not rebuilt since) with the true UTC
 * instant (research/edgar-time.ts). Read as UTC, a 06:30 release showed "during" and
 * a 13:00 one "after the close", its move read a session late. Morning,
 * midday and evening releases in daylight time and in winter; the evening
 * one is dated the next business day and first traded that session.
 */
describe("EDGAR acceptance stamps", () => {
  const CASES = [
    { name: "summer 06:30", filedAt: "2026-07-14", old: "2026-07-14T14:30:38.000Z", current: "2026-07-14T10:30:38.000Z", date: "2026-07-14", time: "bmo", reaction: "2026-07-14" },
    { name: "summer 13:00", filedAt: "2026-07-14", old: "2026-07-14T21:00:00.000Z", current: "2026-07-14T17:00:00.000Z", date: "2026-07-14", time: "dmh", reaction: "2026-07-14" },
    { name: "summer 20:30", filedAt: "2026-07-15", old: "2026-07-15T04:30:00.000Z", current: "2026-07-15T00:30:00.000Z", date: "2026-07-14", time: "amc", reaction: "2026-07-15" },
    { name: "winter 06:30", filedAt: "2026-01-13", old: "2026-01-13T16:30:38.000Z", current: "2026-01-13T11:30:38.000Z", date: "2026-01-13", time: "bmo", reaction: "2026-01-13" },
    { name: "winter 13:00", filedAt: "2026-01-13", old: "2026-01-13T23:00:00.000Z", current: "2026-01-13T18:00:00.000Z", date: "2026-01-13", time: "dmh", reaction: "2026-01-13" },
    { name: "winter 20:30", filedAt: "2026-01-14", old: "2026-01-14T06:30:00.000Z", current: "2026-01-14T01:30:00.000Z", date: "2026-01-13", time: "amc", reaction: "2026-01-14" },
  ] as const;
  const toRelease = (stamp: string, filedAt: string, fetchedAtMs: number, rebuilt = false): ReleaseFiling => {
    // A Form 4 dated 2026-10-13 marks a file rebuilt since SEC's change.
    const index = rebuilt
      ? { form: ["4", "8-K"], filingDate: ["2026-10-13", filedAt], acceptanceDateTime: ["2026-10-14T01:09:29.000Z", stamp], items: ["", "2.02"], accessionNumber: ["a-0", "a-1"], primaryDocument: ["f4.xml", "d.htm"] }
      : { form: ["8-K"], filingDate: [filedAt], acceptanceDateTime: [stamp], items: ["2.02"], accessionNumber: ["a-1"], primaryDocument: ["d.htm"] };
    const f = filingsFromSubmissions("0001045810", index, fetchedAtMs).find((x) => x.form === "8-K");
    return { acceptedAt: f!.acceptedAt, acceptedAtUtc: f!.acceptedAtUtc, filedAt: f!.filedAt, url: f!.url };
  };
  const OCT15 = Date.parse("2026-10-15T21:15:00Z");
  const closes = [...bars("2026-01-05", "2026-01-20"), ...bars("2026-07-06", "2026-07-21")];

  for (const c of CASES) {
    it(`${c.name}: the report's date, time and reaction session`, () => {
      const trueMs = Date.parse(c.current);
      const reads: ReleaseFiling[] = [
        toRelease(c.old, c.filedAt, OCT15, true),
        toRelease(c.current, c.filedAt, OCT15),
        toRelease(c.current, c.filedAt, trueMs + 20 * 60_000),
        // A raw stamp without the mark, kept from a read before the change: the true instant.
        { acceptedAt: c.current, filedAt: c.filedAt, url: null },
      ];
      for (const f of reads) {
        const [row] = assembleReports([], [f], closes, "2026-12-01");
        assert.deepEqual([row!.date, row!.time, row!.reactionDay], [c.date, c.time, c.reaction]);
      }
    });
  }
});

describe("collectReports: releases that are not earnings", () => {
  it("leaves out filing-only item 2.02 releases far from the days the confirmed reports fall on", () => {
    // Tesla style: results about three weeks into the quarter, delivery figures two days in, both under item 2.02.
    const quarters = [
      q("2025-09-30", "2025-10-22T20:05:00.000Z", 0.5, 0.55, "3Q2025"),
      q("2025-12-31", "2026-01-28T21:05:00.000Z", 0.45, 0.5, "4Q2025"),
      q("2026-03-31", "2026-04-22T20:05:00.000Z", 0.4, 0.42, "1Q2026"),
      q("2026-06-30", "2026-07-22T20:05:00.000Z", 0.4, 0.4, "2Q2026"),
    ];
    const f = (filedAt: string): ReleaseFiling => ({ acceptedAt: `${filedAt}T20:05:00.000Z`, acceptedAtUtc: true, filedAt, url: `f-${filedAt}` });
    // Oct 2024: results sixteen days after the delivery figures, which must not swallow them.
    const deliveries = ["2024-10-02", "2025-04-02", "2025-07-02", "2025-10-02", "2026-01-02", "2026-04-02", "2026-07-02", "2026-10-02"].map(f);
    const results = ["2024-10-18", "2025-04-22", "2025-07-23", "2025-10-22", "2026-01-28", "2026-04-22", "2026-07-22"].map(f);
    const reports = collectReports(quarters, [...deliveries, ...results]);
    assert.deepEqual(
      reports.map((r) => r.date),
      ["2024-10-18", "2025-04-22", "2025-07-23", "2025-10-22", "2026-01-28", "2026-04-22", "2026-07-22"],
    );
  });

  it("keeps every filing when too few confirmed reports say where they fall", () => {
    const f = (filedAt: string): ReleaseFiling => ({ acceptedAt: `${filedAt}T20:05:00.000Z`, acceptedAtUtc: true, filedAt, url: null });
    const reports = collectReports([], ["2025-07-02", "2025-07-23", "2025-10-02"].map(f));
    assert.equal(reports.length, 3);
  });
});
