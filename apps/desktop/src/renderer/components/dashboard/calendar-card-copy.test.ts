import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems, withoutComments } from "../../../shared/copy-rules";

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

describe("calendar card copy", () => {
  it("follows the copy rules", () => {
    assert.deepEqual(copyProblems(CARD, { riskWords: true, jsxText: true }), []);
  });

  // The scan above passes trivially over a file with no copy in it. These are
  // lines a reader is known to meet; if one goes missing, either the copy moved
  // somewhere this test does not look, or the scan has stopped seeing it.
  it("still finds the lines a reader meets", () => {
    for (const phrase of [
      "CALENDAR",
      "UTC",
      "View Calendar",
      "Nothing scheduled for this session.",
      "Early close: this session ends at 13:00 ET.",
      "Restart Falcon to enable the calendar.",
      "The calendar could not be put together right now.",
    ]) {
      assert.ok(CARD.includes(phrase), `missing: ${phrase}`);
    }
    for (const phrase of ["BEFORE THE OPEN", "SESSION ENDED", "NOW ", "All day"]) {
      assert.ok(RAIL.includes(phrase), `missing from the rail: ${phrase}`);
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

  // The button is drawn live, outside the dashboard-CTA switch that would dim
  // it: the reader asked for it not to sit recessed. Its click is wired the
  // day the calendar view exists.
  it("draws View Calendar as a live glass button", () => {
    const code = withoutComments(CARD);
    assert.ok(!code.includes("<DashboardCta"), "the button is not behind the dashboard-CTA switch");
    assert.match(code, /<button[^>]*glass-cta[^>]*>\s*View Calendar/);
  });

  // The head always reads CALENDAR. The meta names the session's date once
  // the report has rolled past today, and the rail's standing decides that,
  // not the bare day comparison.
  it("names the session by where the clock stands", () => {
    const code = withoutComments(CARD);
    assert.match(code, /sessionStanding\(/);
    assert.match(code, /label="CALENDAR"/);
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
