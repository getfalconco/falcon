import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems, withoutComments } from "../../../shared/copy-rules";
import { en as briefingEn } from "../../lib/i18n/messages/areas/briefing";

/**
 * The house copy rules, held over the calendar card: no advice vocabulary, no
 * forward-looking vocabulary, no em or en dash.
 *
 * Checked against SOURCE. The rows the card prints, and the lines of the hover
 * card on each, come out of `shared/calendar-view.ts` (its own test scans it)
 * and the rail in `components/briefing/CalendarRail.tsx` (scanned by the
 * panel's copy test); what is left in the component are the head, the button
 * and the lines for the states that are awkward to reach (a main process from
 * an older build, a failed report, an empty day).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CARD = fs.readFileSync(path.join(HERE, "CalendarCard.tsx"), "utf8");
const RAIL = fs.readFileSync(path.join(HERE, "..", "briefing", "CalendarRail.tsx"), "utf8");
/**
 * The card's words live in the briefing area's English table (every other
 * language is translated from it), so the rules are held over that table as
 * well as over whatever literals are left in the source.
 */
const TABLE = Object.values(briefingEn)
  .map((text) => JSON.stringify(text))
  .join("\n");

describe("calendar card copy", () => {
  it("follows the copy rules", () => {
    assert.deepEqual(copyProblems(CARD, { riskWords: true, jsxText: true }), []);
    assert.deepEqual(copyProblems(TABLE, { riskWords: true }), []);
  });

  // The scan above passes trivially over a file with no copy in it. These are
  // lines a reader is known to meet; if one goes missing, either the copy moved
  // somewhere this test does not look, or the scan has stopped seeing it.
  it("still finds the lines a reader meets", () => {
    assert.ok(CARD.includes("UTC"), "missing: UTC");
    const lines: Array<[key: keyof typeof briefingEn, phrase: string]> = [
      ["briefing.card.label", "CALENDAR"],
      ["briefing.card.viewCalendar", "View Calendar"],
      ["briefing.card.nothing", "Nothing scheduled for this session."],
      ["briefing.card.earlyClose", "Early close: this session ends at 13:00 ET."],
      ["briefing.card.restart", "Restart Falcon to enable the calendar."],
      ["briefing.card.failed", "The calendar could not be put together right now."],
      ["briefing.card.previousDay", "Previous day"],
      ["briefing.card.nextDay", "Next day"],
    ];
    for (const [key, phrase] of lines) {
      assert.equal(briefingEn[key], phrase, `the English for ${key}`);
      assert.ok(CARD.includes(`t("${key}")`), `the card does not print ${key}`);
    }
    const rail: Array<[key: keyof typeof briefingEn, phrase: string]> = [
      ["briefing.rail.beforeOpen", "BEFORE THE OPEN"],
      ["briefing.rail.sessionEnded", "SESSION ENDED"],
      ["briefing.rail.nowAt", "NOW {time}"],
      ["briefing.rail.allDay", "All day"],
    ];
    for (const [key, phrase] of rail) {
      assert.equal(briefingEn[key], phrase, `the English for ${key}`);
      assert.ok(RAIL.includes(`"${key}"`), `missing from the rail: ${key}`);
    }
  });

  it("would catch a breach if one were written", () => {
    const planted = ['const a = <p className="x">Consider trimming the position.</p>;', 'const b = "Futures are up \\u2014 for now";'].join("\n");
    const problems = copyProblems(planted, { riskWords: true, jsxText: true });
    assert.ok(problems.some((p) => p.includes('"consider"')), problems.join(" | "));
    assert.ok(problems.some((p) => p.includes('"trim"')), problems.join(" | "));
    assert.ok(problems.some((p) => p.startsWith("em dash")), problems.join(" | "));
  });
});

describe("calendar card wiring", () => {
  // The card draws the same rail the panel's "Today" column draws, from the
  // same file, so a row cannot come to look like one thing here and another
  // there. A second copy of the rail markup in this file is the drift the
  // shared component exists to prevent.
  it("draws the rail the panel draws, not a copy of it", () => {
    const code = withoutComments(CARD);
    assert.ok(code.includes("<CalendarRows "), "the card must draw CalendarRows");
    assert.ok(!code.includes("grid-cols-[44px_16px_minmax(0,1fr)]"), "the rail's row grid must live in CalendarRail.tsx only");
    assert.ok(code.includes("nowMarkerLabel("), "the marker's label comes from the shared rule");
  });

  // The door to the calendar view is the masthead's round arrow, named View
  // Calendar for screen readers and the tooltip. Live, outside the
  // dashboard-CTA switch that would dim it, and no full-width button at the
  // foot any more.
  it("opens the calendar from the masthead arrow, named View Calendar", () => {
    const code = withoutComments(CARD);
    assert.ok(!code.includes("<DashboardCta"), "the door is not behind the dashboard-CTA switch");
    assert.match(code, /onOpen=\{onOpenCalendar\}/);
    assert.match(code, /openLabel=\{t\("briefing\.card\.viewCalendar"\)\}/);
    assert.ok(!/glass-cta[^"]*w-full/.test(code), "no full-width button at the foot");
  });

  // The head always reads CALENDAR. The meta names the session's date once
  // the report has rolled past today, and the rail's standing decides that,
  // not the bare day comparison.
  it("names the session by where the clock stands", () => {
    const code = withoutComments(CARD);
    assert.match(code, /sessionStanding\(/);
    assert.match(code, /label=\{t\("briefing\.card\.label"\)\}/);
    assert.ok(!code.includes("nowOnTargetDay"), "the card reads the standing, not the day flag on its own");
  });

  // The session's rows come through the shared day module, never assembled
  // in the component, so the card and the calendar view behind View Calendar
  // cannot list the same kind of row two ways.
  it("reads its rows through the shared day module", () => {
    const code = withoutComments(CARD);
    assert.ok(code.includes("calendarForDay("), "the card must take its rows from calendarForDay");
    assert.ok(!/calendarToday\(|macroEventsOn\(|expiryEventsBetween\(/.test(code), "the card must not assemble rows itself");
  });

  // Weekends are days too: the card opens on today when the market is closed
  // today, and the arrows step one calendar day, not one session.
  it("opens on today and steps calendar days, weekends included", () => {
    const code = withoutComments(CARD);
    assert.ok(code.includes("openingDay("), "the opening day comes from the shared rule");
    assert.ok(code.includes("stepDay("), "the arrows step calendar days");
    assert.ok(!code.includes("stepSession("), "the arrows must not skip weekends and holidays");
    assert.ok(code.includes("closedDayNote("), "a closed day says so, in the shared wording");
  });

  // Rows are hoverable and focusable, and the card that opens on them is
  // placed outside the scrolling list, where it cannot be clipped.
  it("lets every row be hovered and focused for its detail card", () => {
    const rail = withoutComments(RAIL);
    assert.match(rail, /onMouseEnter: show\(item\)/);
    // Keyboard focus opens it; a press closes it (the press starts a drag of the
    // card) and the focus that press gives the row opens nothing.
    assert.match(rail, /onPointerDown: hide/);
    assert.match(rail, /matches\(":focus-visible"\)\) show\(item\)/);
    assert.match(rail, /tabIndex: 0/);
    assert.match(rail, /createPortal\(/);
    assert.match(rail, /role="tooltip"/);
  });

  // The calendar draws the handover report; with that feature switched off it
  // must mount nothing, or it would hold the store the switch exists to stop.
  it("goes with the handover switch", () => {
    const code = withoutComments(CARD);
    assert.match(code, /if \(!briefingEnabled\(\)\) return null;/);
  });
});
