import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NY_ZONE,
  addDays,
  addMonths,
  hhmm,
  fullDay,
  isoWeek,
  longDay,
  monthGrid,
  monthTitle,
  parseHhmm,
  rangeTitle,
  shortDay,
  startOfWeek,
  stepAnchor,
  visibleDays,
  weekdayInitials,
  weekdayName,
  zoneLabel,
  zonedParts,
  zonedWallToMs,
} from "./calendar-dates";

describe("date arithmetic", () => {
  it("adds days and months across edges", () => {
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
    assert.equal(addMonths("2026-12-15", 1), "2027-01-15");
    assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
  });

  it("starts weeks on Sunday or Monday", () => {
    // Saturday 2026-10-10.
    assert.equal(startOfWeek("2026-10-10", 0), "2026-10-04");
    assert.equal(startOfWeek("2026-10-10", 1), "2026-10-05");
    // A Sunday with Monday starts belongs to the week before.
    assert.equal(startOfWeek("2026-10-11", 1), "2026-10-05");
  });

  it("builds a six-week month grid starting on the week start", () => {
    const grid = monthGrid("2026-10-10", 1);
    assert.equal(grid.length, 42);
    assert.equal(grid[0], "2026-09-28");
    assert.equal(grid[41], "2026-11-08");
  });

  it("lists the days of each view", () => {
    assert.deepEqual(visibleDays("day", "2026-10-10", 1), ["2026-10-10"]);
    assert.equal(visibleDays("week", "2026-10-10", 0).length, 7);
    assert.deepEqual(visibleDays("week", "2026-10-10", 1, false), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
    // Weekends hidden on a Sunday: today's column stays, in its place, and Saturday goes.
    assert.deepEqual(visibleDays("week", "2026-10-11", 1, false, "2026-10-11"), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-11"]);
    assert.deepEqual(visibleDays("week", "2026-10-11", 0, false, "2026-10-11"), ["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]);
    // A weekday today, or a week that does not hold today, is unchanged.
    assert.deepEqual(visibleDays("week", "2026-10-10", 1, false, "2026-10-07"), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
    assert.deepEqual(visibleDays("week", "2026-10-17", 1, false, "2026-10-11"), ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]);
  });

  it("steps by the view's unit", () => {
    assert.equal(stepAnchor("day", "2026-10-10", 1), "2026-10-11");
    assert.equal(stepAnchor("week", "2026-10-10", -1), "2026-10-03");
    assert.equal(stepAnchor("month", "2026-10-31", 1), "2026-11-30");
  });

  it("titles a range with a plain hyphen across months", () => {
    assert.equal(rangeTitle("month", "2026-10-10", 1), "October 2026");
    assert.equal(rangeTitle("week", "2026-10-10", 1), "October 2026");
    assert.equal(rangeTitle("week", "2026-09-30", 1), "Sep - Oct 2026");
    assert.equal(rangeTitle("week", "2026-12-30", 1), "Dec 2026 - Jan 2027");
    assert.equal(rangeTitle("day", "2026-10-10", 1), "Sat, Oct 10, 2026");
  });

  it("names months and days in the reader's language", () => {
    assert.equal(rangeTitle("month", "2026-10-10", 1, "tr-TR"), "Ekim 2026");
    assert.equal(rangeTitle("week", "2026-09-30", 1, "tr-TR"), "Eyl - Eki 2026");
    assert.equal(rangeTitle("week", "2026-12-30", 1, "de-DE"), "Dez. 2026 - Jan. 2027");
    assert.equal(monthTitle("2026-10-01", "ja-JP"), "2026年10月");
    assert.equal(shortDay("2026-10-12"), "Oct 12");
    assert.equal(shortDay("2026-10-12", "tr-TR"), "12 Eki");
    assert.equal(longDay("2026-10-12"), "Mon, Oct 12");
    assert.equal(fullDay("2026-10-12"), "Oct 12, 2026");
    assert.equal(weekdayName(1), "Mon");
    assert.equal(weekdayName(1, "fr-FR"), "lun", "without the abbreviation's period");
    // No title carries a long dash, whatever the locale's range style.
    for (const locale of ["en-US", "tr-TR", "de-DE", "fr-FR", "es-ES", "it-IT", "pt-BR", "ja-JP", "zh-CN", "ko-KR"]) {
      for (const anchor of ["2026-09-30", "2026-12-30"]) assert.doesNotMatch(rangeTitle("week", anchor, 1, locale), /[–—～〜]/);
    }
  });

  it("heads the small month with two letters where two tell the days apart", () => {
    assert.deepEqual(weekdayInitials("en-US"), ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]);
    assert.deepEqual(weekdayInitials("tr-TR"), ["Pa", "Pz", "Sa", "Ça", "Pe", "Cu", "Cm"]);
    // Portuguese "qua" and "qui" share their first two letters.
    assert.deepEqual(weekdayInitials("pt-BR").slice(3, 5), ["qua", "qui"]);
    assert.equal(new Set(weekdayInitials("ja-JP")).size, 7);
  });

  it("numbers ISO weeks", () => {
    assert.equal(isoWeek("2026-10-10"), 41);
    assert.equal(isoWeek("2027-01-01"), 53);
    assert.equal(isoWeek("2026-01-01"), 1);
  });
});

describe("zones", () => {
  it("reads an instant on New York's clock across the DST change", () => {
    assert.deepEqual(zonedParts(Date.parse("2026-10-12T12:30:00Z"), NY_ZONE), { ymd: "2026-10-12", minutes: 8 * 60 + 30 });
    assert.deepEqual(zonedParts(Date.parse("2026-11-02T13:30:00Z"), NY_ZONE), { ymd: "2026-11-02", minutes: 8 * 60 + 30 });
    assert.deepEqual(zonedParts(Date.parse("2026-10-12T03:00:00Z"), NY_ZONE), { ymd: "2026-10-11", minutes: 23 * 60 });
  });

  it("turns a wall time back into the instant", () => {
    assert.equal(new Date(zonedWallToMs("2026-10-12", 8 * 60 + 30, NY_ZONE)).toISOString(), "2026-10-12T12:30:00.000Z");
    assert.equal(new Date(zonedWallToMs("2026-11-02", 8 * 60 + 30, NY_ZONE)).toISOString(), "2026-11-02T13:30:00.000Z");
    assert.equal(new Date(zonedWallToMs("2026-10-12", 0, "Europe/Istanbul")).toISOString(), "2026-10-11T21:00:00.000Z");
    assert.equal(new Date(zonedWallToMs("2026-10-12", 1440, "UTC")).toISOString(), "2026-10-13T00:00:00.000Z");
  });

  it("names zones in words, never as a raw offset", () => {
    const words = { ny: "NY time", local: "Local time" };
    assert.equal(zoneLabel(NY_ZONE, words), "NY time");
    assert.equal(zoneLabel("Europe/Istanbul", words), "Local time");
    assert.equal(zoneLabel(undefined, words), "Local time");
  });

  it("formats and parses clock times", () => {
    assert.equal(hhmm(570), "09:30");
    assert.equal(hhmm(1440), "00:00");
    assert.equal(parseHhmm("9:05"), 545);
    assert.equal(parseHhmm("24:00"), 1440);
    assert.equal(parseHhmm("24:30"), null);
    assert.equal(parseHhmm("12:60"), null);
  });
});
