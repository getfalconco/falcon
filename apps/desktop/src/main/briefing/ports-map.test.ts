import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { RiskLatest } from "../../shared/risk-types";
import type { LiveQuote } from "../../shared/stock-types";
import type { TrackerStatus } from "../../shared/tracker-types";
import {
  fetchCorporateCalendar,
  fetchMarketSnapshot,
  fetchRecentCorporateEvents,
} from "../stock/market-data-service";
import {
  coverageOf,
  toCorporateCalendarRaw,
  toHeldQuote,
  toMarketSnapshot,
  toQuantSlice,
  toRiskLatestLite,
} from "./ports-map";

// ---------------------------------------------------------------------------
// Recorded provider shapes (2026-09-21), trimmed to the fields that are read.
// ---------------------------------------------------------------------------

/** ES=F, range=1d: a future mid-session, measured from its prior settlement. */
const ES_META = {
  symbol: "ES=F",
  regularMarketPrice: 7826.75,
  previousClose: 7712.5,
  chartPreviousClose: 7712.5,
  regularMarketTime: 1790013106,
  gmtoffset: -14400,
  currentTradingPeriod: {
    pre: { timezone: "EDT", start: 1789963200, end: 1789963200, gmtoffset: -14400 },
    regular: { timezone: "EDT", start: 1789963200, end: 1790049540, gmtoffset: -14400 },
    post: { timezone: "EDT", start: 1790049540, end: 1790049540, gmtoffset: -14400 },
  },
};

/** ^N225 on a Japanese holiday: the last print is the previous Friday's. */
const N225_HOLIDAY_META = {
  symbol: "^N225",
  regularMarketPrice: 65018.95,
  previousClose: 64136.2,
  regularMarketTime: 1789713903,
  currentTradingPeriod: { regular: { start: 1789948800, end: 1789971300 } },
};

const AAPL_SUMMARY = {
  calendarEvents: {
    maxAge: 1,
    earnings: {
      earningsDate: [{ raw: 1793304000, fmt: "2026-10-29" }],
      earningsCallDate: [{ raw: 1785441600, fmt: "2026-07-30" }],
      isEarningsDateEstimate: false,
    },
    exDividendDate: { raw: 1786320000, fmt: "2026-08-10" },
    dividendDate: { raw: 1786579200, fmt: "2026-08-13" },
  },
  summaryDetail: { dividendRate: { raw: 1.08, fmt: "1.08" } },
};

/** A company that pays no dividend: the date fields arrive as empty objects. */
const BRK_SUMMARY = {
  calendarEvents: {
    maxAge: 1,
    earnings: { earningsDate: [{ raw: 1794081600, fmt: "2026-11-07" }], earningsCallDate: [], isEarningsDateEstimate: true },
    exDividendDate: {},
    dividendDate: {},
  },
  summaryDetail: { dividendRate: {} },
};

/** SPY: the provider answers 200 with no calendarEvents module at all. */
const SPY_SUMMARY = { summaryDetail: { dividendRate: {}, exDividendDate: {} } };

const realFetch = globalThis.fetch;

/** Routes the provider's three hosts; anything else fails the test loudly. */
function stubFetch(routes: { chart?: unknown; summary?: unknown; summaryStatus?: number }): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    if (url.startsWith("https://fc.yahoo.com")) {
      return new Response("", { status: 200, headers: { "set-cookie": "A3=abc; Path=/" } });
    }
    if (url.includes("/v1/test/getcrumb")) return new Response("crumb123", { status: 200 });
    if (url.includes("/v10/finance/quoteSummary/")) {
      const status = routes.summaryStatus ?? 200;
      return new Response(JSON.stringify({ quoteSummary: { result: routes.summary ? [routes.summary] : [] } }), { status });
    }
    if (url.includes("/v8/finance/chart/")) {
      return new Response(JSON.stringify({ chart: { result: [routes.chart] } }), { status: 200 });
    }
    throw new Error(`unexpected request in test: ${url}`);
  }) as typeof fetch;
  return seen;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("market snapshot", () => {
  it("reads the settlement and the exchange's own print time off the chart meta", async () => {
    const seen = stubFetch({ chart: { meta: ES_META } });
    const read = await fetchMarketSnapshot("es=f");
    assert.deepEqual(
      { symbol: read.symbol, price: read.price, previousClose: read.previousClose, marketTime: read.marketTime },
      { symbol: "ES=F", price: 7826.75, previousClose: 7712.5, marketTime: 1790013106 },
    );
    // One request, the symbol escaped, the 1d range whose meta carries the settlement.
    assert.equal(seen.length, 1);
    assert.match(seen[0]!, /\/chart\/ES%3DF\?range=1d&interval=5m&includePrePost=true$/);

    const snapshot = toMarketSnapshot(read);
    assert.equal(snapshot.previous_close, 7712.5);
    assert.equal(snapshot.market_time, "2026-09-21T17:51:46.000Z");
  });

  it("keeps a holiday print's old timestamp instead of stamping it now", async () => {
    stubFetch({ chart: { meta: N225_HOLIDAY_META } });
    const snapshot = toMarketSnapshot(await fetchMarketSnapshot("^N225"));
    assert.equal(snapshot.market_time, "2026-09-18T06:45:03.000Z");
    assert.equal(snapshot.in_regular_session, false);
    assert.equal(snapshot.price, 65018.95);
  });

  it("falls back to chartPreviousClose and reports a missing price as null", async () => {
    stubFetch({ chart: { meta: { symbol: "^VIX", chartPreviousClose: 16.2 } } });
    const snapshot = toMarketSnapshot(await fetchMarketSnapshot("^VIX"));
    assert.equal(snapshot.previous_close, 16.2);
    assert.equal(snapshot.price, null);
    assert.equal(snapshot.market_time, null);
  });

  it("raises when the provider sends no meta", async () => {
    stubFetch({ chart: {} });
    await assert.rejects(fetchMarketSnapshot("ES=F"));
  });
});

describe("corporate calendar", () => {
  it("takes every date from the provider's fmt field", async () => {
    const seen = stubFetch({ summary: AAPL_SUMMARY });
    const read = await fetchCorporateCalendar("AAPL");
    assert.deepEqual(read, {
      available: true,
      exDividendDate: "2026-08-10",
      dividendDate: "2026-08-13",
      dividendRate: 1.08,
      earningsDates: ["2026-10-29"],
      earningsEstimated: false,
    });
    assert.ok(seen.some((url) => url.includes("modules=calendarEvents,summaryDetail")));
  });

  it("reads a raw epoch as a UTC date, never as a New York one", async () => {
    // 1786320000 is 2026-08-10T00:00:00Z. On a New York clock that instant is
    // still the evening of 08-09, which is the off-by-one this rule prevents.
    stubFetch({
      summary: { calendarEvents: { earnings: { earningsDate: [1793304000] }, exDividendDate: { raw: 1786320000 } } },
    });
    const read = await fetchCorporateCalendar("AAPL");
    assert.equal(read.exDividendDate, "2026-08-10");
    assert.deepEqual(read.earningsDates, ["2026-10-29"]);
  });

  it("distrusts a fmt that is not a date and uses the epoch beside it", async () => {
    stubFetch({ summary: { calendarEvents: { exDividendDate: { raw: 1786320000, fmt: "Aug 10, 2026" } } } });
    assert.equal((await fetchCorporateCalendar("AAPL")).exDividendDate, "2026-08-10");
  });

  it("reads empty date objects as no date, with the calendar still available", async () => {
    stubFetch({ summary: BRK_SUMMARY });
    const read = await fetchCorporateCalendar("BRK-B");
    assert.deepEqual(read, {
      available: true,
      exDividendDate: null,
      dividendDate: null,
      dividendRate: null,
      earningsDates: ["2026-11-07"],
      earningsEstimated: true,
    });
  });

  it("reports a fund, which has no calendar module, as not available", async () => {
    stubFetch({ summary: SPY_SUMMARY });
    const read = await fetchCorporateCalendar("SPY");
    assert.equal(read.available, false);
    assert.deepEqual(read.earningsDates, []);
    assert.equal(read.earningsEstimated, null);
  });

  it("raises on a failed request so a caller never caches it as an empty calendar", async () => {
    stubFetch({ summaryStatus: 500 });
    await assert.rejects(fetchCorporateCalendar("AAPL"));
  });
});

describe("recent corporate events", () => {
  it("lists distributions and splits oldest first, dated on the New York calendar", async () => {
    stubFetch({
      chart: {
        meta: { symbol: "SPY" },
        events: {
          dividends: {
            "1789738200": { amount: 1.889, date: 1789738200 },
            "1781789400": { amount: 1.76, date: 1781789400 },
          },
          splits: { "1787059800": { date: 1787059800, numerator: 10, denominator: 1, splitRatio: "10:1" } },
        },
      },
    });
    const read = await fetchRecentCorporateEvents("SPY");
    assert.deepEqual(read.dividends, [
      { date: "2026-06-18", amount: 1.76 },
      { date: "2026-09-18", amount: 1.889 },
    ]);
    assert.deepEqual(read.splits, [{ date: "2026-08-18", numerator: 10, denominator: 1 }]);
  });

  it("returns empty lists when the chart carries no events", async () => {
    stubFetch({ chart: { meta: { symbol: "NVDA" } } });
    assert.deepEqual(await fetchRecentCorporateEvents("NVDA"), { dividends: [], splits: [] });
  });
});

describe("toCorporateCalendarRaw", () => {
  it("merges the two reads into the engine's shape", () => {
    const raw = toCorporateCalendarRaw(
      "AAPL",
      { available: true, exDividendDate: "2026-08-10", dividendDate: "2026-08-13", dividendRate: 1.08, earningsDates: ["2026-10-29"], earningsEstimated: false },
      { dividends: [{ date: "2026-08-10", amount: 0.27 }], splits: [] },
    );
    assert.deepEqual(raw, {
      symbol: "AAPL",
      available: true,
      ex_dividend_date: "2026-08-10",
      dividend_date: "2026-08-13",
      dividend_rate: 1.08,
      earnings_dates: ["2026-10-29"],
      earnings_estimated: false,
      recent_dividends: [{ date: "2026-08-10", amount: 0.27 }],
      recent_splits: [],
    });
  });

  it("keeps the price-history events when the calendar read failed", () => {
    const raw = toCorporateCalendarRaw("SPY", null, { dividends: [{ date: "2026-09-18", amount: 1.889 }], splits: [] });
    assert.equal(raw.available, false);
    assert.equal(raw.ex_dividend_date, null);
    assert.deepEqual(raw.recent_dividends, [{ date: "2026-09-18", amount: 1.889 }]);
  });
});

describe("toHeldQuote", () => {
  const base: LiveQuote = {
    symbol: "AAPL",
    companyName: "Apple Inc.",
    price: 339.4,
    change: 1.1,
    changePercent: 0.33,
    session: "pre",
    asOf: 1790000000000,
    previousClose: 336.13,
    regularPrice: 338.3,
  };

  it("keeps the extended-hours print and the close it moved from apart", () => {
    assert.deepEqual(toHeldQuote(base), {
      symbol: "AAPL",
      price: 339.4,
      regular_price: 338.3,
      previous_close: 336.13,
      session: "pre",
      as_of: "2026-09-21T14:13:20.000Z",
    });
  });

  it("never fills a missing regular price with the latest print", () => {
    const quote = toHeldQuote({ ...base, regularPrice: undefined, previousClose: undefined });
    assert.equal(quote.regular_price, null);
    assert.equal(quote.previous_close, null);
  });

  it("reads the provider's zero as no price", () => {
    assert.equal(toHeldQuote({ ...base, price: 0 }).price, null);
  });
});

describe("toQuantSlice", () => {
  it("converts the Tracker's fractional volatility to percent", () => {
    const slice = toQuantSlice({ daily_vol_30d: 0.0184, beta_90d: 1.21 });
    // Within float noise of 1.84: the conversion is a multiplication, not a rounding.
    assert.ok(slice !== null && slice.daily_vol_30d !== null && Math.abs(slice.daily_vol_30d - 1.84) < 1e-9);
    assert.equal(slice.beta, 1.21);
  });

  it("passes nulls through and answers null for no context", () => {
    assert.deepEqual(toQuantSlice({ daily_vol_30d: null, beta_90d: null }), { daily_vol_30d: null, beta: null });
    assert.equal(toQuantSlice(null), null);
  });
});

describe("toRiskLatestLite", () => {
  const latest = {
    riskCardEnabled: true,
    snapshot: {
      schema_version: 1,
      computed_at: "2026-09-21T13:00:00.000Z",
      account: "paper",
      trigger: ["close_run"],
      invested_fraction: 0.8,
      position_count: 2,
      score: 57.2,
      band: "elevated",
      components: {
        market: { score: 61, beta_eff: 1.18, beta_port: 1.31 },
        volatility: { score: 55, port_vol_daily_pct: 1.64, spy_vol_daily_pct: 0.9, systematic_share: 0.7 },
      },
      driver: { component: "concentration", sentence: "Two names carry most of the book.", contribution: 0.4 },
      weights: [
        { ticker: "nvda", weight: 0.6, market_value: 60000, side: "long" },
        { ticker: "AAPL", weight: 0.4, market_value: 40000, side: "long" },
      ],
      degraded: [],
      graph_version: null,
      empty: false,
    },
  } as unknown as RiskLatest;

  it("reduces the snapshot to what the briefing prints", () => {
    assert.deepEqual(toRiskLatestLite(latest), {
      score: 57.2,
      band: "elevated",
      driver_component: "concentration",
      driver_sentence: "Two names carry most of the book.",
      beta_eff: 1.18,
      beta_port: 1.31,
      port_vol_daily_pct: 1.64,
      computed_at: "2026-09-21T13:00:00.000Z",
      tickers: ["NVDA", "AAPL"],
    });
  });

  it("answers null when nothing has been computed", () => {
    assert.equal(toRiskLatestLite({ snapshot: null }), null);
    assert.equal(toRiskLatestLite(null), null);
  });

  it("survives an empty snapshot with no components", () => {
    const lite = toRiskLatestLite({
      snapshot: { ...latest.snapshot!, score: null, band: null, components: null, driver: null, weights: [], empty: true },
    });
    assert.deepEqual(lite?.tickers, []);
    assert.equal(lite?.beta_eff, null);
    assert.equal(lite?.band, null);
  });
});

describe("coverageOf", () => {
  const health = (news: { last_success_at: string | null; last_error: string | null }) => ({
    news,
    filings: { last_success_at: "2026-09-21T12:00:00.000Z", last_error: null },
    calendar: { last_success_at: "2026-09-21T12:00:00.000Z", last_error: null },
    price: { last_success_at: "2026-09-21T12:00:00.000Z", last_error: null },
  });
  const status = {
    tickers: [
      { ticker: "AAPL", backfilled: true, insiderSeeded: true, barsAsOf: "2026-09-18", health: health({ last_success_at: "2026-09-21T12:00:00.000Z", last_error: null }) },
      { ticker: "XLE", backfilled: true, insiderSeeded: true, barsAsOf: "2026-09-18", health: health({ last_success_at: null, last_error: null }) },
      { ticker: "TSM", backfilled: true, insiderSeeded: false, barsAsOf: "2026-09-18", health: health({ last_success_at: null, last_error: "HTTP 429" }) },
      { ticker: "PLTR", backfilled: false, insiderSeeded: false, barsAsOf: null, health: health({ last_success_at: null, last_error: null }) },
    ],
  } as Pick<TrackerStatus, "tickers">;

  it("reads a polled news channel as tracked, whatever the symbol's case", () => {
    assert.equal(coverageOf("aapl", status), "tracked");
  });

  it("reads a news channel that was never polled as the price tier", () => {
    assert.equal(coverageOf("XLE", status), "price_only");
  });

  it("keeps a name whose news poll is failing as tracked: it is followed, the feed is down", () => {
    assert.equal(coverageOf("TSM", status), "tracked");
  });

  it("reads a name that is not backfilled, or not listed, as pending", () => {
    assert.equal(coverageOf("PLTR", status), "pending");
    assert.equal(coverageOf("SHOP", status), "pending");
    assert.equal(coverageOf("AAPL", null), "pending");
  });
});
