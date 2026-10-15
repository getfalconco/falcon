import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems } from "../../../shared/copy-rules";
import { en } from "../../lib/i18n/messages/areas/exposure";

/**
 * The house copy rules over the Exposure tab and card: no advice words, no
 * forward-looking words, no em or en dash, no "edge" or "AI". The words live
 * in the exposure area's English table (every other language is translated
 * from it), so the rules are held over that table as well as over whatever
 * literals are left in the components.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = ["ExposureTab.tsx", "ExposureCard.tsx", "exposure-ui.tsx"].map((f) => [f, fs.readFileSync(path.join(HERE, f), "utf8")] as const);
const TABLE = Object.values(en)
  .map((text) => JSON.stringify(text))
  .join("\n");

describe("exposure copy", () => {
  it("follows the copy rules", () => {
    for (const [file, src] of FILES) assert.deepEqual(copyProblems(src, { riskWords: true, jsxText: true }), [], file);
    assert.deepEqual(copyProblems(TABLE, { riskWords: true }), []);
  });

  // The scan above passes trivially over a file with no copy in it. These are
  // lines a reader is known to meet; if one goes missing, the copy moved.
  it("still prints the lines a reader meets", () => {
    const all = FILES.map(([, src]) => src).join("\n");
    const lines: Array<[key: keyof typeof en, phrase: string]> = [
      ["exposure.shared.title", "Shared dependencies"],
      ["exposure.customers.title", "Customer concentration"],
      ["exposure.overlap.title", "Overlap between holdings"],
      ["exposure.headline.many", "{count} companies sit under more than {pct} of your account."],
      ["exposure.source.formDate", "Per {filer} {form}, filed {date}"],
      ["exposure.card.view", "View Exposure"],
      ["exposure.gaps.research", "Research"],
    ];
    for (const [key, phrase] of lines) {
      assert.equal(en[key], phrase, `the English for ${key}`);
      assert.ok(all.includes(`"${key}"`), `nothing prints ${key}`);
    }
  });
});
