import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { withoutComments } from "../../shared/copy-rules";
import { DROPDOWN_FADE } from "./dropdown-motion";

/**
 * Every dropdown opens with a fade and nothing else. The dashboard folder is
 * read from disk, so a menu added later is held to it the day it is written:
 * any `motion.div` that is a menu, a list box or a popover panel must spread
 * DROPDOWN_FADE and set no motion of its own. The modals (the stock peek and
 * the insight detail) are dialogs too but open over the page, not from a
 * button, and keep their own entrance.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = path.join(HERE, "..", "components", "dashboard");
const MODALS = new Set(["StockPeekModal.tsx", "InsightDetailModal.tsx"]);

function panels(): Array<{ file: string; tag: string }> {
  const out: Array<{ file: string; tag: string }> = [];
  for (const file of fs.readdirSync(DASHBOARD).filter((f) => f.endsWith(".tsx") && !MODALS.has(f))) {
    const src = withoutComments(fs.readFileSync(path.join(DASHBOARD, file), "utf8"));
    for (const match of src.matchAll(/<motion\.div([\s\S]*?)className=/g)) {
      const tag = match[1]!;
      if (/role="(menu|listbox|dialog)"/.test(tag)) out.push({ file, tag });
    }
  }
  return out;
}

describe("dropdown motion", () => {
  it("is a fade and nothing else", () => {
    for (const phase of [DROPDOWN_FADE.initial, DROPDOWN_FADE.animate, DROPDOWN_FADE.exit]) {
      assert.deepEqual(Object.keys(phase), ["opacity"]);
    }
  });

  it("is what every dropdown on the dashboard opens with", () => {
    const found = panels();
    // The account menu, Add Module, two card menus with a settings panel each, the news menu and its sector list.
    assert.ok(found.length >= 7, `only ${found.length} dropdowns found: the scan has stopped seeing them`);
    for (const { file, tag } of found) {
      assert.ok(tag.includes("{...DROPDOWN_FADE}"), `${file}: a dropdown does not open with DROPDOWN_FADE`);
      assert.ok(!/\b(initial|animate|exit|transition)=\{\{/.test(tag), `${file}: a dropdown sets its own motion`);
    }
  });
});
