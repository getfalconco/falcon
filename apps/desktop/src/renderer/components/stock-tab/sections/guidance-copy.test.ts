import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems, textProblems } from "../../../../shared/copy-rules";
import * as guidance from "../../../lib/i18n/messages/areas/guidance";
import * as stocktab from "../../../lib/i18n/messages/areas/stocktab";

/**
 * The house copy rules over the guidance track record: its English lines
 * (`guidance.*` and the section heading) with the risk words on, every
 * language's lines, and the section and view sources. The release sentences
 * shown on hover are the companies' own text and never pass through here.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANGS = ["tr", "de", "fr", "es", "it", "ptBR", "ja", "zhCN", "ko"] as const;
const HEADING = "stocktab.tab.section.guidance";

describe("guidance record: copy", () => {
  const own = Object.entries(guidance.en);

  it("has its lines in the table", () => {
    assert.ok(own.length >= 50);
    assert.equal(stocktab.en[HEADING], "Guidance record");
  });

  it("the English lines follow the copy rules, risk words included", () => {
    const problems = [...own, [HEADING, stocktab.en[HEADING]] as const].flatMap(([key, text]) =>
      textProblems(text, { riskWords: true }).map((p) => `${key}: ${p}`),
    );
    assert.deepEqual(problems, []);
  });

  it("every language has every line, keeps the placeholders, with no dashes and no exclamation marks", () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    for (const lang of LANGS) {
      const table = guidance[lang] as Record<string, string | undefined>;
      const rows: Array<[string, string, string | undefined]> = [
        ...own.map(([key, text]) => [key, text, table[key]] as [string, string, string | undefined]),
        [HEADING, stocktab.en[HEADING], (stocktab[lang] as Record<string, string | undefined>)[HEADING]],
      ];
      for (const [key, text, tr] of rows) {
        assert.ok(tr, `${lang} ${key} missing`);
        assert.equal(placeholders(tr!), placeholders(text), `${lang} ${key}`);
        assert.ok(!/[‒–—―－〜～⸺⸻]/.test(tr!), `${lang} ${key} has a dash`);
        assert.ok(!/[!！]/.test(tr!), `${lang} ${key} has an exclamation mark`);
      }
    }
  });

  it("the section and the view carry no line of their own that breaks the rules", () => {
    const files = [path.join(HERE, "GuidanceSection.tsx"), path.join(HERE, "../../../../shared/guidance-view.ts")];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      assert.deepEqual(copyProblems(src, { jsxText: true, riskWords: true }), [], file);
    }
  });

  it("the section's buttons are words, not icons", () => {
    const src = fs.readFileSync(path.join(HERE, "GuidanceSection.tsx"), "utf8");
    assert.ok(!/lucide-react|@radix-ui\/react-icons/.test(src));
  });
});
