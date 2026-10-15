import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { translate } from "../renderer/lib/i18n/translate";
import { ENGLISH, fullDateLabel, weekdayDateLabel, type BriefingText } from "./briefing-text";
import {
  MACRO_CALENDAR,
  REBALANCE_HORIZON_SESSIONS,
  addTradingDays,
  calendarToday,
  expiryEventsBetween,
  loadMacroCalendar,
  rebalanceEventsBetween,
  sessionWindowFor,
  type CalendarItem,
  type HeldEarnings,
} from "./calendar-types";
import { buildDemoCalendar } from "./calendar-demo";
import { KNOWN_CALENDAR_TITLES, localizeCalendarDetail, localizeCalendarTitle } from "./calendar-i18n";

/**
 * The engine words calendar rows in English and the renderer re-words them by
 * matching that English. These tests hold the match to the engine: every row
 * the engine can build over the curated calendar's whole span must come out
 * through a key, so a release renamed in the data file, or a sentence a later
 * engine adds, fails here instead of showing up in English on a German screen.
 */

/** A language whose every message is its key: a matched line reads "[key]", an unmatched one keeps its English. */
const KEYS: BriefingText = { t: (key) => `[${key}]`, locale: "de-DE" };

const de: BriefingText = { t: (key, vars) => translate("de-DE", key, vars), locale: "de-DE" };

function everyRow(): CalendarItem[] {
  const cal = loadMacroCalendar();
  const now = new Date(`${cal.coverage.from}T12:00:00Z`);
  const rows: CalendarItem[] = [];
  let ymd = cal.coverage.from;
  for (let guard = 0; ymd <= cal.coverage.until && guard < 400; guard++) {
    const window = sessionWindowFor(ymd, now);
    if (window) {
      const earnings: HeldEarnings[] = [
        { ticker: "NVDA", due_ymd: ymd, timing: "bmo", sessions_until: 0, fiscal_period: null, confirmed: true, source: "tracker" },
        { ticker: "BRK.B", due_ymd: ymd, timing: "amc_or_unspecified", sessions_until: 0, fiscal_period: null, confirmed: false, source: "yahoo" },
      ];
      // Both the held-fund sentence and the none-held one are reached.
      const held = guard % 2 === 0 ? ["SPY", "QQQ", "IWM"] : [];
      rows.push(
        ...calendarToday(
          { ...window, early_close: true, gap: "holiday" },
          cal,
          expiryEventsBetween(ymd, ymd),
          rebalanceEventsBetween(ymd, addTradingDays(ymd, REBALANCE_HORIZON_SESSIONS), cal.index_events),
          earnings,
          held,
        ),
      );
    }
    ymd = addTradingDays(ymd, 1);
  }
  return rows;
}

describe("calendar row wording", () => {
  const rows = everyRow();

  it("builds a real spread of rows to check", () => {
    const kinds = new Set(rows.map((r) => r.kind));
    for (const kind of ["fomc", "data", "opex", "earnings", "session", "rebalance"]) assert.ok(kinds.has(kind as never), kind);
  });

  it("knows every macro release and index event the curated file names", () => {
    for (const e of MACRO_CALENDAR.events) assert.ok(KNOWN_CALENDAR_TITLES.includes(e.title), e.title);
    for (const e of MACRO_CALENDAR.index_events) assert.ok(KNOWN_CALENDAR_TITLES.includes(e.title), e.title);
  });

  it("matches every title and every detail sentence the engine writes", () => {
    for (const row of rows) {
      assert.match(localizeCalendarTitle(row.title, KEYS), /^\[briefing\.[\w.]+\]$/, row.title);
      if (row.detail !== null) {
        assert.match(localizeCalendarDetail(row.detail, KEYS)!, /^\[briefing\.[\w.]+\](?: \[briefing\.[\w.]+\])*$/, row.detail);
      }
    }
  });

  it("matches the demo calendar's rows too (presentation mode)", () => {
    const base = sessionWindowFor("2026-09-22", new Date("2026-09-22T11:00:00Z"))!;
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let run = 0; run < 60; run++) {
      const window = { ...base, early_close: run % 3 === 0, gap: run % 4 === 0 ? ("holiday" as const) : base.gap };
      const report = buildDemoCalendar(rand, window, [
        { symbol: "NVDA", shares: 5 },
        { symbol: "SPY", shares: 3 },
      ]);
      for (const row of report.items) {
        assert.match(localizeCalendarTitle(row.title, KEYS), /^\[briefing\.[\w.]+\]$/, row.title);
        if (row.detail !== null) {
          assert.match(localizeCalendarDetail(row.detail, KEYS)!, /^\[briefing\.[\w.]+\](?: \[briefing\.[\w.]+\])*$/, row.detail);
        }
      }
    }
  });

  it("re-words them in the reader's language, names and figures kept", () => {
    assert.ok(!localizeCalendarDetail("Covers 2026-08.", de)!.includes("2026-08"));
    assert.equal(localizeCalendarTitle("NVDA earnings report", de), translate("de-DE", "briefing.row.earnings", { ticker: "NVDA" }));
    const covers = localizeCalendarDetail("Covers September 2026.", de)!;
    assert.ok(covers.includes("September 2026"), covers);
    assert.ok(!covers.includes("Covers"), covers);
    const funds = localizeCalendarDetail("Scheduled, per index methodology. Held funds tracking it: SPY, QQQ.", de)!;
    assert.ok(funds.includes("SPY, QQQ"), funds);
    assert.ok(!funds.includes("Scheduled"), funds);
    assert.equal(localizeCalendarDetail("Covers 3rd Quarter 2026.", KEYS), "[briefing.row.covers]");
  });

  it("leaves a line it does not know as written, whole", () => {
    assert.equal(localizeCalendarTitle("Some new release", de), "Some new release");
    const mixed = "Changes take effect after the close. A sentence nobody wrote a key for.";
    assert.equal(localizeCalendarDetail(mixed, de), mixed);
    assert.equal(localizeCalendarDetail(null, de), null);
  });

  it("is the identity in English", () => {
    for (const row of rows.slice(0, 50)) {
      assert.equal(localizeCalendarTitle(row.title, ENGLISH), row.title);
      assert.equal(localizeCalendarDetail(row.detail, ENGLISH), row.detail);
    }
  });
});

describe("dates in the reader's language", () => {
  it("keeps the English shape the views always printed", () => {
    assert.equal(weekdayDateLabel("2026-09-28"), "Mon Sep 28");
    assert.equal(fullDateLabel("2026-10-31"), "Oct 31, 2026");
    assert.equal(weekdayDateLabel("2026-02-30"), "2026-02-30");
  });

  it("names the month and weekday in the language asked for", () => {
    const tr: BriefingText = { t: (key, vars) => translate("tr-TR", key, vars), locale: "tr-TR" };
    const label = weekdayDateLabel("2026-09-28", tr);
    assert.ok(label.includes("28") && /Eyl/.test(label) && /Pzt/.test(label), label);
    const ja: BriefingText = { t: (key, vars) => translate("ja-JP", key, vars), locale: "ja-JP" };
    assert.equal(fullDateLabel("2026-10-31", ja), "2026年10月31日");
  });
});
