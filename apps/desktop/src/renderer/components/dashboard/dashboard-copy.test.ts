import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems, textProblems } from "../../../shared/copy-rules";
import { en } from "../../lib/i18n/messages/areas/dashboard";

/**
 * The house copy rules over the dashboard cards. Their words live in the
 * dashboard message table (`lib/i18n/messages/areas/dashboard.ts`), so the
 * English table is what is held to the advice list and the dash rule here;
 * the i18n test holds every other language to the dash rule and to English's
 * placeholders. The components themselves are scanned too, so a sentence that
 * creeps back into a card as a literal is still seen.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Lines that name the side of the reader's own position. "Short" and "Long"
 * are on the advice list because "go short" is advice; here they say what the
 * reader holds, the way the paper-trade panel does.
 */
const POSITION_SIDE_KEYS = new Set<string>([
  "dashboard.positions.shortTitle",
  "dashboard.positions.shortLabel",
  "dashboard.peek.heldLong",
  "dashboard.peek.heldShort",
]);

const CARDS = [
  "PortfolioCard.tsx",
  "PortfolioValueCard.tsx",
  "PortfolioValueHeadline.tsx",
  "PortfolioChart.tsx",
  "NewsCard.tsx",
  "OpportunitiesPanel.tsx",
  "InsightCard.tsx",
  "InsightDetailModal.tsx",
  "InsightPairFrame.tsx",
  "SelectionGloss.tsx",
  "StockPeekModal.tsx",
  "AddAssetModal.tsx",
  "ChartCardHeader.tsx",
  "TimeframeControls.tsx",
  "ConnectPortfolioEmpty.tsx",
];

describe("dashboard card copy", () => {
  it("the English table follows the copy rules", () => {
    const problems = Object.entries(en)
      .filter(([key]) => !POSITION_SIDE_KEYS.has(key))
      .flatMap(([key, text]) => textProblems(text).map((p) => `${key}: ${p}`));
    assert.deepEqual(problems, []);
  });

  it("the position-side lines break no rule but the side's own word", () => {
    for (const key of POSITION_SIDE_KEYS) {
      const text = en[key as keyof typeof en];
      const problems = textProblems(text).filter((p) => !/^banned word "(long|short)":/.test(p));
      assert.deepEqual(problems, [], key);
    }
  });

  it("the cards carry no sentence of their own that breaks the rules", () => {
    for (const file of CARDS) {
      const src = fs.readFileSync(path.join(HERE, file), "utf8");
      // A missing value prints `common.na` (lib/i18n/na.ts), so not even a
      // bare em dash is left as a "no value" glyph.
      const problems = copyProblems(src, { jsxText: true }).filter(
        (p) => !/^banned word "(long|short)": (long|short)$/.test(p),
      );
      assert.deepEqual(problems, [], file);
    }
  });
});
