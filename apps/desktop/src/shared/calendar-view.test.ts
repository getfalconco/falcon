import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { CalendarItem, CalendarReport, SessionWindow } from "./calendar-types";
import { calendarView, degradedNotes, effectivePhase, etClock, mastheadDate, nyYmd, viewNow } from "./calendar-view";
import { copyProblems } from "./copy-rules";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Monday 2026-09-21, New York on daylight time (UTC-4): the window opens Sunday
// 20:00 ET, the session runs 09:30 to 16:00 ET.
const at = (iso: string) => new Date(iso);
const OPEN = "2026-09-21T13:30:00.000Z";
const CLOSE = "2026-09-21T20:00:00.000Z";
const MORNING = at("2026-09-21T11:16:00.000Z"); // 07:16 ET

const WINDOW: SessionWindow = {
  target_session_ymd: "2026-09-21",
  prev_session_ymd: "2026-09-18",
  overnight_since: "2026-09-18T20:00:00.000Z",
  window_opens_at: "2026-09-21T00:00:00.000Z",
  target_open_at: OPEN,
  target_close_at: CLOSE,
  phase: "pre_open",
  gap: "weekend",
  early_close: false,
};

function calendarItem(id: string, overrides: Partial<CalendarItem> = {}): CalendarItem {
  return { id, kind: "data", time_et: null, at: null, title: id, detail: null, importance: 2, tickers: [], source: "bls", ...overrides };
}

function makeReport(overrides: Partial<CalendarReport> = {}): CalendarReport {
  return {
    schema_version: 1,
    generated_at: "2026-09-21T11:00:00.000Z",
    demo: false,
    window: WINDOW,
    items: [],
    coverage: { from: "2026-01-01", until: "2026-10-31", compiled_at: "2026-09-01", covers_target: true, days_left: 40 },
    degraded: [],
    ...overrides,
  };
}

describe("phase, flipped locally", () => {
  it("turns to in-session at the open and to between-sessions at the close, with the window unchanged", () => {
    assert.equal(effectivePhase(WINDOW, at("2026-09-21T13:29:59.999Z")), "pre_open");
    assert.equal(effectivePhase(WINDOW, at(OPEN)), "in_session");
    assert.equal(effectivePhase(WINDOW, at("2026-09-21T19:59:59.999Z")), "in_session");
    assert.equal(effectivePhase(WINDOW, at(CLOSE)), "between_sessions");
    assert.equal(WINDOW.phase, "pre_open");
  });

  it("is between sessions before the window opens, and pre-open once it has", () => {
    const early: SessionWindow = { ...WINDOW, phase: "between_sessions" };
    assert.equal(effectivePhase(early, at("2026-09-20T18:00:00.000Z")), "between_sessions");
    assert.equal(effectivePhase(early, at("2026-09-21T00:00:00.000Z")), "pre_open");
  });

  it("keeps the window's word when a bound or the clock cannot be read", () => {
    const broken: SessionWindow = { ...WINDOW, target_open_at: "soon", phase: "in_session" };
    assert.equal(effectivePhase(broken, MORNING), "in_session");
    assert.equal(effectivePhase(WINDOW, at("not a date")), "pre_open");
  });

  it("trusts a window that already said pre-open over a local clock that lags it", () => {
    assert.equal(effectivePhase(WINDOW, at("2026-09-20T23:50:00.000Z")), "pre_open");
  });
});

describe("masthead", () => {
  it("formats the target session from its calendar date", () => {
    assert.equal(mastheadDate(makeReport()), "MON SEP 21");
  });

  it("does not roll an impossible date forward, and shows an unreadable one as it came", () => {
    assert.equal(mastheadDate(makeReport({ window: { ...WINDOW, target_session_ymd: "2026-02-30" } })), "2026-02-30");
    assert.equal(mastheadDate(makeReport({ window: { ...WINDOW, target_session_ymd: "" } })), "");
  });

  it("handles a January 1 target without slipping into the old year", () => {
    assert.equal(mastheadDate(makeReport({ window: { ...WINDOW, target_session_ymd: "2027-01-01" } })), "FRI JAN 1");
  });
});

describe("clocks", () => {
  it("views a demo report from the moment it was generated, and a real one from the real clock", () => {
    const real = at("2026-11-03T18:00:00.000Z");
    const demo = makeReport({ demo: true });
    assert.equal(viewNow(demo, real).toISOString(), demo.generated_at);
    assert.equal(viewNow(makeReport(), real), real);
  });

  it("reads the New York date and wall time of an instant, and nothing from an unreadable one", () => {
    assert.equal(nyYmd(MORNING), "2026-09-21");
    assert.equal(nyYmd("2026-09-21T01:00:00.000Z"), "2026-09-20");
    assert.equal(etClock(MORNING), "07:16");
    assert.equal(etClock("2026-09-21T04:00:00.000Z"), "00:00");
    assert.equal(nyYmd("not a date"), null);
    assert.equal(etClock("not a date"), null);
  });
});

describe("the session's rows", () => {
  const items: CalendarItem[] = [
    calendarItem("fomc", { kind: "fomc", time_et: "14:00", at: "2026-09-21T18:00:00.000Z", title: "FOMC rate decision", importance: 3 }),
    calendarItem("opex", { kind: "opex", title: "Monthly options expiry", importance: 2 }),
    calendarItem("claims", { time_et: "08:30", at: "2026-09-21T12:30:00.000Z", title: "Initial jobless claims", importance: 2 }),
    calendarItem("cpi", { time_et: "08:30", at: "2026-09-21T12:30:00.000Z", title: "Consumer price index", importance: 3 }),
    calendarItem("session", { kind: "session", title: "Regular session, 09:30 to 16:00", importance: 1 }),
    calendarItem("ism", { time_et: "10:00", at: null, title: "ISM manufacturing", importance: 2 }),
    calendarItem("earn", { kind: "earnings", title: "KO reports before the open", importance: 3, tickers: ["KO"] }),
  ];
  const report = makeReport({ items });

  it("splits all-day from timed and sorts each", () => {
    const view = calendarView(report, MORNING);
    assert.deepEqual(view.timed.map((t) => [t.id, t.timeLabel]), [["cpi", "08:30"], ["claims", "08:30"], ["ism", "10:00"], ["fomc", "14:00"]]);
    assert.deepEqual(view.allDay.map((a) => a.id), ["earn", "opex", "session"]);
    assert.deepEqual(view.allDay.map((a) => a.kindLabel), ["Earnings", "Options", "Session"]);
    assert.equal(view.allDay[0].timeLabel, null);
    assert.deepEqual(view.allDay[0].tickers, ["KO"]);
  });

  it("marks what is behind a fixed now and places the now line", () => {
    const before = calendarView(report, MORNING);
    assert.deepEqual(before.timed.map((t) => t.past), [false, false, false, false]);
    assert.equal(before.nowIndex, 0);

    const midMorning = calendarView(report, at("2026-09-21T13:00:00.000Z")); // 09:00 ET
    assert.deepEqual(midMorning.timed.map((t) => t.past), [true, true, false, false]);
    assert.equal(midMorning.nowIndex, 2);

    const onTheDot = calendarView(report, at("2026-09-21T12:30:00.000Z"));
    assert.equal(onTheDot.nowIndex, 2);

    const evening = calendarView(report, at("2026-09-21T21:00:00.000Z"));
    assert.deepEqual(evening.timed.map((t) => t.past), [true, true, true, true]);
    assert.equal(evening.nowIndex, 4);
    assert.deepEqual(evening.allDay.map((a) => a.past), [true, true, true]);
    assert.deepEqual(before.allDay.map((a) => a.past), [false, false, false]);
  });

  // The card is on the next session from the close, where every item of the
  // target session is still ahead and the marker sits at the top of the list.
  // A wall-clock time on it would print "21:00" above "08:30" on a rail that is
  // otherwise strictly in order, so the view says which side of midnight it is on.
  it("says the reader is not yet on the day it lists, on the evening before", () => {
    const nightBefore = calendarView(report, at("2026-09-21T01:00:00.000Z")); // 21:00 ET, Sunday
    assert.deepEqual(nightBefore.timed.map((t) => t.past), [false, false, false, false]);
    assert.equal(nightBefore.nowIndex, 0);
    assert.equal(nightBefore.nowOnTargetDay, false);

    assert.equal(calendarView(report, MORNING).nowOnTargetDay, true);
    assert.equal(calendarView(report, at("2026-09-21T21:00:00.000Z")).nowOnTargetDay, true); // 17:00 ET, same day
    assert.equal(calendarView(report, at("not a date")).nowOnTargetDay, false);
  });

  it("falls back to the New York wall clock for an item with no instant", () => {
    const ismAt = (iso: string) => calendarView(report, at(iso)).timed.find((t) => t.id === "ism")!.past;
    assert.equal(ismAt("2026-09-21T13:59:00.000Z"), false); // 09:59 ET
    assert.equal(ismAt("2026-09-21T14:00:00.000Z"), true); // 10:00 ET
    assert.equal(ismAt("2026-09-21T01:00:00.000Z"), false); // Sunday evening in New York
    assert.equal(ismAt("2026-09-22T05:00:00.000Z"), true); // Tuesday 01:00 ET
  });

  it("puts the now line at zero on an empty day", () => {
    const view = calendarView(makeReport(), MORNING);
    assert.deepEqual([view.timed, view.allDay, view.nowIndex], [[], [], 0]);
  });

  it("writes a quiet footnote while the target is covered and a warning once it is not", () => {
    assert.deepEqual(calendarView(report, MORNING).footnote, { text: "Calendar covers until Oct 31, 2026.", tone: "quiet" });
    const lapsed = makeReport({ coverage: { ...report.coverage, until: "2026-09-18", covers_target: false, days_left: 0 } });
    assert.deepEqual(calendarView(lapsed, MORNING).footnote, {
      text: "Calendar data ends Sep 18, 2026. This session is not covered.",
      tone: "warn",
    });
  });

  it("survives a cached report from an older build that lacks whole fields", () => {
    const partial = { schema_version: 0, generated_at: "2026-09-21T11:00:00.000Z", demo: false, window: WINDOW } as unknown as CalendarReport;
    assert.doesNotThrow(() => {
      calendarView(partial, MORNING);
      degradedNotes(partial);
    });
    assert.equal(calendarView(partial, MORNING).timed.length, 0);
    assert.equal(calendarView(partial, MORNING).footnote.tone, "warn");
    assert.deepEqual(degradedNotes(partial), {});
  });
});

describe("degraded sections", () => {
  it("gives one quiet line per failed section", () => {
    const notes = degradedNotes(
      makeReport({
        degraded: [
          { section: "macro_calendar", detail: "ECONNRESET 10.0.0.4" },
          { section: "earnings", detail: "two symbols failed", symbols: ["AAPL", "MSFT"] },
          { section: "earnings", detail: "one more", symbols: ["NVDA", "AAPL"] },
        ],
      }),
    );
    assert.deepEqual(notes, {
      macro_calendar: "The macro calendar is unavailable right now.",
      earnings: "Earnings dates are unavailable for AAPL, MSFT, NVDA.",
    });
    assert.doesNotMatch(JSON.stringify(notes), /ECONNRESET|timeout/);
  });

  it("names two symbols the way the task words it", () => {
    const notes = degradedNotes(makeReport({ degraded: [{ section: "earnings", detail: "x", symbols: ["AAPL", "MSFT"] }] }));
    assert.equal(notes.earnings, "Earnings dates are unavailable for AAPL, MSFT.");
  });

  it("lets a whole-section failure outrank a per-symbol one, and shortens a list that runs on", () => {
    const whole = degradedNotes(
      makeReport({
        degraded: [
          { section: "earnings", detail: "x", symbols: ["AAPL"] },
          { section: "earnings", detail: "y" },
          { section: "earnings", detail: "z", symbols: ["KO"] },
        ],
      }),
    );
    assert.equal(whole.earnings, "Earnings dates are unavailable right now.");
    const many = degradedNotes(makeReport({ degraded: [{ section: "earnings", detail: "x", symbols: ["A", "B", "C", "D", "E", "F"] }] }));
    assert.equal(many.earnings, "Earnings dates are unavailable for A, B, C, D and 2 more.");
  });

  it("has a line for every section, none when nothing failed, and ignores a section it does not know", () => {
    const sections = ["macro_calendar", "earnings"] as const;
    const notes = degradedNotes(makeReport({ degraded: sections.map((section) => ({ section, detail: "x" })) }));
    for (const section of sections) assert.ok(notes[section], section);
    assert.deepEqual(degradedNotes(makeReport()), {});
    assert.deepEqual(degradedNotes(makeReport({ degraded: [{ section: "narrative" as never, detail: "x" }] })), {});
  });
});

describe("copy rules", () => {
  it("keeps every literal in the view clean", () => {
    const src = fs.readFileSync(path.join(HERE, "calendar-view.ts"), "utf8");
    // The month table spells the fifth month out, and that word is one the
    // rules ban. That one literal is the month and nothing else; every date
    // built from it is checked above. Matched as the whole problem line, so
    // "May ease later" in the same file still fails.
    const monthTableEntry = 'banned word "may": May';
    assert.deepEqual(copyProblems(src, { riskWords: true }).filter((problem) => problem !== monthTableEntry), []);
    // A rule that passes because the copy vanished would be worse than the
    // rule failing, so pin the lines the card actually shows.
    assert.ok(src.includes("Calendar covers until"));
    assert.ok(src.includes("The macro calendar is unavailable right now."));
    assert.ok(src.includes("Earnings dates are unavailable for"));
  });
});
