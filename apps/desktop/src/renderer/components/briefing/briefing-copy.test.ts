import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems } from "../../../shared/copy-rules";
import { etClock } from "./briefing-clock";

/**
 * The house copy rules, held over everything the handover panel can print:
 * no advice vocabulary, no forward-looking vocabulary, no em or en dash.
 *
 * Checked against SOURCE, the way the Positions card's guard is: most of these
 * lines only show in a state that is awkward to reach (a provider down, a main
 * process from an older build, a render error), and the point is that every
 * line obeys the rules, including the ones nobody sees on a good day. The
 * folder is read from disk, so a component added later is covered the day it
 * is added.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW = path.join(HERE, "..", "..", "..", "shared", "briefing-view.ts");
const HANDOVER_VIEW = path.join(HERE, "..", "..", "..", "shared", "handover-view.ts");

function sources(): Array<{ name: string; src: string }> {
  const own = fs
    .readdirSync(HERE)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .sort()
    .map((name) => ({ name, src: fs.readFileSync(path.join(HERE, name), "utf8") }));
  return [
    ...own,
    { name: "shared/briefing-view.ts", src: fs.readFileSync(VIEW, "utf8") },
    { name: "shared/handover-view.ts", src: fs.readFileSync(HANDOVER_VIEW, "utf8") },
  ];
}

describe("handover panel copy", () => {
  it("covers the files it is meant to cover", () => {
    const names = sources().map((s) => s.name);
    for (const expected of [
      "BriefingHost.tsx",
      "HandoverPopup.tsx",
      "CalendarRail.tsx",
      "ReactionChip.tsx",
      "shared/briefing-view.ts",
      "shared/handover-view.ts",
    ]) {
      assert.ok(names.includes(expected), `${expected} is not being scanned`);
    }
  });

  /**
   * The view spells month names out in a table (so a calendar date never goes
   * through a zone-dependent formatter), and the fifth of them is a word the
   * rules ban. That one literal, in that one file, is the month and nothing
   * else; the view's own test checks every sentence built from it. Matched as
   * the whole problem line, so "May ease later" in the same file still fails.
   */
  const MONTH_TABLE_ENTRY = 'banned word "may": May';

  for (const { name, src } of sources()) {
    it(`${name} follows the copy rules`, () => {
      const problems = copyProblems(src, { riskWords: true, jsxText: true });
      const allowed = name === "shared/briefing-view.ts" ? [MONTH_TABLE_ENTRY] : [];
      assert.deepEqual(
        problems.filter((p) => !allowed.includes(p)),
        [],
      );
    });
  }

  // The scan above passes trivially over a file with no copy in it. These are
  // lines a reader is known to meet; if one goes missing, either the copy moved
  // somewhere this test does not look, or the scan has stopped seeing it.
  it("still finds the lines a reader meets", () => {
    const all = sources()
      .map((s) => s.src)
      .join("\n");
    for (const phrase of [
      "This is what happened when you were away",
      "See more",
      "Show less",
      "Read the source",
      "A quiet night: nothing since the last close made the summary.",
      "Some sources could not be reached, so this summary is partial.",
      "Demo book: the figures are illustrative.",
      "released its quarterly results.",
      "Session so far, ",
      "After the close, ",
      "Restart Falcon to enable the handover.",
      "The handover could not be put together right now.",
      "Try again",
      "Risk figures are not available for this book.",
    ]) {
      assert.ok(all.includes(phrase), `missing: ${phrase}`);
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

describe("etClock", () => {
  it("prints New York wall time on both sides of the DST change", () => {
    assert.equal(etClock("2026-09-22T11:16:00.000Z"), "07:16");
    assert.equal(etClock(new Date("2026-12-01T13:30:00.000Z")), "08:30");
  });

  it("prints midnight as 00 and refuses an unreadable instant", () => {
    assert.equal(etClock("2026-09-22T04:00:00.000Z"), "00:00");
    assert.equal(etClock("not a date"), null);
  });
});
