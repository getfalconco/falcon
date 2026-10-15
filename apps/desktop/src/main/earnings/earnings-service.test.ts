import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { CalendarSector } from "../../shared/calendar-events";
import { parseEarningsRequest, type EarningsResult } from "../../shared/earnings-types";
import { degradedNoticeable } from "../../shared/earnings-view";
import { CAPS_TTL_MS, DETAILS_NEAR_TTL_MS, MARKET_RETRY_MS, MARKET_TTL_MS, addDays, createEarningsService, nyToday, type EarningsServiceDeps } from "./earnings-service";

const NOW = Date.parse("2026-10-15T14:00:00Z");
const TODAY = "2026-10-15";

type Line = { symbol: string; date: string; hour?: string; quarter?: number; year?: number; epsEstimate?: number | null; revenueEstimate?: number | null };

const MARKET: Line[] = [
  { symbol: "NVDA", date: "2026-11-05", hour: "amc", quarter: 3, year: 2026, epsEstimate: 1.1, revenueEstimate: 50e9 },
  { symbol: "IBM", date: "2026-10-21", hour: "amc", quarter: 3, year: 2026, epsEstimate: 2.9, revenueEstimate: 17e9 },
  { symbol: "TSLA", date: "2026-10-21", hour: "amc", quarter: 3, year: 2026, epsEstimate: 0.45, revenueEstimate: 28e9 },
  { symbol: "ZZZZ", date: "2026-10-16", hour: "" },
  { symbol: "XOM", date: "2026-10-23", hour: "" },
];

const YAHOO: Record<string, Record<string, unknown> | null> = {
  NVDA: {
    calendarEvents: { earnings: { earningsDate: [{ raw: 1793918400, fmt: "2026-11-05" }], isEarningsDateEstimate: false, earningsAverage: { raw: 1.12 } } },
    earningsHistory: { history: [{ epsActual: { raw: 1.05 }, epsEstimate: { raw: 1.0 }, surprisePercent: { raw: 0.05 }, quarter: { fmt: "2026-07-31" } }] },
  },
  XOM: {
    calendarEvents: { earnings: { earningsDate: [{ raw: 1793363400, fmt: "2026-10-30" }], isEarningsDateEstimate: false } },
  },
  AAPL: { calendarEvents: { earnings: { earningsDate: [{ fmt: "2026-10-29" }, { fmt: "2026-11-02" }], isEarningsDateEstimate: true } } },
  SPY: { calendarEvents: {} },
};

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(over: Partial<EarningsServiceDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earnings-"));
  dirs.push(dir);
  const calls = { market: 0, yahoo: [] as string[], sector: [] as string[], tracked: 0 };
  let now = NOW;
  const deps: EarningsServiceDeps = {
    dir,
    fetchMarketCalendar: async (from, to) => {
      calls.market++;
      return { earningsCalendar: MARKET.filter((m) => m.date >= from && m.date <= to) };
    },
    marketConfigured: () => true,
    fetchYahoo: async (symbol) => {
      calls.yahoo.push(symbol);
      if (symbol === "FAIL") throw new Error("down");
      return YAHOO[symbol] ?? null;
    },
    sector: async (symbol) => {
      calls.sector.push(symbol);
      return (symbol === "NVDA" ? "Technology" : symbol === "XOM" ? "Energy" : null) as CalendarSector | null;
    },
    peekSector: (symbol) => (symbol === "TSLA" ? "Consumer Discretionary" : undefined),
    companyNames: async () => new Map([["NVDA", "NVIDIA"], ["IBM", "International Business Machines"], ["TSLA", "Tesla"], ["XOM", "Exxon Mobil"], ["AAPL", "Apple"]]),
    trackedUniverse: async () => {
      calls.tracked++;
      return ["NVDA", "IBM", "XOM"];
    },
    now: () => now,
    pauseMs: 0,
    sleep: async () => {},
    ...over,
  };
  const service = createEarningsService(deps);
  return { service, calls, dir, advance: (ms: number) => (now += ms) };
}

const ask = (raw: unknown) => parseEarningsRequest(raw)!;

function ok(result: EarningsResult) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<EarningsResult, { ok: true }>;
}

describe("dates", () => {
  it("today is New York's", () => {
    assert.equal(nyToday(Date.parse("2026-10-16T03:00:00Z")), "2026-10-15");
    assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  });
});

describe("the request", () => {
  it("takes a scope, clamps the days and cleans the names", () => {
    assert.deepEqual(parseEarningsRequest({ scope: "mine", days: 99, held: ["nvda", " xom ", "nvda", "$$"] }), {
      scope: "mine",
      days: 42,
      held: ["NVDA", "XOM"],
      watchlist: [],
      sectors: [],
    });
    assert.equal(parseEarningsRequest({ scope: "everyone" }), null);
    assert.equal(parseEarningsRequest({ scope: "mine", held: "NVDA" }), null);
    assert.equal(parseEarningsRequest(null), null);
  });
});

describe("my names", () => {
  it("lists the reader's names in the window, with every field a provider gave", async () => {
    const { service } = setup();
    const res = ok(await service.upcoming(ask({ scope: "mine", held: ["NVDA", "XOM", "SPY"], watchlist: ["AAPL", "IBM"] })));
    // The window runs from Monday of this week, so reports already out are listed.
    assert.equal(res.from, "2026-10-12");
    assert.equal(res.today, TODAY);
    assert.equal(res.to, "2026-11-11");
    assert.deepEqual(
      res.rows.map((r) => [r.ticker, r.date, r.time, r.status]),
      [
        ["IBM", "2026-10-21", "amc", "unknown"],
        ["AAPL", "2026-10-29", "unknown", "estimated"],
        ["XOM", "2026-10-30", "bmo", "confirmed"],
        ["NVDA", "2026-11-05", "amc", "confirmed"],
      ],
    );
    const nvda = res.rows.find((r) => r.ticker === "NVDA")!;
    assert.equal(nvda.company, "NVIDIA");
    assert.equal(nvda.sector, "Technology");
    assert.equal(nvda.epsEstimate, 1.12);
    assert.equal(nvda.revenueEstimate, 50e9);
    assert.deepEqual(nvda.lastSurprise, { quarterEnd: "2026-07-31", epsActual: 1.05, epsEstimate: 1.0, surprisePct: 5 });
    assert.deepEqual([nvda.held, nvda.watchlist, nvda.tracked], [true, false, true]);
    const aapl = res.rows.find((r) => r.ticker === "AAPL")!;
    assert.deepEqual([aapl.windowEnd, aapl.epsEstimate, aapl.lastSurprise, aapl.watchlist], ["2026-11-02", null, null, true]);
    assert.equal(res.marketCalendar, "fresh");
    assert.deepEqual(res.scopes, { tracked: true, all: true });
  });

  it("a name that cannot be read is named, and the rest stand", async () => {
    const { service } = setup();
    const res = ok(await service.upcoming(ask({ scope: "mine", held: ["NVDA", "FAIL"] })));
    assert.deepEqual(res.unavailable, ["FAIL"]);
    assert.deepEqual(res.rows.map((r) => r.ticker), ["NVDA"]);
  });

  it("works with no market calendar, without hours it cannot know", async () => {
    const { service } = setup({ marketConfigured: () => false });
    const res = ok(await service.upcoming(ask({ scope: "mine", held: ["NVDA", "IBM"] })));
    assert.equal(res.marketCalendar, "missing");
    assert.deepEqual(res.rows.map((r) => [r.ticker, r.time, r.revenueEstimate]), [["NVDA", "amc", null]]);
    assert.equal(res.scopes.all, false);
  });
});

describe("scopes", () => {
  it("tracked lists the covered universe", async () => {
    const { service } = setup();
    const res = ok(await service.upcoming(ask({ scope: "tracked", held: ["NVDA"] })));
    assert.deepEqual(res.rows.map((r) => r.ticker), ["IBM", "XOM", "NVDA"]);
    assert.ok(res.rows.every((r) => r.tracked));
  });

  it("tracked is unavailable when the universe was never read", async () => {
    const { service } = setup({ trackedUniverse: async () => Promise.reject(new Error("engine down")) });
    assert.deepEqual(await service.upcoming(ask({ scope: "tracked" })), { ok: false, error: "scope_unavailable" });
    const mine = ok(await service.upcoming(ask({ scope: "mine", held: ["NVDA"] })));
    assert.equal(mine.scopes.tracked, false);
  });

  it("all is the market calendar, listed names only, details only for the reader's and covered names", async () => {
    const { service, calls } = setup();
    const res = ok(await service.upcoming(ask({ scope: "all", held: ["AAPL"] })));
    // ZZZZ is not in the listing directory.
    assert.deepEqual(res.rows.map((r) => r.ticker), ["IBM", "TSLA", "AAPL", "XOM", "NVDA"]);
    assert.deepEqual([...calls.yahoo].sort(), ["AAPL", "IBM", "NVDA", "XOM"]);
    const tsla = res.rows.find((r) => r.ticker === "TSLA")!;
    assert.deepEqual([tsla.status, tsla.sector, tsla.lastSurprise], ["unknown", "Consumer Discretionary", null]);
    assert.ok(!calls.sector.includes("TSLA"));
  });

  it("all is unavailable without a market calendar", async () => {
    const { service } = setup({ marketConfigured: () => false });
    assert.deepEqual(await service.upcoming(ask({ scope: "all" })), { ok: false, error: "scope_unavailable" });
  });
});

describe("caching", () => {
  it("reads the market calendar once per six hours, in week pieces", async () => {
    const { service, calls, advance } = setup();
    await service.upcoming(ask({ scope: "mine", held: ["NVDA"] }));
    // Six weeks in seven-day pieces, and one read of Monday to yesterday.
    assert.equal(calls.market, 7);
    advance(3 * 60_000);
    await service.upcoming(ask({ scope: "mine", held: ["XOM"] }));
    assert.equal(calls.market, 7);
    advance(MARKET_TTL_MS);
    await service.upcoming(ask({ scope: "mine", held: ["IBM"] }));
    assert.equal(calls.market, 14);
  });

  it("splits a piece the provider cut short", async () => {
    let pieces = 0;
    const { service } = setup({
      fetchMarketCalendar: async (from, to) => {
        pieces++;
        const span = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
        // The first week comes back cut until it is asked for in halves.
        if (from === TODAY && span > 4) return { earningsCalendar: Array.from({ length: 1500 }, () => ({ symbol: "IBM", date: "2026-10-21" })) };
        return { earningsCalendar: MARKET.filter((m) => m.date >= from && m.date <= to) };
      },
    });
    const res = ok(await service.upcoming(ask({ scope: "all" })));
    // Eight pieces for the six weeks ahead, one for this week so far.
    assert.equal(pieces, 9);
    assert.ok(res.rows.some((r) => r.ticker === "TSLA"));
  });

  it("a failed market read keeps the older copy and waits before trying again", async () => {
    let fail = false;
    let reads = 0;
    const { service, advance } = setup({
      fetchMarketCalendar: async (from, to) => {
        reads++;
        if (fail) throw new Error("429");
        return { earningsCalendar: MARKET.filter((m) => m.date >= from && m.date <= to) };
      },
    });
    await service.upcoming(ask({ scope: "all" }));
    fail = true;
    advance(MARKET_TTL_MS + 1);
    const stale = ok(await service.upcoming(ask({ scope: "all" })));
    assert.equal(stale.marketCalendar, "stale");
    assert.ok(stale.rows.length > 0);
    const before = reads;
    advance(5 * 60_000);
    await service.upcoming(ask({ scope: "all", held: ["IBM"] }));
    assert.equal(reads, before);
    advance(MARKET_RETRY_MS);
    await service.upcoming(ask({ scope: "all", held: ["XOM"] }));
    assert.ok(reads > before);
  });

  it("keeps the details on disk across a restart", async () => {
    const first = setup();
    await first.service.upcoming(ask({ scope: "mine", held: ["NVDA"] }));
    first.service.flush();
    assert.ok(fs.existsSync(path.join(first.dir, "details.json")));
    assert.ok(fs.existsSync(path.join(first.dir, "market-calendar.json")));

    const calls: string[] = [];
    let market = 0;
    const second = createEarningsService({
      ...setupDeps(first.dir),
      fetchYahoo: async (s) => {
        calls.push(s);
        return null;
      },
      fetchMarketCalendar: async () => {
        market++;
        return { earningsCalendar: [] };
      },
    });
    const res = ok(await second.upcoming(ask({ scope: "mine", held: ["NVDA"] })));
    assert.deepEqual(calls, []);
    assert.equal(market, 0);
    assert.equal(res.rows[0]?.status, "confirmed");
  });

  it("shares one build between callers asking the same thing", async () => {
    const { service, calls } = setup();
    const req = ask({ scope: "mine", held: ["NVDA"] });
    const [a, b] = await Promise.all([service.upcoming(req), service.upcoming(req)]);
    assert.equal(a, b);
    assert.deepEqual(calls.yahoo, ["NVDA"]);
  });
});

function setupDeps(dir: string): EarningsServiceDeps {
  return {
    dir,
    fetchMarketCalendar: async () => ({ earningsCalendar: [] }),
    marketConfigured: () => true,
    fetchYahoo: async () => null,
    sector: async () => null,
    peekSector: () => undefined,
    companyNames: async () => new Map(),
    trackedUniverse: async () => ["NVDA"],
    now: () => NOW + 60_000,
    pauseMs: 0,
    sleep: async () => {},
  };
}

// ---------------------------------------------------------------------------
// v2: this week's reports, the kept consensus, dollars, filing links
// ---------------------------------------------------------------------------

/** TSM before its release (Q3's consensus) and after it (Yahoo rolled to Q4). */
const TSM_BEFORE = {
  calendarEvents: { earnings: { earningsDate: [{ raw: 1792067400, fmt: "2026-10-15" }], isEarningsDateEstimate: false, earningsAverage: { raw: 4.52449 }, revenueAverage: { raw: 1_486_000_000_000 } } },
  earningsTrend: { trend: [{ period: "0q", endDate: "2026-09-30", earningsEstimate: { numberOfAnalysts: { raw: 9 }, earningsCurrency: "USD" }, revenueEstimate: { revenueCurrency: "TWD" } }] },
  earnings: {
    financialCurrency: "TWD",
    earningsChart: { quarterly: [{ date: "2Q2026", actual: { raw: 4.31 }, estimate: { raw: 3.88 }, periodEndDate: { fmt: "2026-06-30" }, reportedDate: { raw: 1784160000, fmt: "2026-07-16" } }] },
  },
};
const TSM_AFTER = {
  calendarEvents: { earnings: { earningsDate: [{ raw: 1792067400, fmt: "2026-10-15" }], isEarningsDateEstimate: false, earningsAverage: { raw: 5.07666 }, revenueAverage: { raw: 1_700_416_107_420 } } },
  earningsTrend: { trend: [{ period: "0q", endDate: "2026-12-31", earningsEstimate: { numberOfAnalysts: { raw: 8 }, earningsCurrency: "USD" }, revenueEstimate: { revenueCurrency: "TWD" } }] },
  earnings: {
    financialCurrency: "TWD",
    earningsChart: {
      quarterly: [
        { date: "2Q2026", actual: { raw: 4.31 }, estimate: { raw: 3.88 }, periodEndDate: { fmt: "2026-06-30" }, reportedDate: { raw: 1784160000, fmt: "2026-07-16" } },
        { date: "3Q2026", fiscalQuarter: "3Q2026", actual: { raw: 4.6 }, estimate: { raw: 4.52449 }, periodEndDate: { fmt: "2026-09-30" }, reportedDate: { raw: 1792044507, fmt: "2026-10-15" } },
      ],
    },
    financialsChart: { quarterly: [{ date: "3Q2026", revenue: { raw: 1_494_243_000_000 } }] },
  },
};

describe("this week", () => {
  it("lists reports already out this week, from the half-hourly read of Monday to yesterday", async () => {
    const lines = [{ symbol: "JPM", date: "2026-10-13", hour: "bmo", quarter: 3, year: 2026, epsEstimate: 5.958, epsActual: 5.57, revenueEstimate: 51.7e9, revenueActual: 50.9e9 }, ...MARKET];
    const asked: Array<[string, string]> = [];
    const { service } = setup({
      fetchMarketCalendar: async (from, to) => {
        asked.push([from, to]);
        return { earningsCalendar: lines.filter((m) => m.date >= from && m.date <= to) };
      },
    });
    const res = ok(await service.upcoming(ask({ scope: "mine", held: ["JPM"] })));
    assert.equal(res.from, "2026-10-12");
    assert.equal(res.today, TODAY);
    assert.ok(asked.some(([f, t]) => f === "2026-10-12" && t === "2026-10-14"), JSON.stringify(asked));
    const jpm = res.rows.find((r) => r.ticker === "JPM")!;
    assert.deepEqual([jpm.phase, jpm.date, jpm.epsActual, jpm.epsEstimate, jpm.revenueActual], ["reported", "2026-10-13", 5.57, 5.958, 50.9e9]);
  });

  it("keeps the consensus before a release, so the reported row is not judged against the next quarter's", async () => {
    let tsm: Record<string, unknown> = TSM_BEFORE;
    const fx: Array<[string | null, string]> = [];
    const { service, advance } = setup({
      fetchYahoo: async (symbol) => (symbol === "TSM" ? tsm : null),
      fxRate: async (currency, ymd) => {
        fx.push([currency, ymd]);
        return currency === "TWD" ? { currency, rate: 0.03087, asOf: ymd } : null;
      },
    });
    // Thursday 10:00: due before the open, the release not yet on Yahoo's record; Q3's consensus.
    const before = ok(await service.upcoming(ask({ scope: "mine", watchlist: ["TSM"] })));
    const up = before.rows.find((r) => r.ticker === "TSM")!;
    assert.deepEqual([up.phase, up.epsEstimate, up.revenueEstimate, up.revenueCurrency], ["pending", 4.52449, 1_486_000_000_000, "TWD"]);
    assert.equal(up.revenueEstimateUsd, Math.round(1_486_000_000_000 * 0.03087));
    assert.deepEqual(up.fx, { currency: "TWD", rate: 0.03087, asOf: TODAY });

    // After the release Yahoo shows Q4's consensus on the same date.
    tsm = TSM_AFTER;
    advance(7 * 60 * 60_000);
    const after = ok(await service.upcoming(ask({ scope: "mine", watchlist: ["TSM"] })));
    const out = after.rows.find((r) => r.ticker === "TSM")!;
    assert.equal(out.phase, "reported");
    assert.equal(out.epsActual, 4.6);
    assert.equal(out.epsEstimate, 4.52449);
    assert.equal(out.revenueEstimate, 1_486_000_000_000, "the kept consensus, not 1.70T");
    assert.equal(out.revenueActual, 1_494_243_000_000);
    assert.equal(out.revenueActualUsd, Math.round(1_494_243_000_000 * 0.03087));
    // A reported row is converted at the close of its release day.
    assert.deepEqual(fx.at(-1), ["TWD", "2026-10-15"]);
  });

  it("asks a name due today again after twenty minutes until its release is on record", async () => {
    const { service, calls, advance } = setup({ fetchYahoo: async (symbol) => (calls.yahoo.push(symbol), symbol === "TSM" ? TSM_BEFORE : null) });
    await service.upcoming(ask({ scope: "mine", watchlist: ["TSM"] }));
    advance(DETAILS_NEAR_TTL_MS + 60_000);
    await service.upcoming(ask({ scope: "mine", watchlist: ["TSM"], held: ["X"] }));
    assert.equal(calls.yahoo.filter((s) => s === "TSM").length, 2);
  });
});

describe("filing links", () => {
  const edge = (root: string, other: string, over: Record<string, unknown> = {}) => ({
    root_ticker: root,
    counterparty_ticker: other,
    category: "supplier",
    strength_tier: "important",
    confidence: 0.95,
    evidence_quote: "We rely on TSMC.",
    source_url: "https://www.sec.gov/Archives/edgar/data/1/x.htm",
    accession_number: "0000000000-26-000001",
    filing_date: "2026-02-25",
    ...over,
  });

  it("marks the reader's names a filing links to the reporting company", async () => {
    const { service } = setup({
      graphEdges: async () => [edge("NVDA", "IBM"), edge("IBM", "XOM", { category: "customer" }), edge("IBM", "AAPL", { strength_tier: "marginal" })],
      filingForm: (t) => (t === "NVDA" ? "10-K" : null),
    });
    const res = ok(await service.upcoming(ask({ scope: "mine", held: ["NVDA", "XOM"], watchlist: ["AAPL", "IBM"] })));
    const ibm = res.rows.find((r) => r.ticker === "IBM")!;
    assert.deepEqual(
      ibm.readsThrough.map((l) => [l.ticker, l.category, l.namedBy, l.form]),
      [
        ["NVDA", "supplier", "NVDA", "10-K"],
        ["XOM", "customer", "IBM", null],
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// "For you"
// ---------------------------------------------------------------------------

describe("for you", () => {
  const EXTRA = [
    { symbol: "KO", date: "2026-10-27", hour: "bmo", quarter: 3, year: 2026, epsEstimate: 0.8, revenueEstimate: 13e9 },
    { symbol: "SMALL", date: "2026-10-27", hour: "bmo", quarter: 3, year: 2026, epsEstimate: 0.1, revenueEstimate: 50e6 },
    { symbol: "MIDE", date: "2026-10-28", hour: "amc", quarter: 3, year: 2026, epsEstimate: 1.1, revenueEstimate: 2e9 },
  ];
  const CAPS: Record<string, number> = { IBM: 230e9, TSLA: 900e9, KO: 400e9, MIDE: 20e9, SMALL: 2e9 };
  const SECTORS: Record<string, CalendarSector> = { NVDA: "Technology", XOM: "Energy", IBM: "Technology", MIDE: "Energy", KO: "Consumer Staples" };
  const link = (root: string, other: string) => ({
    root_ticker: root,
    counterparty_ticker: other,
    category: "supplier",
    strength_tier: "important",
    confidence: 0.95,
    evidence_quote: "Named in the filing.",
    source_url: "https://www.sec.gov/Archives/edgar/data/1/x.htm",
    accession_number: "0000000000-26-000001",
  });

  function forYouSetup(over: Partial<EarningsServiceDeps> = {}) {
    const capCalls: string[][] = [];
    const ctx = setup({
      fetchMarketCalendar: async (from, to) => ({ earningsCalendar: [...MARKET, ...EXTRA].filter((m) => m.date >= from && m.date <= to) }),
      companyNames: async () => new Map(["NVDA", "IBM", "TSLA", "XOM", "KO", "SMALL", "MIDE", "ZZZZ"].map((t) => [t, t] as const)),
      sector: async (symbol) => SECTORS[symbol] ?? null,
      peekSector: () => undefined,
      fetchMarketCaps: async (symbols) => {
        capCalls.push([...symbols]);
        return Object.fromEntries(symbols.filter((s) => CAPS[s] !== undefined).map((s) => [s, CAPS[s]!]));
      },
      graphEdges: async () => [link("NVDA", "TSLA")],
      ...over,
    });
    return { ...ctx, capCalls };
  }

  it("lists the reader's names, then linked companies, sector fits and large caps, each once with its reason", async () => {
    const { service } = forYouSetup();
    const res = ok(await service.upcoming(ask({ scope: "foryou", held: ["NVDA"], watchlist: ["XOM"], sectors: ["Technology"] })));
    const reasons = Object.fromEntries(res.rows.map((r) => [r.ticker, r.reason]));
    assert.deepEqual(reasons, { NVDA: "held", XOM: "watchlist", TSLA: "linked", IBM: "sector", KO: "large" });
    assert.equal(new Set(res.rows.map((r) => r.ticker)).size, res.rows.length, "each company once");
    // The same day keeps the order of reasons: linked TSLA before IBM, a sector fit.
    const oct21 = res.rows.filter((r) => r.date === "2026-10-21").map((r) => r.ticker);
    assert.deepEqual(oct21, ["TSLA", "IBM"]);
    assert.equal(res.rows.find((r) => r.ticker === "KO")!.marketCap, 400e9);
  });

  it("takes the sectors of the reader's holdings as well as the ones picked at onboarding", async () => {
    const { service } = forYouSetup();
    // XOM is held: Energy counts, so a $20B energy company fits.
    const res = ok(await service.upcoming(ask({ scope: "foryou", held: ["XOM"] })));
    assert.equal(res.rows.find((r) => r.ticker === "MIDE")?.reason, "sector");
  });

  it("without names or sectors it is the biggest listings", async () => {
    const { service } = forYouSetup({ graphEdges: async () => [] });
    const res = ok(await service.upcoming(ask({ scope: "foryou" })));
    assert.deepEqual(
      res.rows.map((r) => [r.ticker, r.reason]).sort(),
      [
        ["IBM", "large"],
        ["KO", "large"],
        ["TSLA", "large"],
      ],
    );
  });

  it("looks up market values only for companies large enough by revenue, a week at a time, and again after a failure", async () => {
    let fail = true;
    const capCalls: string[][] = [];
    const { service, advance } = forYouSetup({
      fetchMarketCaps: async (symbols) => {
        capCalls.push([...symbols]);
        if (fail) throw new Error("429");
        return Object.fromEntries(symbols.filter((s) => CAPS[s] !== undefined).map((s) => [s, CAPS[s]!]));
      },
    });
    const failed = ok(await service.upcoming(ask({ scope: "foryou" })));
    assert.deepEqual(failed.rows.map((r) => r.ticker), [], "no market values, no large caps; nothing invented");
    assert.ok(!capCalls[0]!.includes("SMALL") && !capCalls[0]!.includes("ZZZZ"), JSON.stringify(capCalls[0]));
    fail = false;
    advance(3 * 60_000);
    await service.upcoming(ask({ scope: "foryou" }));
    assert.equal(capCalls.length, 2, "a failed read is asked again");
    advance(3 * 60_000);
    await service.upcoming(ask({ scope: "foryou" }));
    assert.equal(capCalls.length, 2, "kept for a week");
    advance(CAPS_TTL_MS);
    await service.upcoming(ask({ scope: "foryou" }));
    assert.equal(capCalls.length, 3);
  });

  it("cleans the sectors a request carries", () => {
    assert.deepEqual(parseEarningsRequest({ scope: "foryou", sectors: ["Technology", "Crypto", 3, "Technology"] })!.sectors, ["Technology"]);
    assert.equal(parseEarningsRequest({ scope: "foryou", sectors: "Technology" }), null);
  });

  it("every secondary read failing or hanging still lists the reader's names, and says which reads are missing", async () => {
    const { service } = forYouSetup({
      sourceTimeoutMs: 20,
      companyNames: () => new Promise(() => {}),
      graphEdges: async () => Promise.reject(new Error("graph unreadable")),
      fetchMarketCaps: async () => Promise.reject(new Error("429")),
      sector: async () => Promise.reject(new Error("profile down")),
      peekSector: () => {
        throw new Error("cache corrupt");
      },
      trackedUniverse: () => new Promise(() => {}),
    });
    const res = ok(await service.upcoming(ask({ scope: "foryou", held: ["NVDA"], watchlist: ["XOM"], sectors: ["Technology"] })));
    assert.deepEqual(
      res.rows.map((r) => [r.ticker, r.reason]),
      [
        ["XOM", "watchlist"],
        ["NVDA", "held"],
      ],
    );
    assert.deepEqual(res.degraded, ["caps", "links", "names", "sectors"]);
    assert.deepEqual(Object.keys(res.degradedCounts ?? {}), ["caps", "links", "names", "sectors"]);
    assert.equal(degradedNoticeable(res), true, "names and links missing is worth the note");
    assert.equal(res.marketCalendar, "fresh");
  });
});

describe("one source failing", () => {
  it("a name whose read hangs is named after the time limit, and the rest stand", async () => {
    const { service } = setup({
      sourceTimeoutMs: 20,
      fetchYahoo: async (symbol) => (symbol === "HANG" ? new Promise(() => {}) : (YAHOO[symbol] ?? null)),
    });
    const res = ok(await service.upcoming(ask({ scope: "mine", held: ["NVDA", "HANG"], watchlist: ["IBM"] })));
    assert.deepEqual(res.unavailable, ["HANG"]);
    assert.deepEqual(res.rows.map((r) => r.ticker), ["IBM", "NVDA"]);
    assert.deepEqual(res.degraded, []);
  });

  it("one failed sector lookup is kept in the answer but is not worth the footnote", async () => {
    const { service } = setup({
      sector: async (symbol) => (symbol === "IBM" ? Promise.reject(new Error("profile down")) : null),
    });
    const res = ok(await service.upcoming(ask({ scope: "mine", held: ["NVDA", "XOM"], watchlist: ["IBM"] })));
    assert.ok(res.rows.some((r) => r.ticker === "NVDA"));
    assert.deepEqual(res.degraded, ["sectors"]);
    assert.deepEqual(res.degradedCounts, { sectors: 1 });
    assert.equal(degradedNoticeable(res), false);
  });

  it("sector lookups failing on several rows are worth the footnote", async () => {
    const { service } = setup({ sector: async () => Promise.reject(new Error("profile down")) });
    const res = ok(await service.upcoming(ask({ scope: "mine", held: ["NVDA", "XOM"], watchlist: ["IBM"] })));
    assert.deepEqual(res.degraded, ["sectors"]);
    assert.ok((res.degradedCounts?.sectors ?? 0) >= 3, JSON.stringify(res.degradedCounts));
    assert.equal(degradedNoticeable(res), true);
  });

  it("a market calendar that fails leaves the Yahoo rows, with the calendar marked missing", async () => {
    const { service } = setup({ fetchMarketCalendar: async () => Promise.reject(new Error("calendar request failed (401)")) });
    const res = ok(await service.upcoming(ask({ scope: "foryou", held: ["NVDA", "XOM"] })));
    assert.equal(res.marketCalendar, "missing");
    assert.deepEqual(res.rows.map((r) => r.ticker), ["XOM", "NVDA"]);
  });

  it("a market calendar that hangs is given up on, and the answer still comes", async () => {
    const { service } = setup({ sourceTimeoutMs: 20, fetchMarketCalendar: () => new Promise(() => {}) });
    const res = ok(await service.upcoming(ask({ scope: "mine", held: ["NVDA"] })));
    assert.equal(res.marketCalendar, "missing");
    assert.deepEqual(res.rows.map((r) => r.ticker), ["NVDA"]);
  });

  it("is a failure only when nothing at all could be read", async () => {
    const { service } = setup({
      fetchMarketCalendar: async () => Promise.reject(new Error("down")),
      fetchYahoo: async () => Promise.reject(new Error("down")),
    });
    assert.deepEqual(await service.upcoming(ask({ scope: "mine", held: ["NVDA", "XOM"] })), { ok: false, error: "unavailable" });
  });
});
