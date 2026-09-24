import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems, withoutComments } from "../../../shared/copy-rules";

/**
 * The house copy rules, held over the handover card: no advice vocabulary, no
 * forward-looking vocabulary, no em or en dash.
 *
 * Checked against SOURCE, the way the panel's guard is. Most of what the card
 * prints comes out of `shared/briefing-view.ts`, which the panel's test already
 * scans; what is left in the component are the lines for the states that are
 * awkward to reach (a main process from an older build, a failed report, an
 * empty calendar), and those are exactly the ones nobody reads on a good day.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CARD = fs.readFileSync(path.join(HERE, "BriefingCard.tsx"), "utf8");
const HEADER = fs.readFileSync(path.join(HERE, "ChartCardHeader.tsx"), "utf8");
const CHIP = fs.readFileSync(path.join(HERE, "..", "briefing", "ReactionChip.tsx"), "utf8");

describe("handover card copy", () => {
  it("follows the copy rules", () => {
    assert.deepEqual(copyProblems(CARD, { riskWords: true, jsxText: true }), []);
    assert.deepEqual(copyProblems(CHIP, { riskWords: true, jsxText: true }), []);
  });

  // The scan above passes trivially over a file with no copy in it. These are
  // lines a reader is known to meet; if one goes missing, either the copy moved
  // somewhere this test does not look, or the scan has stopped seeing it.
  it("still finds the lines a reader meets", () => {
    for (const phrase of [
      "HANDOVER",
      "FOR YOUR BOOK",
      "Next · ",
      "Open handover",
      "Restart Falcon to enable the handover.",
      "The handover could not be put together right now.",
      "Nothing further on this session's calendar.",
    ]) {
      assert.ok(CARD.includes(phrase), `missing: ${phrase}`);
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

describe("handover card wiring", () => {
  // The dashboard's CTAs are switched off as a set (`dashboardCtasEnabled`), and
  // a DashboardCta here would be inert with them: the card would show a door
  // that does not open. Comments are stripped because the component explains
  // this very choice by name.
  it("opens the panel through a plain button, not a dashboard CTA", () => {
    const code = withoutComments(CARD);
    assert.ok(!code.includes("DashboardCta"), "the card must not route its button through DashboardCta");
    assert.ok(code.includes('openBriefing("card")'));
    assert.match(code, /<button\s+type="button"[\s\S]*?className="glass-cta app-no-drag /);
  });

  // The card sits on the free canvas inside a LiftableCard, which picks the card
  // up on a press held past its threshold and cancels the click that follows.
  // Without data-no-lift on the button, a deliberate press on the card's only
  // door to the panel lifts the card and opens nothing. app-no-drag is the
  // Electron window-drag region and means nothing to LiftableCard.
  it("keeps the press on its button out of the canvas lift", () => {
    const code = withoutComments(CARD);
    // Read from the tag to its className rather than to the closing ">": the
    // arrow in the onClick handler carries one of its own.
    const button = code.search(/<button\s+type="button"/);
    const className = code.indexOf('className="glass-cta', button);
    assert.ok(button !== -1 && className > button, "the button is not where this test looks");
    assert.ok(code.slice(button, className).includes("data-no-lift"), "the button that opens the panel is missing data-no-lift");
  });

  // The card is a story card: what happened leads, the figures it moved sit
  // under it as chips, and what it means for the book comes under those. In
  // that order, or the card makes a claim before it shows what moved.
  it("prints the lead story as headline, then its figures as chips, then the meaning for the book", () => {
    const code = withoutComments(CARD);
    const headline = code.indexOf("{headline}</p>");
    const chips = code.indexOf("<ReactionChip", headline);
    const meaning = code.indexOf("FOR YOUR BOOK", chips);
    assert.ok(headline !== -1, "the headline is not printed");
    assert.ok(chips > headline, "the reaction chips are not printed under the headline");
    assert.ok(meaning > chips, "the meaning line is not printed under the chips");
    assert.match(code, /line-clamp-3[^"]*text-\[17px\]/, "the headline is not set at 17px over three lines");
  });

  // The user called the old body ugly for a reason: a 2x2 grid of index moves
  // and a NEXT list said "the S&P fell 0.39%" and nothing else. Neither comes back.
  it("has dropped the market chips grid and the NEXT list", () => {
    const code = withoutComments(CARD);
    assert.ok(!code.includes("grid-cols-2"), "the 2x2 market chips grid is back");
    assert.ok(!/>\s*NEXT\s*</.test(code), "the NEXT list label is back");
    assert.ok(!code.includes("next.map("), "the NEXT list is back");
  });

  // "Not yet opened this launch" is a sessionStorage mark shared with the host
  // (see `briefing-seen.ts`); the old per-session localStorage key is gone, and
  // reading it here would light a dot the host never puts out.
  it("reads the launch mark from sessionStorage and nothing from the old seen key", () => {
    const code = withoutComments(CARD);
    assert.ok(code.includes("readShownThisLaunch(window.sessionStorage)"));
    assert.ok(!code.includes("localStorage"));
    assert.ok(!code.includes("briefingSeen"));
  });

  // The header was written for the balance card, which passes no label. If the
  // default moved, that card would be renamed by a change made for this one.
  it("leaves the shared header's default label alone", () => {
    assert.ok(withoutComments(HEADER).includes('label = "PORTFOLIO VALUE"'));
    assert.ok(withoutComments(CARD).includes('label="HANDOVER"'));
  });
});
