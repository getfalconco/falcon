import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems, textProblems } from "../../../shared/copy-rules";
import * as area from "../../lib/i18n/messages/areas/stocktab";

/**
 * The house copy rules over the Stock tab's frame and the sections it owns
 * (the tab, the header, the thesis, the agent reports, the financials): no
 * advice or forward-looking vocabulary, no "edge" or "AI", no em or en dash,
 * no exclamation marks. Checked against source and against every language of
 * those keys in the stocktab area table. The other sections are held to the
 * same rules by their own tests.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = [
  "StockTab.tsx",
  "thesis-store.ts",
  "thesis-cache.ts",
  "header-context.ts",
  "stock-agent-reports.ts",
  "use-stock-overview.ts",
  "use-tab-active.ts",
  "sections/HeaderSection.tsx",
  "sections/ThesisSection.tsx",
  "sections/AgentReportsSection.tsx",
  "sections/ClassicSection.tsx",
].map((f) => path.join(HERE, f));

const MINE = /^stocktab\.(tab|header|thesis|reports|classic)\./;
const WIDE_DASHES = /[―‒－〜～⸺⸻]/;

const TABLES: ReadonlyArray<[string, Readonly<Record<string, string | undefined>>]> = [
  ["en", area.en],
  ["tr", area.tr],
  ["de", area.de],
  ["fr", area.fr],
  ["es", area.es],
  ["it", area.it],
  ["ptBR", area.ptBR],
  ["ja", area.ja],
  ["zhCN", area.zhCN],
  ["ko", area.ko],
];

describe("stock tab copy", () => {
  for (const file of FILES) {
    it(`${path.relative(HERE, file)} follows the copy rules`, () => {
      assert.deepEqual(copyProblems(fs.readFileSync(file, "utf8"), { riskWords: true, jsxText: true }), []);
    });
  }

  it("holds the English keys to the house word lists", () => {
    const problems = Object.entries(area.en)
      .filter(([key]) => MINE.test(key))
      .flatMap(([, text]) => textProblems(text, { riskWords: true }));
    assert.deepEqual(problems, []);
  });

  for (const [name, table] of TABLES) {
    it(`${name}: every key is there, with no dashes and no exclamation marks`, () => {
      for (const key of Object.keys(area.en).filter((k) => MINE.test(k))) {
        const text = (table as Record<string, string | undefined>)[key];
        assert.ok(text, `${name} lacks ${key}`);
        assert.deepEqual(textProblems(text).filter((p) => p.includes("dash")), [], `${name} ${key}`);
        assert.ok(!WIDE_DASHES.test(text), `${name} ${key} has a full-width dash`);
        assert.ok(!/[!！]/.test(text), `${name} ${key} has an exclamation mark`);
        const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        assert.deepEqual(placeholders(text), placeholders((area.en as Record<string, string>)[key]!), `${name} ${key} placeholders`);
      }
    });
  }
});
