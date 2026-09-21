import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * House rule for the Positions card: its copy uses no em dash (Kuzey,
 * 2026-09-06). The Screen engine holds its templates to the same rule and
 * guards it with a test; this is that guard for the card whose copy lives in
 * the component rather than in a config file.
 *
 * Checked against the source rather than by calling the message builder,
 * because the builder rotates its lines by the calendar day — a behavioural
 * test would only ever see one of the two variants per tier, and the point is
 * that EVERY line obeys the rule, including ones added later.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, "PortfolioCard.tsx");
const EM_DASH = "—";

/** Source with comments removed, so a note to a developer is never mistaken
 *  for something a reader sees. */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/** Every quoted string and template literal left in the code. */
function literals(src: string): string[] {
  const out: string[] = [];
  const patterns = [/"([^"\\\n]|\\.)*"/g, /'([^'\\\n]|\\.)*'/g, /`([^`\\]|\\.)*`/g];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) out.push(m[0].slice(1, -1));
  }
  return out;
}

describe("Positions card copy", () => {
  const src = withoutComments(fs.readFileSync(SOURCE, "utf8"));

  it("uses no em dash in any sentence", () => {
    const offenders = literals(src).filter(
      (s) =>
        s.includes(EM_DASH) &&
        // A bare dash is the "no value yet" glyph, not prose.
        s.trim() !== EM_DASH,
    );
    assert.deepEqual(
      offenders,
      [],
      `these strings still contain an em dash:\n  ${offenders.join("\n  ")}`,
    );
  });

  it("still says the things it is supposed to say", () => {
    // A rule that passes because the copy vanished would be worse than the
    // rule failing, so pin a couple of the lines the card actually shows.
    assert.ok(src.includes("Flat for now."));
    assert.ok(src.includes("of the ${noun} from ${who}."));
    assert.ok(src.includes("Short position in "));
  });
});
