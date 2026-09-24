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
 * Checked against SOURCE, the way the handover card's guard is. The rows the
 * card prints come out of `shared/briefing-view.ts` and the rail in
 * `components/briefing/CalendarRail.tsx`, both scanned by the panel's own
 * test; what is left in the component are the head, the button and the lines
 * for the states that are awkward to reach (a main process from an older
 * build, a failed report, an empty day).
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
      "TODAY",
      "NEXT SESSION",
      "LAST SESSION",
      "All times ET",
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

  // The button leads to a calendar view that does not exist yet, so it is a
  // dashboard CTA held off on its own account: dimmed and inert whatever the
  // set's switch says, never a live button that does nothing.
  it("stands its button in as a dashboard CTA that is off on its own account", () => {
    const code = withoutComments(CARD);
    assert.match(code, /<DashboardCta\s+disabled\b/, "the button must be a DashboardCta with `disabled` set");
    assert.ok(!/<button\b/.test(code), "no plain button on the card: the header's menu is the only other control");
  });

  // The head is "TODAY" only while the wall clock is on the day the rail lists.
  // Once the report has rolled to the next session it names that session, and
  // a report the clock has left behind is named as the last one, never as the
  // next: the rail's standing decides, not the bare day comparison.
  it("names the session by where the clock stands", () => {
    const code = withoutComments(CARD);
    assert.match(code, /sessionStanding\(/);
    assert.match(code, /on: "TODAY", before: "NEXT SESSION", after: "LAST SESSION"/);
    assert.ok(!code.includes("nowOnTargetDay"), "the card reads the standing, not the day flag on its own");
  });

  // The calendar draws the handover report; with that feature switched off it
  // must mount nothing, or it would hold the store the switch exists to stop.
  it("goes with the handover switch", () => {
    const code = withoutComments(CARD);
    assert.match(code, /if \(!briefingEnabled\(\)\) return null;/);
  });
});
