import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCalendarReport } from "./build.js";
import { CALENDAR_SCHEMA_VERSION, type CalendarPorts, type CalendarReport, type CalendarRequest } from "./types.js";

/** A Monday with nothing scheduled in the shipped file, so a test sees only the rows it adds. */
const NOW = "2026-09-21T12:00:00.000Z";
/** The October FOMC day: two timed rows from the shipped file. */
const FOMC_DAY = "2026-10-28T12:00:00.000Z";

/** A provider error as they come: a key and a URL inside the message. */
const SECRET = "sk-live-4f9a2 https://provider.example/v8/chart?token=abc";

const REQUEST: CalendarRequest = {
  holdings: [
    { symbol: "NVDA", shares: 10 },
    { symbol: "AAPL", shares: 4 },
  ],
};

function failing(): Promise<never> {
  return Promise.reject(new Error(SECRET));
}

function hanging(): Promise<never> {
  return new Promise<never>(() => {});
}

/** A chain that knows NVDA's date and follows nobody else; a provider that projects AAPL's. */
function fakePorts(over: Partial<CalendarPorts> = {}): CalendarPorts {
  return {
    earningsFromChain: async (ticker) =>
      ticker === "NVDA" ? { scheduled_earnings: [{ due_at: "2026-10-28T20:00:00.000Z", confirmed: true, fiscal_period: "Q3 2026" }] } : null,
    corporateCalendar: async (symbol) => ({
      symbol,
      available: symbol !== "SPY",
      earnings_dates: symbol === "AAPL" ? ["2026-10-28"] : [],
      earnings_estimated: symbol === "AAPL" ? true : null,
    }),
    calendarOverlay: async () => null,
    ...over,
  };
}

function build(when: string, over: Partial<CalendarPorts> = {}, request: CalendarRequest = REQUEST, opts?: Parameters<typeof buildCalendarReport>[3]): Promise<CalendarReport> {
  return buildCalendarReport(request, new Date(when), fakePorts(over), opts);
}

function assertShape(report: CalendarReport, when: string): void {
  assert.equal(report.schema_version, CALENDAR_SCHEMA_VERSION);
  assert.equal(report.generated_at, new Date(when).toISOString());
  assert.equal(report.demo, false);
  assert.equal(typeof report.window.target_session_ymd, "string");
  assert.ok(["overnight", "weekend", "holiday"].includes(report.window.gap));
  assert.ok(Array.isArray(report.items));
  assert.equal(typeof report.coverage.covers_target, "boolean");
  assert.ok(Array.isArray(report.degraded));
}

describe("calendar/build: the happy path", () => {
  it("lists the curated rows of a covered session and an earnings row from the chain, with nothing degraded", async () => {
    const report = await build(FOMC_DAY);
    assertShape(report, FOMC_DAY);
    assert.equal(report.window.target_session_ymd, "2026-10-28");
    assert.equal(report.window.phase, "pre_open");
    assert.deepEqual(report.items.map((c) => [c.id, c.kind, c.time_et, c.at, c.tickers, c.source]), [
      ["earn:AAPL:2026-10-28", "earnings", null, null, ["AAPL"], "yahoo"],
      ["earn:NVDA:2026-10-28", "earnings", null, null, ["NVDA"], "tracker"],
      ["macro:2026-10-28:FOMC", "fomc", "14:00", "2026-10-28T18:00:00.000Z", [], "fed"],
      ["macro:2026-10-28:FOMC_PRESSER", "fomc", "14:30", "2026-10-28T18:30:00.000Z", [], "fed_events"],
    ]);
    assert.equal(report.items[1]!.detail, "After the close, or at an hour not yet announced.");
    assert.deepEqual(report.coverage, { from: "2026-09-01", until: "2026-12-31", compiled_at: "2026-09-21", covers_target: true, days_left: 64 });
    assert.deepEqual(report.degraded, []);
  });

  it("gives the same report for the same inputs", async () => {
    assert.deepEqual(await build(FOMC_DAY), await build(FOMC_DAY));
  });

  it("lists the session's own rows from the rules alone, with no holdings and no overlay port", async () => {
    const { calendarOverlay: _unused, ...required } = fakePorts();
    const report = await buildCalendarReport({ holdings: [] }, new Date("2026-11-27T12:30:00.000Z"), required);
    assert.equal(report.window.early_close, true);
    assert.equal(report.window.gap, "holiday");
    assert.deepEqual(report.items.map((c) => c.id), ["session:early_close", "session:after_holiday"]);
    assert.deepEqual(report.degraded, []);
  });

  it("marks the macro calendar when the session lies past the curated file, and still lists the rule dates", async () => {
    const report = await build("2027-01-15T13:00:00.000Z");
    assertShape(report, "2027-01-15T13:00:00.000Z");
    assert.equal(report.coverage.covers_target, false);
    assert.equal(report.coverage.until, "2026-12-31");
    assert.ok(report.coverage.days_left < 0);
    assert.deepEqual(report.degraded, [{ section: "macro_calendar", detail: "calendar file does not reach this session" }]);
    assert.deepEqual(report.items.map((c) => c.title), ["Monthly options expiry"]);
  });
});

describe("calendar/build: a failing port costs its rows, not the calendar", () => {
  it("marks earnings for the names whose chain call was refused, and lets the provider fill the date", async () => {
    const report = await build(FOMC_DAY, { earningsFromChain: failing });
    assertShape(report, FOMC_DAY);
    assert.deepEqual(report.degraded, [{ section: "earnings", detail: "request failed", symbols: ["NVDA", "AAPL"] }]);
    // The provider still supplies AAPL's date; NVDA's was only known to the chain.
    assert.deepEqual(report.items.filter((c) => c.kind === "earnings").map((c) => [c.id, c.source]), [["earn:AAPL:2026-10-28", "yahoo"]]);
    assert.equal(report.items.filter((c) => c.kind === "fomc").length, 2);
    // The provider's own words never reach the report.
    assert.ok(!JSON.stringify(report).includes("sk-live"));
    assert.ok(!JSON.stringify(report).includes("provider.example"));
  });

  it("names only the symbol whose call failed", async () => {
    const report = await build(FOMC_DAY, {
      corporateCalendar: async (symbol) => (symbol === "AAPL" ? failing() : fakePorts().corporateCalendar(symbol)),
    });
    assert.deepEqual(report.degraded, [{ section: "earnings", detail: "request failed", symbols: ["AAPL"] }]);
    assert.deepEqual(report.items.filter((c) => c.kind === "earnings").map((c) => c.id), ["earn:NVDA:2026-10-28"]);
  });

  it("treats a port that throws before returning a promise, or answers with nonsense, as a failed call", async () => {
    const thrown = await build(FOMC_DAY, {
      earningsFromChain: () => {
        throw new Error(SECRET);
      },
    });
    assert.deepEqual(thrown.degraded, [{ section: "earnings", detail: "request failed", symbols: ["NVDA", "AAPL"] }]);

    const nonsense = await build(FOMC_DAY, { corporateCalendar: (async () => "no") as unknown as CalendarPorts["corporateCalendar"] });
    assert.deepEqual(nonsense.degraded, [{ section: "earnings", detail: "unusable response", symbols: ["NVDA", "AAPL"] }]);
    assert.deepEqual(nonsense.items.filter((c) => c.kind === "earnings").map((c) => c.id), ["earn:NVDA:2026-10-28"]);
  });

  it("gives up on a hanging call after the per-call timeout", async () => {
    const started = Date.now();
    const report = await build(FOMC_DAY, { earningsFromChain: hanging }, REQUEST, { perCallTimeoutMs: 20, deadlineMs: 2000 });
    assert.ok(Date.now() - started < 1500);
    assert.deepEqual(report.degraded, [{ section: "earnings", detail: "timed out", symbols: ["NVDA", "AAPL"] }]);
    assert.deepEqual(report.items.filter((c) => c.kind === "earnings").map((c) => c.id), ["earn:AAPL:2026-10-28"]);
  });

  it("stops starting calls once the deadline has passed", async () => {
    const asked: string[] = [];
    const started = Date.now();
    const report = await build(
      FOMC_DAY,
      {
        earningsFromChain: (ticker) => {
          asked.push(ticker);
          return hanging();
        },
        corporateCalendar: hanging,
      },
      REQUEST,
      { perCallTimeoutMs: 2000, deadlineMs: 30, concurrency: 1 },
    );
    assert.ok(Date.now() - started < 1500);
    // With one call in flight per port, the second name was still queued when the deadline passed.
    assert.deepEqual(asked, ["NVDA"]);
    assert.deepEqual(report.degraded, [{ section: "earnings", detail: "deadline reached", symbols: ["NVDA", "AAPL"] }]);
    assert.equal(report.items.filter((c) => c.kind === "fomc").length, 2);
  });
});

describe("calendar/build: the overlay", () => {
  it("adds a row and an ad-hoc early close from a valid overlay", async () => {
    const report = await build(NOW, {
      calendarOverlay: async () => ({
        events: [{ date: "2026-09-21", time_et: "10:00", kind: "data", code: "EXISTING_HOMES", title: "Existing Home Sales", period: "August 2026", importance: 1, source: "census" }],
        session_overrides: [
          { date: "2026-09-21", early_close: true, note: "Ad-hoc early close", source: "nyse" },
          { date: "2026-09-18", early_close: true, note: "Ad-hoc early close", source: "nyse" },
        ],
      }),
    });
    assert.deepEqual(report.degraded, []);
    assert.equal(report.window.early_close, true);
    assert.equal(report.window.target_close_at, "2026-09-21T17:00:00.000Z");
    assert.equal(report.window.overnight_since, "2026-09-18T17:00:00.000Z");
    assert.deepEqual(report.items.map((c) => [c.id, c.at]), [
      ["session:early_close", null],
      ["macro:2026-09-21:EXISTING_HOMES", "2026-09-21T14:00:00.000Z"],
    ]);
  });

  it("lets an ad-hoc close decide which session the calendar is for", async () => {
    const overlay = (date: string, early_close: boolean): Partial<CalendarPorts> => ({
      calendarOverlay: async () => ({ session_overrides: [{ date, early_close, note: "Ad-hoc", source: "nyse" }] }),
    });
    // 14:30 ET on a session an ad-hoc close ended at 13:00: the calendar moves
    // on to the next session instead of listing one that is over.
    const added = await build("2026-09-21T18:30:00.000Z", overlay("2026-09-21", true));
    assert.equal(added.window.target_session_ymd, "2026-09-22");
    assert.equal(added.window.phase, "between_sessions");
    const scheduled = await build("2026-09-21T18:30:00.000Z");
    assert.equal(scheduled.window.target_session_ymd, "2026-09-21");
    assert.equal(scheduled.window.phase, "in_session");
  });

  it("rejects an overlay that does not validate or is malformed, names the first problem, and keeps the shipped file", async () => {
    const bad: Array<[unknown, string]> = [
      [{ events: [{ date: "2027-03-01", time_et: "08:30", kind: "data", code: "CPI", title: "Consumer Price Index", importance: 3, source: "bls" }] }, "outside coverage"],
      [{ events: [{ date: "2026-09-21", time_et: "08:30", kind: "data", code: "X", title: "Traders should expect a surprise", importance: 1, source: "bls" }] }, 'banned word "should"'],
      [{ events: [{ date: "2026-09-21", time_et: "08:30", kind: "data", code: "X", title: "From a blog", importance: 1, source: "some_blog" }] }, "unknown source"],
      [{ events: "all of them" }, "not a calendar date"],
      [{ index_events: 12 }, "not a calendar overlay"],
    ];
    for (const [overlay, problem] of bad) {
      const report = await build(NOW, { calendarOverlay: (async () => overlay) as unknown as CalendarPorts["calendarOverlay"] });
      assertShape(report, NOW);
      assert.equal(report.degraded.length, 1, JSON.stringify(overlay));
      const [entry] = report.degraded;
      assert.equal(entry!.section, "macro_calendar");
      assert.ok(entry!.detail.startsWith("overlay rejected: "), entry!.detail);
      assert.ok(entry!.detail.includes(problem), `${entry!.detail} (${JSON.stringify(overlay)})`);
      assert.equal(entry!.symbols, undefined);
      assert.deepEqual(report.items, []);
      assert.equal(report.coverage.covers_target, true);
    }
  });

  it("uses the shipped file, and marks nothing, when the overlay port fails or answers with nothing", async () => {
    for (const calendarOverlay of [failing, async () => null, async () => undefined, () => { throw new Error(SECRET); }]) {
      const report = await build(NOW, { calendarOverlay: calendarOverlay as CalendarPorts["calendarOverlay"] });
      assertShape(report, NOW);
      assert.deepEqual(report.degraded, []);
      assert.deepEqual(report.items, []);
      assert.ok(!JSON.stringify(report).includes("sk-live"));
    }
  });
});

describe("calendar/build: holdings", () => {
  it("collapses duplicates and dust, drops a symbol that is not shaped like one, and asks each port once per name", async () => {
    const chainAsked: string[] = [];
    const providerAsked: string[] = [];
    const report = await build(
      NOW,
      {
        earningsFromChain: async (ticker) => {
          chainAsked.push(ticker);
          return null;
        },
        corporateCalendar: async (symbol) => {
          providerAsked.push(symbol);
          return { symbol, available: true, earnings_dates: [], earnings_estimated: null };
        },
      },
      {
        holdings: [
          { symbol: "nvda", shares: 10 },
          { symbol: " NVDA ", shares: 5 },
          { symbol: "AAPL", shares: 0 },
          { symbol: "bad symbol!", shares: 3 },
          { symbol: "SPY", shares: Number.NaN },
          { symbol: "IWM", shares: -4 },
          { symbol: "BRK.B", shares: 1 },
          { symbol: "", shares: 2 },
          null as unknown as { symbol: string; shares: number },
        ],
      },
    );
    assert.deepEqual(chainAsked, ["NVDA", "IWM", "BRK.B"]);
    assert.deepEqual(providerAsked, ["NVDA", "IWM", "BRK.B"]);
    assert.deepEqual(report.degraded, []);
  });

  it("keeps the calls in flight per port within the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async (symbol: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { symbol, available: true, earnings_dates: [], earnings_estimated: null };
    };
    const holdings = ["A", "B", "C", "D", "E", "F"].map((symbol) => ({ symbol, shares: 1 }));
    await build(NOW, { earningsFromChain: async () => null, corporateCalendar: slow }, { holdings }, { concurrency: 2 });
    assert.ok(peak <= 2, `peak ${peak}`);
  });

  it("does not throw on a request that is not a request", async () => {
    const report = await buildCalendarReport({ holdings: "NVDA" as unknown as CalendarRequest["holdings"] }, new Date(NOW), fakePorts());
    assertShape(report, NOW);
    assert.deepEqual(report.degraded, []);
    const bare = await buildCalendarReport(null as unknown as CalendarRequest, new Date(NOW), fakePorts());
    assertShape(bare, NOW);
  });

  it("rejects an invalid clock instead of resolving a session from it", async () => {
    await assert.rejects(buildCalendarReport(REQUEST, new Date(Number.NaN), fakePorts()), RangeError);
  });
});
