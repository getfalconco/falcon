import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MACRO_CALENDAR } from "./data/macro-calendar.js";
import {
  coverageStatus,
  loadMacroCalendar,
  macroEventId,
  macroEventsBetween,
  macroEventsOn,
  mergeCalendarOverlay,
  validateMacroCalendar,
} from "./macro-calendar.js";
import type { MacroCalendarFile, MacroEvent } from "./types.js";

/** Calendar years that lie wholly inside [from, until]; computed, never hard-coded. */
function fullYearsInside(from: string, until: string): number[] {
  const years: number[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(until.slice(0, 4)); y++) {
    if (`${y}-01-01` >= from && `${y}-12-31` <= until) years.push(y);
  }
  return years;
}

function event(over: Partial<MacroEvent> = {}): MacroEvent {
  return {
    date: "2026-10-06",
    time_et: "08:30",
    kind: "data",
    code: "TEST",
    title: "Test release",
    importance: 1,
    source: "bls",
    ...over,
  };
}

/** A deep copy the test may break on purpose. */
function draft(): MacroCalendarFile {
  return structuredClone(MACRO_CALENDAR);
}

describe("the shipped macro calendar", () => {
  it("validates with zero problems", () => {
    assert.deepEqual(validateMacroCalendar(MACRO_CALENDAR), []);
  });

  it("puts every FOMC decision at 14:00", () => {
    const decisions = MACRO_CALENDAR.events.filter((e) => e.code === "FOMC");
    assert.ok(decisions.length > 0);
    for (const e of decisions) {
      assert.equal(e.time_et, "14:00", macroEventId(e));
      assert.equal(e.kind, "fomc");
      assert.equal(e.importance, 3);
    }
  });

  it("holds 8 FOMC meetings, 12 CPI and 12 jobs reports in every year fully inside coverage", () => {
    const { from, until } = MACRO_CALENDAR.coverage;
    for (const year of fullYearsInside(from, until)) {
      const inYear = macroEventsBetween(`${year}-01-01`, `${year}-12-31`);
      const count = (code: string): number => inYear.filter((e) => e.code === code).length;
      assert.equal(count("FOMC"), 8, `FOMC meetings in ${year}`);
      assert.equal(count("CPI"), 12, `CPI releases in ${year}`);
      assert.equal(count("NFP"), 12, `jobs reports in ${year}`);
    }
  });

  it("finds full years from the coverage window alone", () => {
    assert.deepEqual(fullYearsInside("2026-09-01", "2026-12-31"), []);
    assert.deepEqual(fullYearsInside("2026-09-01", "2027-12-31"), [2027]);
    assert.deepEqual(fullYearsInside("2026-01-01", "2027-12-30"), [2026]);
  });

  it("has one CPI and one jobs report in every month coverage spans whole", () => {
    // The partial-year stand-in for the 12-a-year check: a month dropped while
    // transcribing a schedule is the likeliest refresh mistake.
    const { from, until } = MACRO_CALENDAR.coverage;
    let month = from.slice(0, 7);
    const last = until.slice(0, 7);
    while (month <= last) {
      const inMonth = MACRO_CALENDAR.events.filter((e) => e.date.startsWith(month));
      assert.equal(inMonth.filter((e) => e.code === "CPI").length, 1, `CPI in ${month}`);
      assert.equal(inMonth.filter((e) => e.code === "NFP").length, 1, `NFP in ${month}`);
      const [y, m] = month.split("-").map(Number) as [number, number];
      month = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    }
  });

  it("finds the events of a known FOMC day", () => {
    const fomc = MACRO_CALENDAR.events.find((e) => e.code === "FOMC");
    assert.ok(fomc);
    const onDay = macroEventsOn(fomc.date);
    assert.ok(onDay.some((e) => macroEventId(e) === macroEventId(fomc)));
    assert.ok(onDay.every((e) => e.date === fomc.date));
    assert.deepEqual(macroEventsOn("1999-01-04"), []);
  });

  it("treats both ends of a range as inclusive", () => {
    const first = MACRO_CALENDAR.events[0];
    const last = MACRO_CALENDAR.events[MACRO_CALENDAR.events.length - 1];
    assert.ok(first && last);
    assert.equal(macroEventsBetween(first.date, last.date).length, MACRO_CALENDAR.events.length);
    assert.deepEqual(
      macroEventsBetween(first.date, first.date).map(macroEventId),
      macroEventsOn(first.date).map(macroEventId),
    );
  });
});

describe("mergeCalendarOverlay", () => {
  it("returns an equal, unshared copy when there is no overlay", () => {
    for (const overlay of [null, undefined, {}]) {
      const merged = mergeCalendarOverlay(MACRO_CALENDAR, overlay);
      assert.deepEqual(merged, MACRO_CALENDAR);
      assert.notEqual(merged, MACRO_CALENDAR);
      assert.notEqual(merged.events, MACRO_CALENDAR.events);
      assert.notEqual(merged.events[0], MACRO_CALENDAR.events[0]);
    }
    assert.deepEqual(loadMacroCalendar(), MACRO_CALENDAR);
  });

  it("adds a new event in sort order", () => {
    const added = event();
    const merged = mergeCalendarOverlay(MACRO_CALENDAR, { events: [added] });
    assert.equal(merged.events.length, MACRO_CALENDAR.events.length + 1);
    assert.deepEqual(macroEventsOn(added.date, merged), [added]);
    assert.deepEqual(validateMacroCalendar(merged), []);
  });

  it("replaces an event with the same id", () => {
    const target = MACRO_CALENDAR.events.find((e) => e.code === "CPI");
    assert.ok(target);
    const corrected: MacroEvent = { ...target, time_et: "10:00", title: "Consumer Price Index (rescheduled hour)" };
    const merged = mergeCalendarOverlay(MACRO_CALENDAR, { events: [corrected] });
    assert.equal(merged.events.length, MACRO_CALENDAR.events.length);
    assert.deepEqual(
      merged.events.find((e) => macroEventId(e) === macroEventId(target)),
      corrected,
    );
  });

  it("removes events by id, and moves a release with remove plus add", () => {
    const target = MACRO_CALENDAR.events.find((e) => e.code === "NFP");
    assert.ok(target);
    const id = macroEventId(target);

    const removed = mergeCalendarOverlay(MACRO_CALENDAR, { remove_event_ids: [id, "2026-01-01:NOPE"] });
    assert.equal(removed.events.length, MACRO_CALENDAR.events.length - 1);
    assert.equal(removed.events.some((e) => macroEventId(e) === id), false);

    const moved: MacroEvent = { ...target, date: "2026-10-05" };
    const merged = mergeCalendarOverlay(MACRO_CALENDAR, { remove_event_ids: [id], events: [moved] });
    assert.equal(merged.events.length, MACRO_CALENDAR.events.length);
    assert.equal(merged.events.some((e) => macroEventId(e) === id), false);
    assert.deepEqual(macroEventsOn("2026-10-05", merged), [moved]);
  });

  it("lets a supplied row win over a removal of the same id", () => {
    const target = MACRO_CALENDAR.events.find((e) => e.code === "CPI");
    assert.ok(target);
    const corrected: MacroEvent = { ...target, time_et: "09:00" };
    const merged = mergeCalendarOverlay(MACRO_CALENDAR, {
      remove_event_ids: [macroEventId(target)],
      events: [corrected],
    });
    assert.deepEqual(
      merged.events.find((e) => macroEventId(e) === macroEventId(target)),
      corrected,
    );
  });

  it("appends index events and session overrides, replacing a row with the same key", () => {
    const shipped = MACRO_CALENDAR.index_events[0];
    assert.ok(shipped);
    const merged = mergeCalendarOverlay(MACRO_CALENDAR, {
      index_events: [
        { date: "2026-09-18", family: "sp", title: "Quarterly rebalance takes effect after the close", source: "msci" },
        { ...shipped, title: "Corrected title" },
      ],
      session_overrides: [
        { date: "2026-12-31", early_close: true, note: "Later close day", source: "nyse" },
        { date: "2026-10-05", early_close: true, note: "Ad-hoc early close", source: "nyse" },
        { date: "2026-10-05", early_close: false, note: "Withdrawn", source: "nyse" },
      ],
    });
    assert.equal(merged.index_events.length, MACRO_CALENDAR.index_events.length + 1);
    assert.equal(merged.index_events[0]?.date, "2026-09-18");
    assert.equal(
      merged.index_events.find((e) => e.date === shipped.date && e.family === shipped.family)?.title,
      "Corrected title",
    );
    assert.deepEqual(
      merged.session_overrides.map((o) => [o.date, o.early_close]),
      [
        ["2026-10-05", false],
        ["2026-12-31", true],
      ],
    );
  });

  it("never mutates the file or the overlay", () => {
    const before = structuredClone(MACRO_CALENDAR);
    const overlay = {
      events: [event()],
      remove_event_ids: [macroEventId(MACRO_CALENDAR.events[0])],
      index_events: [{ date: "2026-09-18", family: "sp" as const, title: "Quarterly rebalance", source: "msci" }],
      session_overrides: [{ date: "2026-10-05", early_close: true, note: "Ad-hoc early close", source: "nyse" }],
    };
    const overlayBefore = structuredClone(overlay);
    const merged = loadMacroCalendar(overlay);
    merged.events.length = 0;
    merged.coverage.until = "1999-01-01";
    merged.per_source_until.bls = "1999-01-01";
    assert.deepEqual(MACRO_CALENDAR, before);
    assert.deepEqual(overlay, overlayBefore);
  });
});

describe("coverageStatus", () => {
  const { from, until } = MACRO_CALENDAR.coverage;

  it("covers a day inside the window and counts the days left", () => {
    const status = coverageStatus(from);
    assert.equal(status.covers_target, true);
    assert.equal(status.from, from);
    assert.equal(status.until, until);
    assert.equal(status.compiled_at, MACRO_CALENDAR.compiled_at);
    assert.ok(status.days_left > 0);
  });

  it("still covers the last day, with zero days left", () => {
    const status = coverageStatus(until);
    assert.equal(status.covers_target, true);
    assert.equal(status.days_left, 0);
  });

  it("does not cover the day after the end, and goes negative", () => {
    const cal: MacroCalendarFile = { ...draft(), coverage: { from: "2026-09-01", until: "2026-12-31" } };
    assert.deepEqual(coverageStatus("2027-01-01", cal), {
      from: "2026-09-01",
      until: "2026-12-31",
      compiled_at: cal.compiled_at,
      covers_target: false,
      days_left: -1,
    });
    assert.equal(coverageStatus("2027-01-10", cal).days_left, -10);
  });

  it("does not cover a day before the window opens", () => {
    const status = coverageStatus("2026-08-31", { ...draft(), coverage: { from: "2026-09-01", until: "2026-12-31" } });
    assert.equal(status.covers_target, false);
    assert.equal(status.days_left, 122);
  });
});

describe("validateMacroCalendar", () => {
  const problemsAfter = (edit: (cal: MacroCalendarFile) => void): string[] => {
    const cal = draft();
    edit(cal);
    return validateMacroCalendar(cal);
  };
  const has = (problems: string[], text: string): boolean => problems.some((p) => p.includes(text));

  it("flags a duplicate id and a broken order", () => {
    const problems = problemsAfter((cal) => {
      cal.events.push({ ...cal.events[0] });
    });
    assert.ok(has(problems, "duplicate id"));
    assert.ok(has(problems, "out of order"));
  });

  it("flags two index events for one family on one date", () => {
    const problems = problemsAfter((cal) => {
      const first = cal.index_events[0]!;
      cal.index_events.splice(1, 0, { ...first, title: "A second wording of the same review" });
    });
    assert.ok(has(problems, "duplicate family and date"));
  });

  it("wants untimed rows after timed rows on the same day", () => {
    const problems = problemsAfter((cal) => {
      const date = "2026-10-06";
      cal.events = [event({ date, time_et: null, code: "A" }), event({ date, time_et: "08:30", code: "B" })];
    });
    assert.ok(has(problems, "out of order"));
  });

  it("flags an impossible date, a weekend, and a day outside coverage", () => {
    assert.ok(has(problemsAfter((cal) => cal.events.push(event({ date: "2026-02-30" }))), "not a calendar date"));
    assert.ok(has(problemsAfter((cal) => cal.events.push(event({ date: "2026-10-03" }))), "weekend"));
    assert.ok(has(problemsAfter((cal) => cal.events.unshift(event({ date: "2026-08-31" }))), "outside coverage"));
    assert.ok(
      has(
        problemsAfter((cal) => cal.index_events.push({ date: "2031-03-03", family: "msci", title: "Review", source: "msci" })),
        "outside coverage",
      ),
    );
  });

  it("flags a malformed time and accepts null", () => {
    assert.ok(has(problemsAfter((cal) => cal.events.push(event({ date: "2026-12-30", time_et: "8:30" }))), "not HH:MM"));
    assert.ok(has(problemsAfter((cal) => cal.events.push(event({ date: "2026-12-30", time_et: "24:00" }))), "not HH:MM"));
    assert.deepEqual(problemsAfter((cal) => cal.events.push(event({ date: "2026-12-30", time_et: null }))), []);
  });

  it("flags an unknown source and an unofficial or look-alike host", () => {
    assert.ok(has(problemsAfter((cal) => cal.events.push(event({ date: "2026-12-30", source: "nowhere" }))), "unknown source"));
    for (const url of [
      "https://www.investing.com/economic-calendar/",
      "https://bls.gov.example.com/schedule",
      "https://notbls.gov/schedule",
      "http://www.bls.gov/schedule/news_release/",
      "not a url",
    ]) {
      const problems = problemsAfter((cal) => {
        cal.sources[0].url = url;
      });
      assert.ok(has(problems, "not an official publisher"), url);
    }
  });

  it("flags a row dated after its own source's published horizon", () => {
    const problems = problemsAfter((cal) => {
      cal.per_source_until.census = "2026-11-30";
    });
    assert.ok(has(problems, "after per_source_until.census"));
  });

  it("holds coverage.until to the shortest importance-3 schedule", () => {
    const problems = problemsAfter((cal) => {
      cal.per_source_until.bls = "2026-12-30";
    });
    assert.ok(has(problems, "coverage.until: want 2026-12-30"));
    // A source with no importance-3 row does not pull coverage back.
    assert.deepEqual(
      problemsAfter((cal) => {
        cal.per_source_until.ftse_russell = "2026-12-15";
      }),
      [],
    );
  });

  it("enforces the copy rules on titles, with the period exempt from the word list only", () => {
    const at = { date: "2026-12-30" };
    assert.ok(has(problemsAfter((cal) => cal.events.push(event({ ...at, title: "FOMC target range" }))), '"target"'));
    assert.ok(has(problemsAfter((cal) => cal.events.push(event({ ...at, title: "Names added to the index" }))), '"added"'));
    assert.ok(has(problemsAfter((cal) => cal.events.push(event({ ...at, title: "Retail Sales, May 2027" }))), '"May"'));
    assert.ok(has(problemsAfter((cal) => cal.events.push(event({ ...at, title: "Desks take profit" }))), "take profit"));
    assert.ok(has(problemsAfter((cal) => cal.events.push(event({ ...at, title: "GDP \u2014 advance" }))), "dash"));
    assert.ok(has(problemsAfter((cal) => cal.events.push(event({ ...at, period: "Q3 \u2013 2026" }))), "dash"));
    assert.ok(
      has(
        problemsAfter((cal) => cal.session_overrides.push({ date: "2026-12-30", early_close: true, note: "Markets will close early", source: "nyse" })),
        '"will"',
      ),
    );
    // Word boundaries: none of these contain a banned word.
    for (const title of ["Advance Monthly Retail Sales", "Shortage survey", "Mayor's address", "Additional detail", "Stopgap funding vote"]) {
      assert.deepEqual(problemsAfter((cal) => cal.events.push(event({ ...at, title }))), [], title);
    }
    assert.deepEqual(problemsAfter((cal) => cal.events.push(event({ ...at, period: "May 2027" }))), []);
  });
});
