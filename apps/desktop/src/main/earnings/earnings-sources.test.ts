import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dedupeMarketEntries,
  finnhubTime,
  mergeEarnings,
  parseFinnhubCalendar,
  parseYahooEarnings,
  snapshotOf,
  yahooTime,
  consensusThin,
  type ConsensusSnapshot,
  type MarketCalendarEntry,
  type MergeWindow,
  type YahooEarningsRead,
} from "./earnings-sources";

const FROM = "2026-10-15";
const TO = "2026-11-11";
/** Thursday 2026-10-15, 10:00 in New York; the week began Monday the 12th. */
const NOW = Date.parse("2026-10-15T14:00:00Z");
const W: MergeWindow = { from: "2026-10-12", today: FROM, to: TO, nowMs: NOW };

function line(over: Partial<MarketCalendarEntry> = {}): MarketCalendarEntry {
  return { ticker: "IBM", date: "2026-10-21", time: "amc", fiscalPeriod: "Q3 2026", epsEstimate: 2.8957, revenueEstimate: 16_989_872_085, ...over };
}

function yahoo(over: Partial<YahooEarningsRead> = {}): YahooEarningsRead {
  return { dates: ["2026-10-21"], estimated: false, time: "unknown", epsEstimate: 2.87, revenueEstimate: 16_833_801_490, lastSurprise: null, ...over };
}

describe("finnhub time of day", () => {
  it("maps the provider's hour and treats anything else as unknown", () => {
    assert.equal(finnhubTime("bmo"), "bmo");
    assert.equal(finnhubTime("AMC"), "amc");
    assert.equal(finnhubTime("dmh"), "dmh");
    assert.equal(finnhubTime(""), "unknown");
    assert.equal(finnhubTime(null), "unknown");
    assert.equal(finnhubTime("tns"), "unknown");
  });
});

describe("the market-wide calendar", () => {
  it("normalizes lines, drops preferreds and junk, keeps missing figures empty", () => {
    const { entries, rawCount } = parseFinnhubCalendar({
      earningsCalendar: [
        { symbol: "IBM", date: "2026-10-21", hour: "amc", quarter: 3, year: 2026, epsEstimate: 2.8957, revenueEstimate: 16989872085, epsActual: null },
        { symbol: "SEAL PR B", date: "2026-10-21", hour: "", quarter: 3, year: 2026 },
        { symbol: "xom", date: "2026-10-23", hour: "", quarter: 3, year: 2026, epsEstimate: null, revenueEstimate: 0 },
        { symbol: "BAD", date: "2026-02-30" },
        "nonsense",
      ],
    });
    assert.equal(rawCount, 5);
    assert.deepEqual(entries, [
      { ticker: "IBM", date: "2026-10-21", time: "amc", fiscalPeriod: "Q3 2026", epsEstimate: 2.8957, revenueEstimate: 16989872085 },
      { ticker: "XOM", date: "2026-10-23", time: "unknown", fiscalPeriod: "Q3 2026", epsEstimate: null, revenueEstimate: null },
    ]);
  });

  it("answers nothing for an answer that is not a calendar", () => {
    assert.deepEqual(parseFinnhubCalendar(null), { entries: [], rawCount: 0 });
    assert.deepEqual(parseFinnhubCalendar({ error: "limit" }), { entries: [], rawCount: 0 });
  });

  it("keeps one line per company and day, the one that says more", () => {
    const out = dedupeMarketEntries([
      line({ time: "unknown", epsEstimate: null }),
      line(),
      line({ ticker: "AAA", date: "2026-10-16" }),
    ]);
    assert.deepEqual(out.map((e) => `${e.ticker}:${e.time}`), ["AAA:amc", "IBM:amc"]);
  });
});

describe("yahoo", () => {
  it("reads the hour only from a stamp that carries one", () => {
    // 12:30Z on an October day is 08:30 in New York.
    assert.equal(yahooTime(Date.parse("2026-10-30T12:30:00Z") / 1000, "2026-10-30"), "bmo");
    assert.equal(yahooTime(Date.parse("2026-10-21T20:00:00Z") / 1000, "2026-10-21"), "amc");
    assert.equal(yahooTime(Date.parse("2026-10-21T04:00:00Z") / 1000, "2026-10-21"), "unknown");
    assert.equal(yahooTime(Date.parse("2026-10-21T15:00:00Z") / 1000, "2026-10-21"), "unknown");
    assert.equal(yahooTime(Date.parse("2026-10-21T00:00:00Z") / 1000, "2026-10-21"), "unknown");
    assert.equal(yahooTime(null, "2026-10-21"), "unknown");
  });

  it("reads the date, the consensus and the last surprise", () => {
    const read = parseYahooEarnings({
      calendarEvents: {
        earnings: {
          earningsDate: [{ raw: 1792612800, fmt: "2026-10-21" }],
          isEarningsDateEstimate: false,
          earningsAverage: { raw: 2.87011, fmt: "2.87" },
          revenueAverage: { raw: 16833801490, fmt: "16.83B" },
        },
      },
      earningsHistory: {
        history: [
          { epsActual: { raw: 2.93 }, epsEstimate: { raw: 2.93306 }, surprisePercent: { raw: -0.001 }, quarter: { raw: 1782777600, fmt: "2026-06-30" } },
          { epsActual: { raw: 1.91 }, epsEstimate: { raw: 1.81123 }, surprisePercent: { raw: 0.0545 }, quarter: { raw: 1774915200, fmt: "2026-03-31" } },
        ],
      },
    });
    assert.deepEqual(read, {
      dates: ["2026-10-21"],
      estimated: false,
      time: "amc",
      epsEstimate: 2.87011,
      revenueEstimate: 16833801490,
      lastSurprise: { quarterEnd: "2026-06-30", epsActual: 2.93, epsEstimate: 2.93306, surprisePct: -0.1 },
      epsCurrency: null,
      revenueCurrency: null,
      consensus: { analysts: null, low: null, high: null, thin: false },
      consensusPeriodEnd: null,
      consensusFiscal: null,
      quarters: [],
    });
  });

  it("leaves what it was not given empty, and takes no hour from an estimate", () => {
    const read = parseYahooEarnings({
      calendarEvents: { earnings: { earningsDate: [{ raw: 1793363400, fmt: "2026-10-30" }, { raw: 1793795400, fmt: "2026-11-04" }], isEarningsDateEstimate: true } },
    });
    assert.deepEqual(read, {
      dates: ["2026-10-30", "2026-11-04"],
      estimated: true,
      time: "unknown",
      epsEstimate: null,
      revenueEstimate: null,
      lastSurprise: null,
      epsCurrency: null,
      revenueCurrency: null,
      consensus: null,
      consensusPeriodEnd: null,
      consensusFiscal: null,
      quarters: [],
    });
    assert.equal(parseYahooEarnings(null), null);
    assert.equal(parseYahooEarnings({ summaryDetail: {} }), null);
  });
});

describe("one company's row", () => {
  it("a company's own date wins, with the market hour when the market has the same day", () => {
    const row = mergeEarnings(yahoo(), [line()], W)!;
    assert.equal(row.date, "2026-10-21");
    assert.equal(row.status, "confirmed");
    assert.equal(row.time, "amc");
    assert.equal(row.fiscalPeriod, "Q3 2026");
    // Yahoo's consensus is for the report it dates.
    assert.equal(row.epsEstimate, 2.87);
  });

  it("a different market day is set aside, not merged in", () => {
    const row = mergeEarnings(yahoo({ dates: ["2026-10-30"], time: "bmo" }), [line({ date: "2026-10-23", time: "amc" })], W)!;
    assert.equal(row.date, "2026-10-30");
    assert.equal(row.time, "bmo");
    assert.equal(row.fiscalPeriod, null);
  });

  it("an announced date outside the window gives no row", () => {
    assert.equal(mergeEarnings(yahoo({ dates: ["2026-12-01"] }), [line()], W), null);
  });

  it("an estimate stays an estimate", () => {
    const row = mergeEarnings(yahoo({ estimated: true }), [], W)!;
    assert.equal(row.status, "estimated");
    assert.equal(row.time, "unknown");
  });

  it("a window takes a market day inside it, still estimated", () => {
    const row = mergeEarnings(yahoo({ dates: ["2026-10-20", "2026-10-24"], estimated: true }), [line({ date: "2026-10-22", time: "bmo" })], W)!;
    assert.deepEqual([row.date, row.windowEnd, row.time, row.status], ["2026-10-22", null, "bmo", "estimated"]);
  });

  it("a window without a market day is listed from its first day, or from today once under way", () => {
    const later = mergeEarnings(yahoo({ dates: ["2026-10-20", "2026-10-24"], estimated: true }), [], W)!;
    assert.deepEqual([later.date, later.windowEnd], ["2026-10-20", "2026-10-24"]);
    const under = mergeEarnings(yahoo({ dates: ["2026-10-13", "2026-10-17"], estimated: true }), [], W)!;
    assert.deepEqual([under.date, under.windowEnd], [FROM, "2026-10-17"]);
  });

  it("a market line alone says it cannot tell whether the date is announced", () => {
    const row = mergeEarnings(null, [line()], W)!;
    assert.deepEqual([row.status, row.time, row.epsEstimate], ["unknown", "amc", 2.8957]);
    assert.equal(row.lastSurprise, null);
  });

  it("a past Yahoo date falls back to the market line", () => {
    const row = mergeEarnings(yahoo({ dates: ["2026-07-21"] }), [line()], W)!;
    assert.equal(row.status, "unknown");
    assert.equal(row.date, "2026-10-21");
  });

  it("nothing from either provider gives no row", () => {
    assert.equal(mergeEarnings(null, [], W), null);
    assert.equal(mergeEarnings(yahoo({ dates: [] }), [line({ date: "2026-12-24" })], W), null);
  });
});

// ---------------------------------------------------------------------------
// v2: currencies, the consensus's spread, the quarters on record, reported rows
// ---------------------------------------------------------------------------

/** TSM's read on the day it reported (2026-10-15, 02:08 New York), shaped as Yahoo sent it. */
const TSM_MODULES = {
  calendarEvents: {
    earnings: {
      earningsDate: [{ raw: 1792067400, fmt: "2026-10-15" }],
      isEarningsDateEstimate: false,
      // Already the NEXT quarter's consensus (Q4), as Yahoo shows it from report day.
      earningsAverage: { raw: 5.07666 },
      earningsLow: { raw: 4.76 },
      earningsHigh: { raw: 5.44 },
      revenueAverage: { raw: 1700416107420 },
    },
  },
  earningsTrend: {
    trend: [
      {
        period: "0q",
        endDate: "2026-12-31",
        earningsEstimate: { avg: { raw: 5.07666 }, numberOfAnalysts: { raw: 8 }, earningsCurrency: "USD" },
        revenueEstimate: { avg: { raw: 1700416107420 }, revenueCurrency: "TWD" },
      },
    ],
  },
  earnings: {
    financialCurrency: "TWD",
    earningsChart: {
      quarterly: [
        // reportedDate on midnight UTC: a day without a time.
        { date: "2Q2026", fiscalQuarter: "2Q2026", actual: { raw: 4.31 }, estimate: { raw: 3.88658 }, periodEndDate: { raw: 1782777600, fmt: "2026-06-30" }, reportedDate: { raw: 1784160000, fmt: "2026-07-16" } },
        { date: "3Q2026", fiscalQuarter: "3Q2026", actual: { raw: 4.6 }, estimate: { raw: 4.52449 }, periodEndDate: { raw: 1790726400, fmt: "2026-09-30" }, reportedDate: { raw: 1792044507, fmt: "2026-10-15" } },
      ],
      currentFiscalQuarter: "4Q2026",
    },
    financialsChart: {
      quarterly: [
        { date: "2Q2026", revenue: { raw: 1270380000000 } },
        { date: "3Q2026", revenue: { raw: 1494243000000 } },
      ],
    },
  },
};

describe("yahoo, v2", () => {
  it("keeps the two currencies apart: EPS in the listing's, revenue in the company's", () => {
    const read = parseYahooEarnings(TSM_MODULES)!;
    assert.equal(read.epsCurrency, "USD");
    assert.equal(read.revenueCurrency, "TWD");
    assert.equal(read.consensusPeriodEnd, "2026-12-31");
    assert.equal(read.consensusFiscal, "Q4 2026");
    assert.deepEqual(read.consensus, { analysts: 8, low: 4.76, high: 5.44, thin: false });
  });

  it("reads the quarters on record, with the release instant only when the stamp carries a time", () => {
    const q = parseYahooEarnings(TSM_MODULES)!.quarters!;
    assert.deepEqual(
      q.map((x) => [x.fiscalQuarter, x.reportedAt, x.reportedYmd, x.epsActual, x.revenueActual]),
      [
        ["2Q2026", null, "2026-07-16", 4.31, 1270380000000],
        ["3Q2026", "2026-10-15T06:08:27.000Z", "2026-10-15", 4.6, 1494243000000],
      ],
    );
  });

  it("marks a consensus of two estimates, or one that runs from a loss to a profit, as thin (ARGX)", () => {
    const read = parseYahooEarnings({
      calendarEvents: {
        earnings: {
          earningsDate: [{ raw: 1792672200, fmt: "2026-10-22" }],
          isEarningsDateEstimate: false,
          earningsAverage: { raw: -9.775 },
          earningsLow: { raw: -27.83 },
          earningsHigh: { raw: 8.28 },
        },
      },
      earningsTrend: { trend: [{ period: "0q", endDate: "2026-09-30", earningsEstimate: { numberOfAnalysts: { raw: 2 }, earningsCurrency: "USD" } }] },
    })!;
    assert.equal(read.epsEstimate, -9.775, "the provider's mean is kept as it is, sign and all");
    assert.deepEqual(read.consensus, { analysts: 2, low: -27.83, high: 8.28, thin: true });
    assert.equal(consensusThin(12, -0.2, 0.4), true);
    assert.equal(consensusThin(12, 1.1, 1.4), false);
    assert.equal(consensusThin(null, null, null), false);
  });
});

describe("one company's row, v2", () => {
  const tsm = parseYahooEarnings(TSM_MODULES)!;
  const snap: ConsensusSnapshot = {
    periodEnd: "2026-09-30",
    epsEstimate: 4.52,
    revenueEstimate: 1_486_000_000_000,
    epsCurrency: "USD",
    revenueCurrency: "TWD",
    consensus: { analysts: 9, low: 4.3, high: 4.7, thin: false },
    at: NOW - 86_400_000,
  };

  it("a release on record is reported with its own quarter, never the next quarter's consensus (TSM)", () => {
    const row = mergeEarnings(tsm, [], { ...W, snapshot: (end) => (end === snap.periodEnd ? snap : null) })!;
    assert.equal(row.phase, "reported");
    assert.equal(row.date, "2026-10-15");
    assert.equal(row.releasedAt, "2026-10-15T06:08:27.000Z");
    assert.equal(row.time, "bmo");
    assert.equal(row.fiscalPeriod, "Q3 2026");
    assert.equal(row.epsActual, 4.6);
    assert.equal(row.epsEstimate, 4.52449, "the quarter's own consensus, not 5.08");
    assert.equal(row.revenueActual, 1494243000000);
    assert.equal(row.revenueEstimate, 1_486_000_000_000, "the consensus kept before the release");
    assert.equal(row.revenueCurrency, "TWD");
    assert.deepEqual(row.consensus, snap.consensus);
    assert.equal(row.source, "yahoo");
  });

  it("without a kept consensus the revenue estimate stays empty rather than the next quarter's", () => {
    const row = mergeEarnings(tsm, [], W)!;
    assert.equal(row.revenueEstimate, null);
    assert.equal(row.revenueActual, 1494243000000);
  });

  it("a release before this week is not listed as reported", () => {
    const row = mergeEarnings(tsm, [], { ...W, from: "2026-10-19", today: "2026-10-19", nowMs: Date.parse("2026-10-19T14:00:00Z") });
    assert.notEqual(row?.phase, "reported");
  });

  it("a market line with figures this week is reported from Finnhub when Yahoo has no record", () => {
    const row = mergeEarnings(
      null,
      [line({ ticker: "JPM", date: "2026-10-13", time: "bmo", epsEstimate: 5.958, revenueEstimate: 51.7e9, epsActual: 5.57, revenueActual: 50.9e9 })],
      W,
    )!;
    assert.deepEqual([row.phase, row.source, row.epsActual, row.revenueActual, row.date], ["reported", "finnhub", 5.57, 50.9e9, "2026-10-13"]);
  });

  it("a date past its hour without figures is pending; one not yet at its hour is upcoming", () => {
    assert.equal(mergeEarnings(yahoo({ dates: ["2026-10-14"], time: "amc" }), [], W)!.phase, "pending");
    // 10:00 New York: a report before the open is due, one after the close is not.
    assert.equal(mergeEarnings(yahoo({ dates: ["2026-10-15"], time: "bmo" }), [], W)!.phase, "pending");
    assert.equal(mergeEarnings(yahoo({ dates: ["2026-10-15"], time: "amc" }), [], W)!.phase, "upcoming");
    assert.equal(mergeEarnings(yahoo({ dates: ["2026-10-15"], time: "amc" }), [], { ...W, nowMs: Date.parse("2026-10-15T20:05:00Z") })!.phase, "pending");
  });

  it("an estimated single day already behind today is the provider's guess, not a report", () => {
    assert.equal(mergeEarnings(yahoo({ dates: ["2026-10-13"], estimated: true }), [], W), null);
  });

  it("keeps a consensus snapshot only for a quarter not yet on record", () => {
    const kept = snapshotOf(tsm, NOW)!;
    assert.equal(kept.periodEnd, "2026-12-31");
    assert.equal(kept.revenueCurrency, "TWD");
    assert.equal(snapshotOf({ ...tsm, consensusPeriodEnd: "2026-09-30" }, NOW), null, "Q3 is on record: its consensus has rolled");
  });
});
