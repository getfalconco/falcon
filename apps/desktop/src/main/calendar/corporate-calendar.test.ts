import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CorporateCalendarRaw } from "../../shared/briefing-types";
import { buildCorporateCalendar, corporateEventsOf } from "./corporate-calendar";
import { sectorFromRead } from "./sector-cache";

function raw(overrides: Partial<CorporateCalendarRaw> = {}): CorporateCalendarRaw {
  return {
    symbol: "AAPL",
    available: true,
    ex_dividend_date: null,
    dividend_date: null,
    dividend_rate: null,
    earnings_dates: [],
    earnings_estimated: null,
    recent_dividends: [],
    recent_splits: [],
    ...overrides,
  };
}

describe("corporateEventsOf", () => {
  it("turns an estimated window into one event on its first day", () => {
    const events = corporateEventsOf(raw({ earnings_dates: ["2026-11-03", "2026-10-28"], earnings_estimated: true }));
    assert.equal(events.length, 1);
    assert.equal(events[0].date, "2026-10-28");
    assert.equal(events[0].estimated, true);
    assert.match(events[0].detail ?? "", /Oct 28 to Nov 3/);
  });

  it("reads a single confirmed date as not estimated", () => {
    const [e] = corporateEventsOf(raw({ earnings_dates: ["2026-10-30"], earnings_estimated: false }));
    assert.equal(e.estimated, false);
    assert.equal(e.id, "earn:AAPL:2026-10-30");
  });

  it("merges the price history's amount into the calendar's ex-date", () => {
    const events = corporateEventsOf(
      raw({ ex_dividend_date: "2026-08-11", dividend_rate: 1.04, recent_dividends: [{ date: "2026-08-11", amount: 0.26 }] }),
    );
    const divs = events.filter((e) => e.kind === "ex_dividend");
    assert.equal(divs.length, 1);
    assert.match(divs[0].detail ?? "", /^\$0\.26 per share\. Indicated annual rate \$1\.04/);
  });

  it("lists payments and splits, skipping malformed rows", () => {
    const events = corporateEventsOf(
      raw({
        dividend_date: "2026-08-14",
        recent_splits: [
          { date: "2026-09-02", numerator: 1, denominator: 10 },
          { date: "not-a-date", numerator: 4, denominator: 1 },
          { date: "2026-09-03", numerator: 0, denominator: 1 },
        ],
      }),
    );
    assert.deepEqual(events.map((e) => e.kind).sort(), ["dividend_payment", "split"]);
    assert.equal(events.find((e) => e.kind === "split")?.title, "AAPL 1-for-10 reverse split");
  });
});

describe("corporateEventsOf words", () => {
  it("sends each row's wording as codes with raw dates and amounts", () => {
    const events = corporateEventsOf(
      raw({
        earnings_dates: ["2026-10-28", "2026-11-03"],
        ex_dividend_date: "2026-08-11",
        dividend_rate: 1.04,
        dividend_date: "2026-08-14",
        recent_dividends: [{ date: "2026-08-11", amount: 0.26 }, { date: "2026-05-11", amount: null as unknown as number }],
        recent_splits: [{ date: "2026-09-02", numerator: 4, denominator: 1 }],
      }),
    );
    const by = (id: string) => events.find((e) => e.id === id)?.words;
    assert.deepEqual(by("earn:AAPL:2026-10-28"), {
      title: { code: "earnings", params: { ticker: "AAPL" } },
      detail: [{ code: "earningsWindow", params: { from: "2026-10-28", to: "2026-11-03" } }],
    });
    assert.deepEqual(by("div:AAPL:2026-08-11")?.detail, [
      { code: "perShare", params: { amount: 0.26 } },
      { code: "indicatedRate", params: { amount: 1.04 } },
      { code: "heldBefore" },
    ]);
    assert.deepEqual(by("div:AAPL:2026-05-11")?.detail, [{ code: "distributionWentEx" }]);
    assert.deepEqual(by("pay:AAPL:2026-08-14"), { title: { code: "dividendPayment", params: { ticker: "AAPL" } }, detail: [{ code: "payment" }] });
    assert.deepEqual(by("split:AAPL:2026-09-02")?.title, { code: "split", params: { ticker: "AAPL", num: 4, den: 1 } });
  });

  it("keeps the English beside the codes", () => {
    const [e] = corporateEventsOf(raw({ earnings_dates: ["2026-10-30"], earnings_estimated: false }));
    assert.equal(e.title, "AAPL earnings report");
    assert.equal(e.detail, "Date from the data provider. The hour is not given.");
    assert.deepEqual(e.words?.detail, [{ code: "earningsDated" }]);
  });
});

describe("buildCorporateCalendar", () => {
  it("keeps the names that answered when one fails", async () => {
    const outcome = await buildCorporateCalendar(["AAPL", "BAD", "SPY"], {
      corporate: async (s) => {
        if (s === "BAD") throw new Error("provider said no");
        return raw({ symbol: s, earnings_dates: s === "AAPL" ? ["2026-10-30"] : [] });
      },
      sector: async (s) => {
        if (s === "SPY") throw new Error("no profile");
        return s === "AAPL" ? "Technology" : null;
      },
    });
    assert.deepEqual(outcome.unavailable, ["BAD"]);
    assert.deepEqual(outcome.sectors, { AAPL: "Technology", BAD: null, SPY: null });
    assert.deepEqual(outcome.events.map((e) => e.id), ["earn:AAPL:2026-10-30"]);
  });

  it("never runs more reads at once than asked", async () => {
    let running = 0;
    let peak = 0;
    const symbols = Array.from({ length: 9 }, (_, i) => `S${i}`);
    await buildCorporateCalendar(symbols, {
      concurrency: 2,
      corporate: async (s) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return raw({ symbol: s });
      },
      sector: async () => null,
    });
    assert.equal(peak, 2);
  });
});

describe("sectorFromRead", () => {
  it("files funds together and maps provider vocabularies", () => {
    assert.equal(sectorFromRead({ sector: null, industry: null, quoteType: "ETF" }), "Funds & ETFs");
    assert.equal(sectorFromRead({ sector: "Financial Services", industry: "Banks", quoteType: "EQUITY" }), "Financials");
    assert.equal(sectorFromRead({ sector: "Consumer Cyclical", industry: null, quoteType: "EQUITY" }), "Consumer Discretionary");
    assert.equal(sectorFromRead({ sector: null, industry: "Semiconductors", quoteType: null }), "Technology");
    assert.equal(sectorFromRead({ sector: null, industry: null, quoteType: "EQUITY" }), null);
  });
});
