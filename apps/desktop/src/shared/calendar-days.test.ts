import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDemoBriefing } from "./briefing-demo";
import { resolveBriefingWindow, type BriefingReport, type CalendarItem, type HeldEarnings } from "./briefing-types";
import { calendarForDay, isTradingDay, marketHolidayOf, openingDay, stepDay, stepSession } from "./calendar-days";
import { calendarView, closedDayNote } from "./calendar-view";

/** Saturday 2026-09-26, 08:00 ET: the report is for Monday the 28th. */
const SATURDAY = new Date("2026-09-26T12:00:00.000Z");

/** A fixed stream, so the demo builder's rolls are the same on every run. */
function stream(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function briefing(overrides: Partial<BriefingReport> = {}): BriefingReport {
  const window = resolveBriefingWindow(SATURDAY);
  const built = buildDemoBriefing(stream(7), window, [{ symbol: "NVDA", shares: 10, cost_usd: 1000 }], 5000);
  return { ...built, demo: false, generated_at: SATURDAY.toISOString(), window, ...overrides };
}

function earnings(ticker: string, due: string): HeldEarnings {
  return { ticker, due_ymd: due, timing: "bmo", sessions_until: 0, fiscal_period: "Q3 2026", confirmed: true, source: "tracker" };
}

describe("stepping a session", () => {
  const coverage = { from: "2026-09-01", until: "2026-12-31" };

  it("moves one trading day, over weekends and holidays", () => {
    assert.equal(stepSession("2026-09-28", 1, coverage), "2026-09-29");
    assert.equal(stepSession("2026-09-28", -1, coverage), "2026-09-25"); // Monday back to Friday
    assert.equal(stepSession("2026-11-25", 1, coverage), "2026-11-27"); // over Thanksgiving
    assert.equal(stepSession("2026-12-24", 1, coverage), "2026-12-28"); // over Christmas and the weekend
  });

  it("stops at the edge of the curated months", () => {
    assert.equal(stepSession("2026-09-01", -1, coverage), null);
    assert.equal(stepSession("2026-12-31", 1, coverage), null);
    assert.equal(stepSession("2026-09-02", -1, coverage), "2026-09-01");
  });
});

describe("the picked day", () => {
  it("is the report itself on the report's own session", () => {
    const rows: CalendarItem[] = [
      { id: "x", kind: "data", time_et: "08:30", at: "2026-09-28T12:30:00.000Z", title: "Test release", detail: null, importance: 2, tickers: [], source: "bls" },
    ];
    const b = briefing({
      calendar_today: rows,
      degraded: [{ section: "corporate_actions", detail: "provider 502", symbols: ["NVDA"] }],
    });
    const day = calendarForDay(b, "2026-09-28", SATURDAY);
    assert.equal(day.closed, false);
    if (day.closed) return;
    assert.equal(day.isSession, true);
    assert.deepEqual(day.report.items, rows);
    assert.deepEqual(day.report.coverage, b.calendar_coverage);
    assert.equal(day.report.window.gap, b.window.handover);
    assert.deepEqual(day.report.degraded, [{ section: "earnings", detail: "provider 502", symbols: ["NVDA"] }]);
  });

  it("builds another day from the curated calendar, with the instant each release lands at", () => {
    const day = calendarForDay(briefing(), "2026-09-30", SATURDAY);
    assert.equal(day.closed, false);
    if (day.closed) return;
    assert.equal(day.isSession, false);
    assert.equal(day.report.window.target_session_ymd, "2026-09-30");
    const titles = day.report.items.map((i) => `${i.time_et} ${i.title}`);
    assert.ok(titles.includes("08:30 GDP (third estimate)"), titles.join(" | "));
    assert.ok(titles.includes("08:30 Personal Income and Outlays (PCE inflation)"), titles.join(" | "));
    const pce = day.report.items.find((i) => i.title.startsWith("Personal Income"))!;
    assert.equal(pce.at, "2026-09-30T12:30:00.000Z"); // 08:30 EDT
    assert.equal(pce.detail, "Covers August 2026.");
    assert.equal(day.report.coverage.covers_target, true);
  });

  it("lists a held name's earnings on its day while the report knows them", () => {
    const b = briefing({
      held_coverage: [{ ticker: "NVDA", coverage: "tracked" }],
      earnings_next: [earnings("NVDA", "2026-10-01")],
    });
    const day = calendarForDay(b, "2026-10-01", SATURDAY);
    assert.equal(day.closed, false);
    if (day.closed) return;
    const row = day.report.items.find((i) => i.kind === "earnings");
    assert.ok(row, "the earnings row is missing");
    assert.equal(row.title, "NVDA earnings report");
    assert.deepEqual(row.tickers, ["NVDA"]);
    assert.equal(day.earningsKnownThrough, null);
  });

  it("says how far held names' earnings are known on a day past that", () => {
    const b = briefing({
      held_coverage: [{ ticker: "NVDA", coverage: "tracked" }],
      earnings_next: [earnings("NVDA", "2026-10-01")],
    });
    // Ten sessions on from Monday 09-28 is Monday 10-12.
    const later = calendarForDay(b, "2026-10-14", SATURDAY);
    assert.equal(later.closed, false);
    if (later.closed) return;
    assert.equal(later.earningsKnownThrough, "2026-10-12");
    assert.equal(later.report.items.filter((i) => i.kind === "earnings").length, 0);
    // A day already behind the session is outside it too.
    const earlier = calendarForDay(b, "2026-09-23", SATURDAY);
    assert.equal(earlier.closed, false);
    if (!earlier.closed) assert.equal(earlier.earningsKnownThrough, "2026-10-12");
  });

  it("says nothing about earnings reach to a reader who holds nothing", () => {
    const day = calendarForDay(briefing({ held_coverage: [] }), "2026-10-14", SATURDAY);
    assert.equal(day.closed, false);
    if (!day.closed) assert.equal(day.earningsKnownThrough, null);
  });

  it("is closed on a market holiday, and says which", () => {
    const day = calendarForDay(briefing(), "2026-11-26", SATURDAY);
    assert.equal(day.closed, true);
    if (!day.closed) return;
    assert.equal(day.ymd, "2026-11-26");
    assert.equal(day.reason, "holiday");
    assert.equal(day.holiday, "thanksgiving");
    assert.equal(closedDayNote(day.reason, day.holiday), "US markets are closed for Thanksgiving Day.");
  });

  it("carries the early close and the expiry rules on their days", () => {
    const friday = calendarForDay(briefing(), "2026-11-27", SATURDAY);
    assert.equal(friday.closed, false);
    if (friday.closed) return;
    assert.equal(friday.report.window.early_close, true);
    assert.ok(friday.report.items.some((i) => i.kind === "session" && i.title === "Early close at 13:00 ET"));

    // The third Friday of October.
    const opex = calendarForDay(briefing(), "2026-10-16", SATURDAY);
    assert.equal(opex.closed, false);
    if (!opex.closed) assert.ok(opex.report.items.some((i) => i.kind === "opex"), opex.report.items.map((i) => i.title).join(" | "));
  });

  it("marks a day past the curated months as not covered", () => {
    const day = calendarForDay(briefing(), "2027-01-06", SATURDAY);
    assert.equal(day.closed, false);
    if (!day.closed) assert.equal(day.report.coverage.covers_target, false);
  });
});

// ---------------------------------------------------------------------------
// Today is today, weekends and holidays included
// ---------------------------------------------------------------------------

/** Saturday 2026-10-10, 11:00 ET (EDT). */
const SAT = new Date("2026-10-10T15:00:00.000Z");
/** Sunday 2026-10-11, 14:20 ET. */
const SUN = new Date("2026-10-11T18:20:00.000Z");
/** Monday 2026-09-07, Labor Day, 10:00 ET. */
const LABOR_DAY = new Date("2026-09-07T14:00:00.000Z");
/** Friday 2026-10-09, 18:30 ET: after the close. */
const FRIDAY_EVENING = new Date("2026-10-09T22:30:00.000Z");
/** Tuesday 2026-10-13, 10:00 ET: a plain trading morning. */
const TUESDAY = new Date("2026-10-13T14:00:00.000Z");

function reportAt(now: Date, overrides: Partial<BriefingReport> = {}): BriefingReport {
  const window = resolveBriefingWindow(now);
  const built = buildDemoBriefing(stream(7), window, [{ symbol: "NVDA", shares: 10, cost_usd: 1000 }], 5000);
  return { ...built, demo: false, generated_at: now.toISOString(), window, ...overrides };
}

describe("the day the calendar opens on", () => {
  it("is Saturday on a Saturday, though the report is for Monday", () => {
    const r = reportAt(SAT);
    assert.equal(r.window.target_session_ymd, "2026-10-12");
    assert.equal(openingDay(r, SAT), "2026-10-10");
  });

  it("is Sunday on a Sunday, the evening after 20:00 included", () => {
    assert.equal(openingDay(reportAt(SUN), SUN), "2026-10-11");
    const evening = new Date("2026-10-12T01:30:00.000Z"); // 21:30 ET Sunday: the window is open for Monday
    const r = reportAt(evening);
    assert.equal(r.window.target_session_ymd, "2026-10-12");
    assert.equal(openingDay(r, evening), "2026-10-11");
  });

  it("is the holiday itself on a Monday holiday", () => {
    const r = reportAt(LABOR_DAY);
    assert.equal(r.window.target_session_ymd, "2026-09-08");
    assert.equal(openingDay(r, LABOR_DAY), "2026-09-07");
    assert.equal(marketHolidayOf("2026-09-07"), "labor");
    const day = calendarForDay(r, "2026-09-07", LABOR_DAY);
    assert.equal(day.closed, true);
    if (day.closed) assert.equal(closedDayNote(day.reason, day.holiday), "US markets are closed for Labor Day.");
  });

  it("is the report's session on a trading day, as before: the next one after the close", () => {
    const tue = reportAt(TUESDAY);
    assert.equal(openingDay(tue, TUESDAY), "2026-10-13");
    // Friday after the bell is still Friday, a trading day: the card keeps
    // looking at the next session, which is Monday. At midnight it is Saturday.
    const fri = reportAt(FRIDAY_EVENING);
    assert.equal(fri.window.target_session_ymd, "2026-10-12");
    assert.equal(openingDay(fri, FRIDAY_EVENING), "2026-10-12");
    const midnight = new Date("2026-10-10T04:00:00.000Z"); // 00:00 ET Saturday
    assert.equal(openingDay(reportAt(midnight), midnight), "2026-10-10");
  });
});

describe("stepping a calendar day", () => {
  const coverage = { from: "2026-09-01", until: "2026-12-31" };

  it("walks through the weekend in both directions", () => {
    const forward: string[] = [];
    for (let d: string | null = "2026-10-09"; d && forward.length < 4; d = stepDay(d, 1, coverage)) forward.push(d);
    assert.deepEqual(forward, ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"]);
    const back: string[] = [];
    for (let d: string | null = "2026-10-12"; d && back.length < 4; d = stepDay(d, -1, coverage)) back.push(d);
    assert.deepEqual(back, ["2026-10-12", "2026-10-11", "2026-10-10", "2026-10-09"]);
  });

  it("stops on holidays rather than over them, and at the edge of the curated months", () => {
    assert.equal(stepDay("2026-11-25", 1, coverage), "2026-11-26");
    assert.equal(stepDay("2026-10-31", 1, coverage), "2026-11-01");
    assert.equal(stepDay("2026-12-31", 1, coverage), null);
    assert.equal(stepDay("2026-09-01", -1, coverage), null);
  });
});

describe("a day the market does not open", () => {
  it("is a weekend with no session rows, framed as the New York day itself", () => {
    const r = reportAt(SUN);
    const day = calendarForDay(r, "2026-10-11", SUN);
    assert.equal(day.closed, true);
    if (!day.closed) return;
    assert.equal(day.reason, "weekend");
    assert.equal(day.holiday, null);
    assert.equal(day.report.window.early_close, false);
    assert.ok(!day.report.items.some((i) => i.kind === "session"), "no early close or after-holiday row on a weekend");
    assert.equal(closedDayNote(day.reason, day.holiday), "US markets are closed for the weekend.");
    assert.equal(day.report.window.target_open_at, "2026-10-11T04:00:00.000Z");
    assert.equal(day.report.window.target_close_at, "2026-10-12T04:00:00.000Z");
    assert.equal(day.report.coverage.covers_target, true);
    assert.equal(calendarView(day.report, SUN).nowOnTargetDay, true);
    // Saturday seen from Sunday is not the day the clock is on.
    const sat = calendarForDay(r, "2026-10-10", SUN);
    assert.equal(sat.closed, true);
    if (sat.closed) assert.equal(calendarView(sat.report, SUN).nowOnTargetDay, false);
  });

  it("frames a winter weekend on EST", () => {
    const day = calendarForDay(reportAt(SUN), "2026-12-05", SUN);
    assert.equal(day.closed, true);
    if (day.closed) assert.equal(day.report.window.target_open_at, "2026-12-05T05:00:00.000Z");
  });

  it("names every NYSE holiday of a year", () => {
    const dates = ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"];
    assert.deepEqual(
      dates.map((d) => marketHolidayOf(d)),
      ["new_year", "mlk", "washington", "good_friday", "memorial", "juneteenth", "independence", "labor", "thanksgiving", "christmas"],
    );
    assert.equal(marketHolidayOf("2026-10-12"), null); // Columbus Day: the market trades
    assert.equal(marketHolidayOf("2026-10-11"), null); // a Sunday is a weekend, not a holiday
    assert.equal(isTradingDay("2026-10-12"), true);
    assert.equal(isTradingDay("2026-10-11"), false);
    assert.equal(isTradingDay("2026-07-03"), false); // the Fourth is a Saturday: kept the Friday before
  });
});
