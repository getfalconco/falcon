import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addTradingDays } from "../tracker/calendar.js";
import { expiryEventsBetween } from "./expiry.js";
import { loadMacroCalendar } from "./macro-calendar.js";
import { rebalanceEventsBetween } from "./rebalance.js";
import {
  EARNINGS_HORIZON_SESSIONS,
  REBALANCE_HORIZON_SESSIONS,
  calendarToday,
  nextEarnings,
  realYmd,
  sessionsFrom,
} from "./today.js";
import type { CalendarItem, CorporateCalendarRaw, EarningsSlice, HeldEarnings, MacroCalendarFile, MacroEvent, SessionWindow } from "./types.js";
import { resolveSessionWindow } from "./window.js";

/** House copy rules for reader-facing text: no long dashes, no directive or predictive wording. */
const BANNED_WORDS =
  /\b(buy|buys|buying|bought|sell|sells|selling|sold|enter|enters|entered|entering|exit|exits|exited|exiting|long|longs|longer|short|shorts|shorted|shorting|add|adds|added|adding|trim|trims|trimmed|trimming|target|targets|targeted|targeting|stop|stops|stopped|stopping|take profit|signal|signals|signaled|signalled|prediction|predictions|recommend|recommends|recommended|recommending|recommendation|reduce|reduces|reduced|reducing|consider|considers|considered|considering|should|will|expect|expects|expected|expecting|forecast|forecasts|forecasted|forecasting|predict|predicts|predicted|predicting|likely|may)\b/i;
const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

const HELD = ["NVDA", "AAPL", "SPY", "IWM"];
const TARGET = "2026-09-21";

function assertCopyRules(items: CalendarItem[]): void {
  for (const item of items) {
    for (const text of [item.title, item.detail ?? ""]) {
      assert.ok(!LONG_DASH.test(text), `long dash in "${text}"`);
      assert.ok(!BANNED_WORDS.test(text), `banned word in "${text}"`);
    }
  }
}

/** A calendar file holding only the given rows, so a test controls the day it asks about. */
function fileWith(events: MacroEvent[]): MacroCalendarFile {
  return {
    schema_version: 1,
    compiled_at: "2026-09-21",
    coverage: { from: "2026-09-01", until: "2026-12-31" },
    per_source_until: {},
    sources: [],
    events,
    index_events: [],
    session_overrides: [],
  };
}

function slice(rows: EarningsSlice["scheduled_earnings"]): EarningsSlice {
  return { scheduled_earnings: rows };
}

function provider(symbol: string, dates: string[], estimated: boolean | null = true): CorporateCalendarRaw {
  return { symbol, available: true, earnings_dates: dates, earnings_estimated: estimated };
}

/** The rows of the session `when` falls on, from the shipped file and the date rules, as the build assembles them. */
function shippedDay(when: string, held: string[] = HELD, earnings: HeldEarnings[] = []): CalendarItem[] {
  const cal = loadMacroCalendar(null);
  const window = resolveSessionWindow(new Date(when), cal.session_overrides);
  const target = window.target_session_ymd;
  const expiries = expiryEventsBetween(target, target);
  const rebalances = rebalanceEventsBetween(target, addTradingDays(target, REBALANCE_HORIZON_SESSIONS), cal.index_events);
  const items = calendarToday(window, cal, expiries, rebalances, earnings, held);
  assertCopyRules(items);
  return items;
}

describe("calendar/today: ordering", () => {
  it("puts all-day rows first by weight, then timed rows by clock with the heavier row first in a slot", () => {
    // The early-close Friday after Thanksgiving: both session rows are present.
    const window = resolveSessionWindow(new Date("2026-11-27T12:30:00.000Z"));
    assert.equal(window.early_close, true);
    assert.equal(window.gap, "holiday");
    const cal = fileWith([
      { date: "2026-11-27", time_et: "10:00", kind: "data", code: "NEW_HOME_SALES", title: "New Home Sales", importance: 1, source: "census" },
      { date: "2026-11-27", time_et: "08:30", kind: "data", code: "PPI", title: "Producer Price Index", importance: 2, source: "bls" },
      { date: "2026-11-27", time_et: null, kind: "data", code: "UMICH_FINAL", title: "University of Michigan consumer sentiment (final)", importance: 2, source: "umich" },
      { date: "2026-11-27", time_et: "08:30", kind: "data", code: "CPI", title: "Consumer Price Index", importance: 3, source: "bls" },
      // Another day's row never leaks in.
      { date: "2026-11-30", time_et: "08:30", kind: "data", code: "CPI", title: "Consumer Price Index", importance: 3, source: "bls" },
    ]);
    const items = calendarToday(window, cal, [], [], [], HELD);
    assert.deepEqual(items.map((i) => [i.id, i.time_et, i.importance]), [
      ["macro:2026-11-27:UMICH_FINAL", null, 2],
      ["session:early_close", null, 2],
      ["session:after_holiday", null, 1],
      ["macro:2026-11-27:CPI", "08:30", 3],
      ["macro:2026-11-27:PPI", "08:30", 2],
      ["macro:2026-11-27:NEW_HOME_SALES", "10:00", 1],
    ]);
    assertCopyRules(items);
  });

  it("puts all-day items first, then timed ones, and says what a release covers", () => {
    assert.deepEqual(shippedDay("2026-09-11T12:00:00.000Z").map((c) => [c.id, c.time_et, c.detail]), [
      ["macro:2026-09-11:UMICH_PRELIM", null, "Covers September 2026."],
      ["macro:2026-09-11:CPI", "08:30", "Covers August 2026."],
    ]);
  });
});

describe("calendar/today: macro rows", () => {
  it("lists an FOMC day in the order of the day, with each time as an instant", () => {
    const items = shippedDay("2026-10-28T12:00:00.000Z");
    assert.deepEqual(items.map((c) => [c.id, c.kind, c.time_et, c.at, c.importance]), [
      ["macro:2026-10-28:FOMC", "fomc", "14:00", "2026-10-28T18:00:00.000Z", 3],
      ["macro:2026-10-28:FOMC_PRESSER", "fomc", "14:30", "2026-10-28T18:30:00.000Z", 2],
    ]);
    assert.equal(items[0]!.title, "FOMC rate decision");
    assert.equal(items[0]!.source, "fed");
    assert.deepEqual(items[0]!.tickers, []);

    // Standard time: the same wall clock is an hour later in UTC.
    const december = shippedDay("2026-12-09T13:00:00.000Z");
    assert.equal(december.find((c) => c.id === "macro:2026-12-09:FOMC")!.at, "2026-12-09T19:00:00.000Z");
  });

  it("gives an untimed release no instant, and a release with a malformed time none either", () => {
    const window = resolveSessionWindow(new Date("2026-09-21T12:00:00.000Z"));
    const cal = fileWith([
      { date: "2026-09-21", time_et: null, kind: "data", code: "UMICH_PRELIM", title: "University of Michigan consumer sentiment (preliminary)", period: "September 2026", importance: 2, source: "umich" },
      { date: "2026-09-21", time_et: "8:30", kind: "data", code: "ODD", title: "Oddly timed release", importance: 1, source: "bls" },
    ]);
    const items = calendarToday(window, cal, [], [], [], []);
    assert.deepEqual(items.map((c) => [c.id, c.time_et, c.at, c.detail]), [
      ["macro:2026-09-21:UMICH_PRELIM", null, null, "Covers September 2026."],
      ["macro:2026-09-21:ODD", null, null, null],
    ]);
  });
});

describe("calendar/today: session, expiry and rebalance rows", () => {
  it("marks an early close and the first session after a holiday", () => {
    const items = shippedDay("2026-11-27T12:30:00.000Z");
    assert.deepEqual(items.filter((c) => c.kind === "session").map((c) => [c.id, c.title, c.importance, c.time_et, c.at, c.source]), [
      ["session:early_close", "Early close at 13:00 ET", 2, null, null, "rule"],
      ["session:after_holiday", "First session after a US market holiday", 1, null, null, "rule"],
    ]);
    // The Tuesday after Labor Day: back after a holiday, but a full session.
    const afterLaborDay = shippedDay("2026-09-08T12:00:00.000Z");
    assert.deepEqual(afterLaborDay.filter((c) => c.kind === "session").map((c) => c.id), ["session:after_holiday"]);
    // A plain Monday has neither.
    assert.deepEqual(shippedDay("2026-09-21T12:00:00.000Z").filter((c) => c.kind === "session"), []);
  });

  it("lists the quarterly expiry and the rebalances that take effect after that close", () => {
    assert.deepEqual(shippedDay("2026-12-18T12:00:00.000Z").map((c) => [c.id, c.kind, c.importance, c.tickers]), [
      ["opex:quarterly_expiry:2026-12-18", "opex", 3, []],
      ["reb:nasdaq100:2026-12-18", "rebalance", 2, []],
      ["reb:sp:2026-12-18", "rebalance", 2, ["SPY"]],
      ["macro:2026-12-18:UMICH_FINAL", "data", 1, []],
    ]);
    const sp = shippedDay("2026-12-18T12:00:00.000Z").find((c) => c.id === "reb:sp:2026-12-18")!;
    assert.ok(sp.detail!.endsWith("Held funds tracking it: SPY."), sp.detail!);
    const ndx = shippedDay("2026-12-18T12:00:00.000Z").find((c) => c.id === "reb:nasdaq100:2026-12-18")!;
    assert.ok(ndx.detail!.endsWith("None of the funds this report tracks for that family is held."), ndx.detail!);

    const monthly = shippedDay("2026-10-16T12:00:00.000Z");
    assert.deepEqual(monthly.filter((c) => c.kind === "opex").map((c) => [c.title, c.importance]), [["Monthly options expiry", 2]]);
    const vix = shippedDay("2026-10-21T12:00:00.000Z");
    assert.deepEqual(vix.filter((c) => c.kind === "opex").map((c) => [c.title, c.importance]), [["VIX futures and options expiry", 1]]);
  });

  it("lists an expiry past the curated file: the date rules have no end", () => {
    assert.deepEqual(shippedDay("2027-01-15T13:00:00.000Z").map((c) => c.title), ["Monthly options expiry"]);
  });
});

describe("calendar/today: earnings rows", () => {
  const due = (ticker: string, due_ymd: string, over: Partial<HeldEarnings> = {}): HeldEarnings => ({
    ticker,
    due_ymd,
    timing: "amc_or_unspecified",
    sessions_until: sessionsFrom(TARGET, due_ymd),
    fiscal_period: null,
    confirmed: true,
    source: "tracker",
    ...over,
  });

  it("lists a report only when it is due this session, with the hour as words", () => {
    const window = resolveSessionWindow(new Date("2026-09-21T12:00:00.000Z"));
    const items = calendarToday(window, fileWith([]), [], [], [due("AAPL", TARGET, { timing: "bmo" }), due("NVDA", "2026-09-24"), due("MSFT", TARGET, { source: "yahoo", confirmed: false })], HELD);
    assert.deepEqual(items, [
      {
        id: "earn:AAPL:2026-09-21",
        kind: "earnings",
        time_et: null,
        at: null,
        title: "AAPL earnings report",
        detail: "Before the open.",
        importance: 3,
        tickers: ["AAPL"],
        source: "tracker",
      },
      {
        id: "earn:MSFT:2026-09-21",
        kind: "earnings",
        time_et: null,
        at: null,
        title: "MSFT earnings report",
        detail: "After the close, or at an hour not yet announced.",
        importance: 3,
        tickers: ["MSFT"],
        source: "yahoo",
      },
    ]);
    assertCopyRules(items);
  });
});

describe("calendar/today: nextEarnings", () => {
  it("prefers the chain's announced date and falls back to the provider calendar", () => {
    const chain = new Map<string, EarningsSlice | null>([
      ["NVDA", slice([{ due_at: "2026-09-24T20:00:00.000Z", confirmed: true, fiscal_period: "Q3 2026" }])],
      ["AAPL", slice([])],
      ["SPY", null],
      ["IWM", null],
    ]);
    const corporate = new Map<string, CorporateCalendarRaw | null>([
      // The provider's earlier date does not displace the chain's.
      ["NVDA", provider("NVDA", ["2026-09-22"], false)],
      ["AAPL", provider("AAPL", ["2026-10-01"], true)],
      ["SPY", { symbol: "SPY", available: false, earnings_dates: [], earnings_estimated: null }],
      ["IWM", null],
    ]);
    assert.deepEqual(nextEarnings(HELD, chain, corporate, TARGET), [
      { ticker: "NVDA", due_ymd: "2026-09-24", timing: "amc_or_unspecified", sessions_until: 3, fiscal_period: "Q3 2026", confirmed: true, source: "tracker" },
      { ticker: "AAPL", due_ymd: "2026-10-01", timing: "amc_or_unspecified", sessions_until: 8, fiscal_period: null, confirmed: false, source: "yahoo" },
    ]);
  });

  it("reads the Tracker's 12:00Z marker as before the open, keeps the nearest date, and skips a row it cannot read", () => {
    const chain = new Map<string, EarningsSlice | null>([
      [
        "AAPL",
        slice([
          { due_at: "2026-10-02T20:00:00.000Z", confirmed: true, fiscal_period: "Q4 2026" },
          { due_at: "2026-09-21T12:00:00.000Z", confirmed: true, fiscal_period: "Q3 2026" },
          { due_at: "garbage", confirmed: true, fiscal_period: null },
        ]),
      ],
    ]);
    assert.deepEqual(nextEarnings(["AAPL"], chain, new Map(), TARGET), [
      { ticker: "AAPL", due_ymd: "2026-09-21", timing: "bmo", sessions_until: 0, fiscal_period: "Q3 2026", confirmed: true, source: "tracker" },
    ]);
  });

  it("takes the provider's confirmation from its estimated flag, and a blank fiscal period as none", () => {
    const chain = new Map<string, EarningsSlice | null>([["NVDA", slice([{ due_at: "2026-09-24T20:00:00.000Z", confirmed: false, fiscal_period: "  " }])]]);
    const corporate = new Map<string, CorporateCalendarRaw | null>([["AAPL", provider("AAPL", ["2026-09-30", "2026-09-23"], false)]]);
    assert.deepEqual(nextEarnings(["NVDA", "AAPL"], chain, corporate, TARGET), [
      { ticker: "AAPL", due_ymd: "2026-09-23", timing: "amc_or_unspecified", sessions_until: 2, fiscal_period: null, confirmed: true, source: "yahoo" },
      { ticker: "NVDA", due_ymd: "2026-09-24", timing: "amc_or_unspecified", sessions_until: 3, fiscal_period: null, confirmed: false, source: "tracker" },
    ]);
  });

  it("looks no further than the horizon and never behind the target session", () => {
    assert.equal(EARNINGS_HORIZON_SESSIONS, 10);
    const chain = new Map<string, EarningsSlice | null>(
      HELD.map((t) => [t, slice([{ due_at: "2026-09-18T20:00:00.000Z", confirmed: true, fiscal_period: "Q2 2026" }])]),
    );
    // 2026-10-05 is the tenth session after 09-21; 10-06 is the eleventh.
    const corporate = new Map<string, CorporateCalendarRaw | null>([
      ["NVDA", provider("NVDA", ["2026-10-06"], false)],
      ["AAPL", provider("AAPL", ["2026-10-05", "bad"], false)],
      ["SPY", provider("SPY", [], null)],
      ["IWM", provider("IWM", [], null)],
    ]);
    assert.deepEqual(
      nextEarnings(HELD, chain, corporate, TARGET).map((e) => [e.ticker, e.due_ymd, e.sessions_until, e.confirmed]),
      [["AAPL", "2026-10-05", 10, true]],
    );
  });

  it("tolerates a slice whose list is missing and a provider row that is not a date", () => {
    const chain = new Map<string, EarningsSlice | null>([["NVDA", { scheduled_earnings: undefined as unknown as EarningsSlice["scheduled_earnings"] }]]);
    const corporate = new Map<string, CorporateCalendarRaw | null>([["NVDA", provider("NVDA", ["2026-02-30", "2026-9-24", "2026-09-24"], false)]]);
    assert.deepEqual(nextEarnings(["NVDA"], chain, corporate, TARGET).map((e) => [e.due_ymd, e.source]), [["2026-09-24", "yahoo"]]);
  });
});

describe("calendar/today: helpers", () => {
  it("realYmd accepts only a real calendar date in the exact shape", () => {
    assert.equal(realYmd("2026-09-21"), "2026-09-21");
    assert.equal(realYmd("2026-02-30"), null);
    assert.equal(realYmd("2026-9-21"), null);
    assert.equal(realYmd(20260921), null);
  });

  it("sessionsFrom counts sessions ahead as positive and behind as negative", () => {
    assert.equal(sessionsFrom(TARGET, TARGET), 0);
    assert.equal(sessionsFrom(TARGET, "2026-09-24"), 3);
    assert.equal(sessionsFrom(TARGET, "2026-09-18"), -1);
  });

  it("the session window feeding these rows has no fields beyond the contract", () => {
    const window: SessionWindow = resolveSessionWindow(new Date("2026-09-21T12:00:00.000Z"));
    assert.deepEqual(Object.keys(window).sort(), [
      "early_close",
      "gap",
      "overnight_since",
      "phase",
      "prev_session_ymd",
      "target_close_at",
      "target_open_at",
      "target_session_ymd",
      "window_opens_at",
    ]);
  });
});
