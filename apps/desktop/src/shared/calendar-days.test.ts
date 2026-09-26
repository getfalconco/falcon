import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDemoBriefing } from "./briefing-demo";
import { resolveBriefingWindow, type BriefingReport, type CalendarItem, type HeldEarnings } from "./briefing-types";
import { calendarForDay } from "./calendar-days";

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

  it("is closed on a market holiday", () => {
    assert.deepEqual(calendarForDay(briefing(), "2026-11-26", SATURDAY), { closed: true, ymd: "2026-11-26" });
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
