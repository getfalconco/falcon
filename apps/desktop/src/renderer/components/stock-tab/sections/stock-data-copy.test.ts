import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems, textProblems } from "../../../../shared/copy-rules";
import * as stocktab from "../../../lib/i18n/messages/areas/stocktab";
import { categoryKey, changePct, compactCount, correlation, fullDate, periodKey, price, sharePct } from "./stock-data-format";

/**
 * The house copy rules over the Changes, Earnings and Competitors sections:
 * their English lines (`stocktab.changes.*`, `stocktab.earnings.*`,
 * `stocktab.peers.*`) and the components themselves, with the risk words
 * on, since a changes list is exactly where "will" and "expect" creep in.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWN = /^stocktab\.(changes|earnings|peers)\./;

/**
 * "Short interest" is the name of the exchanges' own figure (shares sold short
 * and not yet bought back), the way the market reports it; it describes the
 * stock, it tells no one to do anything. The word is allowed there and only there.
 */
const SHORT_INTEREST_KEYS = new Set(["stocktab.changes.shortInterest"]);

const FILES = ["ChangesSection.tsx", "EarningsSection.tsx", "CompetitorsSection.tsx", "stock-data-format.ts"];

describe("stock tab data sections: copy", () => {
  const own = Object.entries(stocktab.en).filter(([key]) => OWN.test(key));

  it("has its lines in the table", () => {
    assert.ok(own.length > 40);
  });

  it("the English lines follow the copy rules, risk words included", () => {
    const problems = own
      .filter(([key]) => !SHORT_INTEREST_KEYS.has(key))
      .flatMap(([key, text]) => textProblems(text, { riskWords: true }).map((p) => `${key}: ${p}`));
    assert.deepEqual(problems, []);
  });

  it("the short interest line breaks no rule but the figure's own name", () => {
    for (const key of SHORT_INTEREST_KEYS) {
      const text = stocktab.en[key as keyof typeof stocktab.en];
      assert.deepEqual(textProblems(text, { riskWords: true }).filter((p) => !/^banned word "short":/.test(p)), [], key);
    }
  });

  it("every language keeps the English placeholders, with no dashes and no exclamation marks", () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    for (const lang of ["tr", "de", "fr", "es", "it", "ptBR", "ja", "zhCN", "ko"] as const) {
      const table = stocktab[lang] as Record<string, string | undefined>;
      for (const [key, text] of own) {
        const tr = table[key];
        assert.ok(tr, `${lang} ${key} missing`);
        assert.equal(placeholders(tr!), placeholders(text), `${lang} ${key}`);
        assert.ok(!/[\u2012\u2013\u2014\u2015\uff0d\u301c\uff5e\u2e3a\u2e3b]/.test(tr!), `${lang} ${key} has a dash`);
        assert.ok(!/[!\uff01]/.test(tr!), `${lang} ${key} has an exclamation mark`);
      }
    }
  });

  it("the components carry no line of their own that breaks the rules", () => {
    for (const file of FILES) {
      const src = fs.readFileSync(path.join(HERE, file), "utf8");
      assert.deepEqual(copyProblems(src, { jsxText: true, riskWords: true }), [], file);
    }
  });
});

describe("stock tab data sections: formatting", () => {
  it("formats changes, shares, prices and correlations", () => {
    assert.equal(changePct(311.4, 298.3, "en-US"), "+4.4%");
    assert.equal(changePct(90, 100, "en-US"), "-10.0%");
    assert.equal(changePct(1, 0, "en-US"), "");
    assert.equal(sharePct(0.0134, "en-US"), "1.34%");
    assert.equal(compactCount(311_389_688, "en-US"), "311.4M");
    assert.equal(price(328.72, "USD", "en-US"), "$328.72");
    assert.equal(price(328.72, null, "en-US"), "328.72");
    assert.equal(correlation(0.6234, "en-US"), "0.62");
    assert.equal(correlation(-0.1, "en-US"), "-0.10");
    assert.equal(fullDate("2026-10-09", "en-US"), "Oct 9, 2026");
  });

  it("maps periods and categories to their keys", () => {
    assert.deepEqual((["0q", "+1q", "0y", "+1y"] as const).map(periodKey), ["q0", "q1", "y0", "y1"]);
    assert.equal(categoryKey("Supplier"), "supplier");
    assert.equal(categoryKey("related"), null);
  });
});
