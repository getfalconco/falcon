// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/tools/tools.test.ts
// Every request is answered by a mocked fetch; nothing leaves the machine.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { DESK_TOOLS, deskToolLabel, runDeskTool } from "./index";
import { durationSeries, ttm } from "./fundamentals";
import { excerpt, filingIndexUrl } from "./filings";
import { isRoutine } from "./form4";
import { resetSec, type XbrlFact } from "./sec";
import { fitResult, normalizeTicker, weekdayIndex } from "./util";
import { resetYahoo } from "./yahoo";
import { prices } from "./databento";
import { emptyHistory, emptyLatest, type PriceBar } from "../../prices-api";

/* ------------------------------------------------------------------ fetch mock */

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const realFetch = globalThis.fetch;
let calls: string[] = [];

function mockFetch(routes: [RegExp, Handler][]) {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    for (const [re, fn] of routes) if (re.test(url)) return fn(url, init);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (body: string, status = 200) => new Response(body, { status });

/** Yahoo's cookie and crumb pages. */
const yahooSession: [RegExp, Handler][] = [
  [/^https:\/\/fc\.yahoo\.com/, () => new Response("", { status: 404, headers: { "set-cookie": "A3=d=abc; path=/" } })],
  [/getcrumb/, () => text("crumb123")],
];

const TICKERS = {
  "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  "1": { cik_str: 111, ticker: "TST", title: "TEST CORP /DE/" },
  "2": { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" },
};
const secTickers: [RegExp, Handler] = [/company_tickers\.json$/, () => json(TICKERS)];

const NOW = Date.parse("2026-11-13T18:00:00Z");
const ctx = { now: () => NOW, timeoutMs: 8_000 };

const realPrices = { ...prices };
beforeEach(() => {
  // No Databento data by default: the Yahoo paths are under test.
  prices.getLatest = async (t) => emptyLatest(t);
  prices.getHistory = async (t, r) => emptyHistory(t, r);
  resetYahoo();
  resetSec();
});
afterEach(() => {
  Object.assign(prices, realPrices);
  globalThis.fetch = realFetch;
});

/* ------------------------------------------------------------------ basics */

test("tickers: normalized to the Yahoo / SEC form; junk refused", () => {
  assert.equal(normalizeTicker(" brk.b "), "BRK-B");
  assert.equal(normalizeTicker("$aapl"), "AAPL");
  assert.equal(normalizeTicker("BF/B"), "BF-B");
  assert.throws(() => normalizeTicker("Apple Inc"));
  assert.throws(() => normalizeTicker("AAPL; DROP"));
  assert.throws(() => normalizeTicker(42));
});

test("bad input and unknown tools come back as { error }, never thrown", async () => {
  mockFetch([]);
  const bad = await runDeskTool("quote", { ticker: "not a ticker" }, ctx);
  assert.equal(bad.ok, false);
  assert.match(JSON.parse(bad.content).error, /not a US stock ticker/);
  const unknown = await runDeskTool("nope", {}, ctx);
  assert.equal(unknown.ok, false);
  assert.match(JSON.parse(unknown.content).error, /Unknown tool/);
  const range = await runDeskTool("history", { ticker: "AAPL", range: "7y" }, ctx);
  assert.match(JSON.parse(range.content).error, /range must be one of/);
  assert.equal(calls.length, 0, "validation fails before any request");
});

test("tool definitions: unique names, closed schemas, ticker required where used", () => {
  const names = DESK_TOOLS.map((t) => t.name);
  assert.deepEqual(names, ["quote", "history", "fundamentals", "earnings", "filings", "filing_text", "insiders", "flow"]);
  for (const t of DESK_TOOLS) {
    assert.equal(t.input_schema.additionalProperties, false, t.name);
    assert.ok(t.description.length > 80, t.name);
    assert.ok((t.input_schema.required as readonly string[]).length >= 1, t.name);
  }
});

test("labels for the UI", () => {
  assert.equal(deskToolLabel("quote", { ticker: "brk-b" }, "running"), "Looking up BRK.B quote");
  assert.equal(deskToolLabel("quote", { ticker: "AAPL" }), "Looked up AAPL quote");
  assert.equal(deskToolLabel("history", { ticker: "NVDA", range: "5y" }), "Loaded NVDA 5y price history");
  assert.equal(deskToolLabel("filings", { ticker: "AAPL", form: "8-K", query: "tariffs" }, "running"), 'Searching AAPL 8-K filings for "tariffs"');
  assert.equal(deskToolLabel("filing_text", { url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000024/aapl-20261102.htm" }), "Read aapl-20261102");
});

test("fitResult keeps results under the cap and says what it cut", () => {
  const big = { rows: Array.from({ length: 2_000 }, (_, i) => ({ i, note: "x".repeat(20) })), closes: Array.from({ length: 500 }, (_, i) => [`d${i}`, i]) };
  const out = fitResult(big, 6_000);
  assert.ok(out.length <= 6_000);
  const parsed = JSON.parse(out);
  assert.ok(parsed.truncated.length >= 1);
  assert.equal(parsed.rows[0].i, 0, "keeps the head of a list");
  assert.equal(fitResult({ a: 1 }), '{"a":1}');
});

test("weekdays: a Friday and the next Monday are one business day apart", () => {
  assert.equal(weekdayIndex("2026-11-16") - weekdayIndex("2026-11-13"), 1);
  assert.equal(weekdayIndex("2026-11-13") - weekdayIndex("2026-11-09"), 4);
});

/* ------------------------------------------------------------------ quote */

const QUOTE_ROW = {
  symbol: "AAPL",
  quoteType: "EQUITY",
  longName: "Apple Inc.",
  fullExchangeName: "NasdaqGS",
  currency: "USD",
  regularMarketPrice: 356.27,
  regularMarketChange: 1.3899841,
  regularMarketChangePercent: 0.3916772,
  regularMarketPreviousClose: 354.88,
  regularMarketOpen: 357.965,
  regularMarketDayHigh: 360.83,
  regularMarketDayLow: 355.755,
  regularMarketVolume: 40027467,
  marketCap: 5177380175872,
  marketState: "POST",
  regularMarketTime: 1794603601,
  postMarketPrice: 355.3849,
  postMarketChangePercent: -0.248,
  postMarketTime: 1794617980,
  exchangeDataDelayedBy: 15,
  epsTrailingTwelveMonths: 8.98,
};

test("quote: v7 quote fields, after-hours price, New York time", async () => {
  mockFetch([...yahooSession, [/v7\/finance\/quote/, () => json({ quoteResponse: { result: [QUOTE_ROW] } })]]);
  const r = await runDeskTool("quote", { ticker: "aapl" }, ctx);
  assert.equal(r.ok, true, r.content);
  const q = JSON.parse(r.content);
  assert.equal(q.price, 356.27);
  assert.equal(q.change, 1.39);
  assert.equal(q.changePct, 0.39);
  assert.equal(q.previousClose, 354.88);
  assert.equal(q.marketState, "after-hours");
  assert.equal(q.priceTime, "2026-11-13 16:00 ET");
  assert.equal(q.afterHours.price, 355.3849);
  assert.ok(calls.some((u) => u.includes("crumb=crumb123")));
});

test("quote: falls back to the chart summary when the quote endpoint fails", async () => {
  mockFetch([
    ...yahooSession,
    [/v7\/finance\/quote/, () => text("busy", 500)],
    [
      /v8\/finance\/chart\/AAPL\?range=1d/,
      () =>
        json({
          chart: {
            result: [
              {
                meta: { currency: "USD", longName: "Apple Inc.", regularMarketPrice: 356.27, chartPreviousClose: 354.88, regularMarketTime: 1794603601, regularMarketVolume: 40027467 },
                timestamp: [1794580200],
                indicators: { quote: [{ close: [356.27] }] },
              },
            ],
          },
        }),
    ],
  ]);
  const r = await runDeskTool("quote", { ticker: "AAPL" }, ctx);
  assert.equal(r.ok, true, r.content);
  const q = JSON.parse(r.content);
  assert.equal(q.previousClose, 354.88);
  assert.equal(q.changePct, 0.39);
  assert.match(q.source, /chart summary/);
});

test("quote: an unknown symbol is a readable error", async () => {
  mockFetch([...yahooSession, [/v7\/finance\/quote/, () => json({ quoteResponse: { result: [] } })], [/v8\/finance\/chart/, () => text("", 404)]]);
  const r = await runDeskTool("quote", { ticker: "ZZZZ" }, ctx);
  assert.equal(r.ok, false);
  assert.match(JSON.parse(r.content).error, /No quote found for ZZZZ/);
});

test("quote: Databento end-of-day close first, no Yahoo call", async () => {
  mockFetch([]);
  prices.getLatest = async (t) => ({ ...emptyLatest(t), date: "2026-11-13", open: 357, high: 360, low: 355, close: 356.27, volume: 40_000_000, prevDate: "2026-11-12", prevClose: 354.88, change: 1.39, changePct: 0.39 });
  prices.getHistory = async (t, r) => ({ ...emptyHistory(t, r), asOf: "2026-11-13", from: "2025-11-14", count: 2, bars: [["2025-11-14", 1, 400, 90, 2, 3], ["2026-11-13", 1, 380, 100, 2, 3]] as PriceBar[] });
  const r = await runDeskTool("quote", { ticker: "AAPL" }, ctx);
  assert.equal(r.ok, true, r.content);
  const q = JSON.parse(r.content);
  assert.equal(q.price, 356.27);
  assert.equal(q.previousClose, 354.88);
  assert.equal(q.fiftyTwoWeekHigh, 400);
  assert.equal(q.fiftyTwoWeekLow, 90);
  assert.match(q.source, /^Databento EQUS\.SUMMARY, end of day, as of 2026-11-13/);
  assert.equal(calls.length, 0);
});

test("history: Databento for a covered range, Yahoo (not mixed) for an older one", async () => {
  mockFetch([]);
  const bars: PriceBar[] = [];
  for (let i = 0; i < 30; i++) bars.push([new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10), 100 + i, 102 + i, 99 + i, 101 + i, 1000]);
  prices.getHistory = async (t, r) => ({ ...emptyHistory(t, r), asOf: bars.at(-1)![0], from: "2024-07-01", count: bars.length, bars });
  const r = await runDeskTool("history", { ticker: "NVDA", range: "1m" }, ctx);
  const h = JSON.parse(r.content);
  assert.equal(r.ok, true, r.content);
  assert.match(h.source, /^Databento EQUS\.SUMMARY, end of day/);
  assert.equal(h.totalReturnPct, null);
  assert.equal(calls.length, 0);
  // 5y starts before 2024-07-01: whole answer from Yahoo.
  const r2 = await runDeskTool("history", { ticker: "NVDA", range: "5y" }, ctx);
  assert.equal(r2.ok, false);
  assert.ok(calls.some((u) => u.includes("v8/finance/chart")));
});

/* ------------------------------------------------------------------ history */

test("history: returns, drawdown, high/low and at most 120 closes", async () => {
  const start = Date.parse("2025-11-14T14:30:00Z") / 1000;
  const ts: number[] = [];
  const close: number[] = [];
  for (let i = 0; i < 250; i++) {
    ts.push(start + i * 86_400);
    // Up to 150 by day 100, down to 120 by day 150, then up to 160.
    close.push(i <= 100 ? 100 + i * 0.5 : i <= 150 ? 150 - (i - 100) * 0.6 : 120 + (i - 150) * 0.4);
  }
  mockFetch([
    [
      /v8\/finance\/chart\/NVDA\?range=1y&interval=1d/,
      () =>
        json({
          chart: {
            result: [
              {
                meta: { currency: "USD", gmtoffset: -18000, currentTradingPeriod: { regular: { start: 1, end: 2 } } },
                timestamp: ts,
                indicators: {
                  quote: [{ open: close, high: close.map((c) => c + 1), low: close.map((c) => c - 1), close, volume: close.map(() => 1_000) }],
                  adjclose: [{ adjclose: close.map((c, i) => c * (1 + i * 0.0001)) }],
                },
              },
            ],
          },
        }),
    ],
  ]);
  const r = await runDeskTool("history", { ticker: "NVDA" }, ctx);
  assert.equal(r.ok, true, r.content);
  const h = JSON.parse(r.content);
  assert.equal(h.bars, 250);
  assert.equal(h.start.close, 100);
  assert.equal(h.priceReturnPct, round2((close.at(-1)! / 100 - 1) * 100));
  assert.ok(h.totalReturnPct > h.priceReturnPct, "dividends add to total return");
  assert.equal(h.maxDrawdown.pct, -20);
  assert.equal(h.high.price, close.at(-1)! + 1);
  assert.equal(h.low.price, 99);
  assert.ok(h.closes.length <= 120);
  assert.deepEqual(h.closes[0], [h.start.date, 100]);
  assert.equal(h.closes.at(-1)[0], h.end.date);
  assert.ok(r.content.length < 12_000);
});

const round2 = (x: number) => Math.round(x * 100) / 100;

/* ------------------------------------------------------------------ fundamentals */

const f = (start: string, end: string, val: number, filed: string, form = "10-Q"): XbrlFact => ({ start, end, val, filed, form, accn: `acc-${filed}` });

test("fundamentals: quarters derived from year-to-date facts; restatements win; TTM", () => {
  const facts = [
    f("2024-09-29", "2025-09-27", 400, "2025-10-31", "10-K"),
    f("2025-09-28", "2025-12-27", 140, "2026-01-30"),
    f("2025-09-28", "2026-03-28", 250, "2026-05-01"),
    f("2025-12-28", "2026-03-28", 110, "2026-05-01"),
    f("2025-09-28", "2026-06-27", 360, "2026-07-31"),
    f("2025-09-28", "2026-09-26", 480, "2026-11-03", "10-K"),
    // A restated prior year, filed later: wins.
    f("2024-09-29", "2025-09-27", 410, "2026-11-03", "10-K"),
  ];
  const s = durationSeries(facts);
  assert.deepEqual(
    s.quarters.map((q) => [q.end, q.value, Boolean(q.derived)]),
    [
      ["2025-12-27", 140, false],
      ["2026-03-28", 110, false],
      ["2026-06-27", 110, true],
      ["2026-09-26", 120, true],
    ],
  );
  assert.deepEqual(
    s.annual.map((a) => a.value),
    [410, 480],
  );
  assert.deepEqual(ttm(s), { value: 480, periodEnd: "2026-09-26", basis: "fiscal year" });
  // Mid-year: the sum of the last four quarters.
  const mid = durationSeries(facts.filter((x) => x.end <= "2026-06-27").concat([f("2025-06-29", "2025-09-27", 100, "2025-10-31", "10-K")]));
  assert.deepEqual(ttm(mid), { value: 100 + 140 + 110 + 110, periodEnd: "2026-06-27", basis: "sum of last 4 quarters" });
});

test("fundamentals: full tool from company facts plus Yahoo price", async () => {
  const usd = (rows: XbrlFact[]) => ({ units: { USD: rows } });
  const facts = {
    cik: 111,
    entityName: "TEST CORP",
    facts: {
      dei: {
        EntityCommonStockSharesOutstanding: {
          units: {
            shares: [
              { end: "2026-10-20", val: 900, accn: "a2", filed: "2026-11-03", form: "10-K" },
              { end: "2026-10-20", val: 100, accn: "a2", filed: "2026-11-03", form: "10-K" },
              { end: "2026-07-20", val: 990, accn: "a1", filed: "2026-07-31", form: "10-Q" },
            ],
          },
        },
      },
      "us-gaap": {
        Revenues: usd([f("2024-10-01", "2025-09-30", 1_000, "2025-11-01", "10-K"), f("2025-10-01", "2026-09-30", 1_200, "2026-11-03", "10-K"), f("2026-07-01", "2026-09-30", 330, "2026-11-03", "10-K")]),
        CostOfRevenue: usd([f("2025-10-01", "2026-09-30", 480, "2026-11-03", "10-K")]),
        OperatingIncomeLoss: usd([f("2025-10-01", "2026-09-30", 300, "2026-11-03", "10-K")]),
        NetIncomeLoss: usd([f("2025-10-01", "2026-09-30", 240, "2026-11-03", "10-K")]),
        DepreciationDepletionAndAmortization: usd([f("2025-10-01", "2026-09-30", 60, "2026-11-03", "10-K")]),
        EarningsPerShareDiluted: { units: { "USD/shares": [f("2025-10-01", "2026-09-30", 0.24, "2026-11-03", "10-K")] } },
        CashAndCashEquivalentsAtCarryingValue: usd([{ end: "2026-09-30", val: 100, accn: "a2", filed: "2026-11-03", form: "10-K" }]),
        LongTermDebt: usd([{ end: "2026-09-30", val: 300, accn: "a2", filed: "2026-11-03", form: "10-K" }]),
      },
    },
  };
  mockFetch([
    secTickers,
    ...yahooSession,
    [/companyfacts\/CIK0000000111\.json$/, () => json(facts)],
    [/v7\/finance\/quote\?symbols=TST/, () => json({ quoteResponse: { result: [{ symbol: "TST", currency: "USD", regularMarketPrice: 6, regularMarketTime: 1794603601 }] } })],
  ]);
  const r = await runDeskTool("fundamentals", { ticker: "TST" }, ctx);
  assert.equal(r.ok, true, r.content);
  const d = JSON.parse(r.content);
  assert.equal(d.revenue.ttm.value, 1_200);
  assert.equal(d.margins.ttm.grossPct, 60);
  assert.equal(d.margins.ttm.operatingPct, 25);
  assert.equal(d.margins.ttm.netPct, 20);
  assert.equal(d.shares.outstanding.shares, 1_000, "both share classes of the latest cover page");
  assert.equal(d.valuation.marketCap.value, 6_000);
  assert.equal(d.valuation.peTtm, 25);
  assert.equal(d.valuation.priceToSalesTtm, 5);
  assert.equal(d.valuation.enterpriseValue.value, 6_000 + 300 - 100);
  assert.equal(d.valuation.evToEbitdaTtm, round1(6_200 / 360));
  assert.match(d.units, /USD/);
});

const round1 = (x: number) => Math.round(x * 10) / 10;

test("fundamentals: a ticker SEC does not list", async () => {
  mockFetch([secTickers]);
  const r = await runDeskTool("fundamentals", { ticker: "SPY" }, ctx);
  assert.equal(r.ok, false);
  assert.match(JSON.parse(r.content).error, /not in SEC's list/);
});

/* ------------------------------------------------------------------ earnings */

test("earnings: archive and recent quarters merged, timing, next date", async () => {
  const cols = ["ticker", "eventname", "startdatetime", "startdatetimetype", "epsestimate", "epsactual", "epssurprisepct", "gmtOffsetMilliSeconds"].map((id) => ({ id }));
  mockFetch([
    ...yahooSession,
    [
      /visualization/,
      () =>
        json({
          finance: {
            result: [
              {
                documents: [
                  {
                    columns: cols,
                    rows: [
                      ["AAPL", " Annual Meeting", "2025-02-25T16:00:00.000Z", "TAS", null, null, null, -18000000],
                      ["AAPL", null, "2025-05-01T20:30:00.000Z", "TAS", 1.63, 1.65, 1.2, -14400000],
                      ["AAPL", null, "2025-01-30T21:30:00.000Z", "TAS", 2.35, 2.4, 2.1, -18000000],
                    ],
                  },
                ],
              },
            ],
          },
        }),
    ],
    [
      /quoteSummary\/AAPL\?modules=earnings,calendarEvents/,
      () =>
        json({
          quoteSummary: {
            result: [
              {
                earnings: {
                  earningsChart: {
                    quarterly: [
                      { fiscalQuarter: "4Q2026", actual: { raw: 2.1 }, estimate: { raw: 1.98483 }, periodEndDate: { fmt: "2026-09-30" }, reportedDate: { raw: 1793655000, fmt: "2026-11-02" } },
                      { fiscalQuarter: "3Q2026", actual: { raw: 2.02 }, estimate: { raw: 1.89243 }, reportedDate: { raw: 1785443428 } },
                    ],
                  },
                },
                calendarEvents: {
                  earnings: {
                    earningsDate: [{ raw: 1801170000 }],
                    isEarningsDateEstimate: true,
                    earningsAverage: { raw: 2.91057 },
                    earningsLow: { raw: 2.83 },
                    earningsHigh: { raw: 3.18 },
                    revenueAverage: { raw: 156429989490 },
                  },
                },
              },
            ],
          },
        }),
    ],
  ]);
  const r = await runDeskTool("earnings", { ticker: "AAPL" }, ctx);
  assert.equal(r.ok, true, r.content);
  const e = JSON.parse(r.content);
  assert.deepEqual(
    e.quarters.map((q: { date: string; time: string }) => [q.date, q.time]),
    [
      ["2026-11-02", "after_close"],
      ["2026-07-30", "after_close"],
      ["2025-05-01", "after_close"],
      ["2025-01-30", "after_close"],
    ],
  );
  assert.equal(e.quarters[0].surprisePct, 5.8);
  assert.equal(e.next.date, "2027-01-28");
  assert.equal(e.next.estimated, true);
  assert.equal(e.next.epsEstimate.average, 2.911);
  assert.ok(e.notes.some((n: string) => /missing/.test(n)), "flags the gap between the archive and the recent quarters");
});

/* ------------------------------------------------------------------ filings */

const AAPL_SUBS = {
  cik: "320193",
  name: "Apple Inc.",
  filings: {
    recent: {
      accessionNumber: ["0000320193-26-000030", "0001140361-26-042798", "0000320193-26-000024", "0000320193-26-000026", "0001140361-26-000001"],
      filingDate: ["2026-11-10", "2026-11-09", "2026-11-02", "2026-10-31", "2026-01-05"],
      reportDate: ["2026-11-06", "2026-11-05", "2026-11-02", "2026-09-26", ""],
      form: ["4", "8-K", "8-K", "10-K", "SC 13G/A"],
      items: ["", "8.01,9.01", "2.02,9.01", "", ""],
      primaryDocument: ["xslF345X05/wk-form4_1.xml", "ef20085077_8k.htm", "aapl-20261102.htm", "aapl-20260926.htm", "doc.htm"],
      primaryDocDescription: ["", "8-K", "8-K", "10-K", "SC 13G/A"],
    },
  },
};

test("filings: newest first, insider paperwork left out, 8-K items spelled out", async () => {
  mockFetch([secTickers, [/submissions\/CIK0000320193\.json$/, () => json(AAPL_SUBS)]]);
  const r = await runDeskTool("filings", { ticker: "AAPL" }, ctx);
  assert.equal(r.ok, true, r.content);
  const out = JSON.parse(r.content);
  assert.deepEqual(
    out.filings.map((x: { form: string }) => x.form),
    ["8-K", "8-K", "10-K", "SC 13G/A"],
  );
  assert.deepEqual(out.filings[1].items, ["2.02 Results of operations and financial condition", "9.01 Financial statements and exhibits"]);
  assert.equal(out.filings[1].url, "https://www.sec.gov/Archives/edgar/data/320193/000032019326000024/aapl-20261102.htm");
  assert.ok(out.notes.some((n: string) => /1 insider or routine/.test(n)));

  const only = JSON.parse((await runDeskTool("filings", { ticker: "AAPL", form: "SC 13G" }, ctx)).content);
  assert.deepEqual(
    only.filings.map((x: { form: string }) => x.form),
    ["SC 13G/A"],
  );
  const recent = JSON.parse((await runDeskTool("filings", { ticker: "AAPL", form: "4", days: 30 }, ctx)).content);
  assert.equal(recent.filings[0].url, "https://www.sec.gov/Archives/edgar/data/320193/000032019326000030/wk-form4_1.xml", "the raw XML beside the XSL view");
});

test("filings: full-text search goes to EDGAR FTS for this company, newest first", async () => {
  mockFetch([
    secTickers,
    [
      /efts\.sec\.gov\/LATEST\/search-index/,
      () =>
        json({
          hits: {
            total: { value: 2 },
            hits: [
              { _id: "0000320193-25-000057:aapl-20250329.htm", _source: { form: "10-Q", file_date: "2025-05-02", period_ending: "2025-03-29", file_description: "10-Q" } },
              { _id: "0000320193-26-000020:aapl-20260627.htm", _source: { form: "10-Q", file_date: "2026-07-31", period_ending: "2026-06-27", file_description: "10-Q" } },
            ],
          },
        }),
    ],
  ]);
  const r = await runDeskTool("filings", { ticker: "AAPL", query: '"tariffs"', form: "10-Q" }, ctx);
  assert.equal(r.ok, true, r.content);
  const out = JSON.parse(r.content);
  assert.equal(out.mode, "full-text search");
  assert.equal(out.filings[0].date, "2026-07-31");
  assert.equal(out.filings[0].url, "https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/aapl-20260627.htm");
  const fts = new URL(calls.find((u) => u.includes("efts"))!);
  assert.equal(fts.searchParams.get("ciks"), "0000320193");
  assert.equal(fts.searchParams.get("forms"), "10-Q,10-Q/A");
  assert.equal(fts.searchParams.get("q"), '"tariffs"');
  assert.equal(fts.searchParams.get("enddt"), "2026-11-13");
});

test("filing_text: only SEC archive URLs are fetched", async () => {
  mockFetch([]);
  for (const url of ["https://evil.example.com/x.htm", "https://www.sec.gov/cgi-bin/browse-edgar?action=x", "file:///etc/passwd", "https://www.sec.gov/Archives/edgar/data/320193/../../x"]) {
    const r = await runDeskTool("filing_text", { url }, ctx);
    assert.equal(r.ok, false, url);
  }
  assert.equal(calls.length, 0);
});

test("filing_text: the passage around the query, and the filing's exhibits", async () => {
  const filler = Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i} about nothing in particular, ordinary business text.</p>`).join("");
  const doc = `<html><body><p>FORM 8-K</p><p>Item 2.02 Results of Operations and Financial Condition.</p>${filler}<p>The Company expects revenue of $100 billion, plus or minus 2%.</p><p>Gross margins are expected to be 75%.</p>${filler}</body></html>`;
  const index = `<table class="tableFile"><tr><th>Seq</th></tr><tr><td>1</td><td>8-K</td><td><a href="/Archives/edgar/data/1045810/000104581026000073/nvda-20260826.htm">nvda-20260826.htm</a></td><td>8-K</td></tr><tr><td>2</td><td>EX-99.1</td><td><a href="/Archives/edgar/data/1045810/000104581026000073/q2fy27pr.htm">q2fy27pr.htm</a></td><td>EX-99.1</td></tr></table>`;
  mockFetch([
    [/nvda-20260826\.htm$/, () => text(doc)],
    [/0001045810-26-000073-index\.htm$/, () => text(index)],
  ]);
  const r = await runDeskTool("filing_text", { url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000073/nvda-20260826.htm", query: "revenue outlook gross margins" }, ctx);
  assert.equal(r.ok, true, r.content);
  const out = JSON.parse(r.content);
  assert.equal(out.matched, true);
  assert.match(out.excerpts.join("\n"), /expects revenue of \$100 billion/);
  assert.match(out.excerpts.join("\n"), /Gross margins are expected to be 75%/);
  assert.ok(out.excerpts.join("\n").length <= 6_000);
  assert.deepEqual(out.otherDocuments, [{ type: "EX-99.1", description: "EX-99.1", url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000073/q2fy27pr.htm" }]);
});

test("excerpt and index URL helpers", () => {
  assert.equal(
    filingIndexUrl("https://www.sec.gov/Archives/edgar/data/320193/000032019326000024/aapl-20261102.htm"),
    "https://www.sec.gov/Archives/edgar/data/320193/000032019326000024/0000320193-26-000024-index.htm",
  );
  const doc = ["Cover page", "Item 1A. Risk Factors", "Our supply chain depends on China.", "Unrelated text."].join("\n");
  const hit = excerpt(doc, "supply chain China", 200);
  assert.equal(hit.matched, true);
  assert.match(hit.excerpts[0]!, /supply chain depends on China/);
  const none = excerpt(doc, "zebra", 200);
  assert.equal(none.matched, false);
  assert.match(none.excerpts[0]!, /^Cover page/);
});

/* ------------------------------------------------------------------ insiders */

function form4(o: { owner: string; name: string; director?: boolean; officer?: string; code: "P" | "S" | "M"; shares: number; price: number; date: string; plan?: boolean; footnote?: string }) {
  return `<?xml version="1.0"?><ownershipDocument><documentType>4</documentType>
<issuer><issuerCik>0000000111</issuerCik><issuerName>TEST CORP</issuerName><issuerTradingSymbol>TST</issuerTradingSymbol></issuer>
<reportingOwner><reportingOwnerId><rptOwnerCik>${o.owner}</rptOwnerCik><rptOwnerName>${o.name}</rptOwnerName></reportingOwnerId>
<reportingOwnerRelationship><isDirector>${o.director ? 1 : 0}</isDirector><isOfficer>${o.officer ? 1 : 0}</isOfficer>${o.officer ? `<officerTitle>${o.officer}</officerTitle>` : ""}</reportingOwnerRelationship></reportingOwner>
${o.plan === undefined ? "" : `<aff10b5One>${o.plan ? 1 : 0}</aff10b5One>`}
<nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>${o.date}</value></transactionDate>
<transactionCoding><transactionCode>${o.code}</transactionCode>${o.footnote ? '<footnoteId id="F1"/>' : ""}</transactionCoding>
<transactionAmounts><transactionShares><value>${o.shares}</value></transactionShares><transactionPricePerShare><value>${o.price}</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>${o.code === "S" ? "D" : "A"}</value></transactionAcquiredDisposedCode></transactionAmounts>
<postTransactionAmounts><sharesOwnedFollowingTransaction><value>50000</value></sharesOwnedFollowingTransaction></postTransactionAmounts></nonDerivativeTransaction></nonDerivativeTable>
${o.footnote ? `<footnotes><footnote id="F1">${o.footnote}</footnote></footnotes>` : ""}</ownershipDocument>`;
}

test("insiders: cluster of buyers flagged; 10b5-1 and routine trades set aside", async () => {
  const docs: Record<string, string> = {
    a1: form4({ owner: "0000000201", name: "SMITH JOHN A", officer: "CEO", code: "P", shares: 10_000, price: 20, date: "2026-11-02", plan: false }),
    a2: form4({ owner: "0000000202", name: "DOE JANE", director: true, code: "P", shares: 2_000, price: 21, date: "2026-11-04" }),
    a3: form4({ owner: "0000000203", name: "ROE RICHARD", director: true, code: "P", shares: 1_000, price: 21.5, date: "2026-11-06" }),
    a4: form4({ owner: "0000000204", name: "PLAN PAT", officer: "CFO", code: "S", shares: 5_000, price: 22, date: "2026-11-05", plan: true }),
    a5: form4({ owner: "0000000205", name: "HABIT HAL", director: true, code: "S", shares: 3_000, price: 22, date: "2026-11-05", footnote: "Sold to cover taxes." }),
    a6: form4({ owner: "0000000201", name: "SMITH JOHN A", officer: "CEO", code: "M", shares: 500, price: 0, date: "2026-11-03" }),
  };
  const accs = Object.keys(docs);
  const issuerSubs = {
    cik: "111",
    name: "TEST CORP",
    filings: {
      recent: {
        accessionNumber: accs.map((a, i) => `0000000111-26-00000${i}`),
        filingDate: ["2026-11-03", "2026-11-05", "2026-11-09", "2026-11-06", "2026-11-06", "2026-11-04"],
        form: accs.map(() => "4"),
        primaryDocument: accs.map((a) => `xslF345X05/${a}.xml`),
      },
    },
  };
  const ownerSubs = (cik: string) => {
    // Hal files a Form 4 every November; the others never filed before.
    const dates = cik === "0000000205" ? ["2025-11-04", "2024-11-06", "2023-11-07", "2026-05-01"] : ["2026-11-03"];
    return { cik, name: "x", filings: { recent: { accessionNumber: dates.map((_, i) => `x-${i}`), filingDate: dates, form: dates.map(() => "4") } } };
  };
  mockFetch([
    secTickers,
    [/submissions\/CIK0000000111\.json$/, () => json(issuerSubs)],
    [/submissions\/CIK(\d{10})\.json$/, (url) => json(ownerSubs(/CIK(\d{10})/.exec(url)![1]!))],
    [/\/Archives\/edgar\/data\/111\/\d{18}\/(a\d)\.xml$/, (url) => text(docs[/(a\d)\.xml$/.exec(url)![1]!]!)],
  ]);
  const r = await runDeskTool("insiders", { ticker: "TST", days: 90 }, ctx);
  assert.equal(r.ok, true, r.content);
  const out = JSON.parse(r.content);
  assert.equal(out.form4Read, 6);
  assert.deepEqual(out.opportunistic.purchases, { trades: 3, insiders: 3, valueUsd: 200_000 + 42_000 + 21_500 });
  assert.deepEqual(out.opportunistic.sales, { trades: 0, insiders: 0, valueUsd: 0 });
  assert.equal(out.clusters.length, 1);
  assert.deepEqual(out.clusters[0], { kind: "buy", from: "2026-11-02", to: "2026-11-06", insiders: ["John A Smith", "Jane Doe", "Richard Roe"], valueUsd: 263_500 });
  assert.deepEqual(out.largeOfficerDirectorPurchases, [{ insider: "John A Smith", role: "CEO", date: "2026-11-02", valueUsd: 200_000 }]);
  assert.equal(out.setAside["10b5-1 plan"].trades, 1);
  assert.equal(out.setAside["routine insider (trades this month every year)"].trades, 1);
  assert.deepEqual(out.otherTransactionCodes, { M: 1 });
  assert.equal(out.insiders[0].name, "John A Smith");
  assert.equal(out.insiders[0].bought.avgPrice, 20);
});

test("routine rule (CMP): same month in each of the 3 prior years", () => {
  assert.equal(isRoutine(["2025-11-01", "2024-11-20", "2023-11-02"], "2026-11", null), true);
  assert.equal(isRoutine(["2025-11-01", "2023-11-02"], "2026-11", null), false);
  // A list cut short before the years it would need: cannot tell.
  assert.equal(isRoutine(["2025-11-01"], "2026-11", "2025-01-15"), null);
});
