import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems } from "../../../shared/copy-rules";
import * as insiders from "../../lib/i18n/messages/areas/insiders";
import { interpolate } from "../../lib/i18n/translate";
import { displayName, eventTitle, pathText, tradeLine } from "../../../shared/insider-view";
import type { InsiderEvent, InsiderTrade } from "../../../shared/insider-types";

/**
 * The house copy rules over the Insider activity card (no advice words, no
 * forward-looking words, no dash, no "edge" or "AI"), held over the English
 * table and the component's own literals, and the lines a reader meets,
 * built from the table as the card builds them.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = ["InsidersCard.tsx"].map((f) => [f, fs.readFileSync(path.join(HERE, f), "utf8")] as const);
const { en } = insiders;
const TABLE = Object.values(en)
  .map((text) => JSON.stringify(text))
  .join("\n");

const say = (key: string, params?: Record<string, string | number>) => interpolate((en as Record<string, string>)[key] ?? key, params ?? {});

function trade(over: Partial<InsiderTrade> = {}): InsiderTrade {
  return {
    name: "HUANG JEN HSUN",
    role: "ceo",
    title: "President and CEO",
    code: "P",
    shares: 10_000,
    value: 1_200_000,
    firstDate: "2026-10-01",
    lastDate: "2026-10-01",
    filedAt: "2026-10-02",
    accession: "a1",
    url: "https://www.sec.gov/Archives/edgar/data/1045810/a1/doc.xml",
    sharesBefore: 40_000,
    sharesAfter: 50_000,
    increase: 0.25,
    firstPosition: false,
    plan: false,
    ...over,
  };
}

function event(over: Partial<InsiderEvent>): InsiderEvent {
  return {
    id: "x",
    ticker: "NVDA",
    kind: "purchase_cluster",
    date: "2026-10-06",
    firstDate: "2026-10-01",
    insiders: 3,
    value: 4_200_000,
    roles: ["ceo", "director"],
    trades: [trade()],
    filing: null,
    scope: "held",
    via: null,
    score: 80,
    ...over,
  };
}

describe("insider activity copy", () => {
  it("follows the copy rules", () => {
    for (const [file, src] of FILES) assert.deepEqual(copyProblems(src, { riskWords: true, jsxText: true }), [], file);
    assert.deepEqual(copyProblems(TABLE, { riskWords: true }), []);
    assert.deepEqual(copyProblems(fs.readFileSync(path.join(HERE, "../../../shared/insider-view.ts"), "utf8"), { riskWords: true }), []);
  });

  it("has every key in every language, with the same placeholders", () => {
    const tables = { tr: insiders.tr, de: insiders.de, fr: insiders.fr, es: insiders.es, it: insiders.it, ptBR: insiders.ptBR, ja: insiders.ja, zhCN: insiders.zhCN, ko: insiders.ko };
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [lang, table] of Object.entries(tables)) {
      for (const [key, text] of Object.entries(en)) {
        const local = (table as Record<string, string | undefined>)[key];
        assert.ok(local, `${lang} ${key}`);
        assert.deepEqual(holes(local), holes(text), `${lang} ${key}`);
        assert.deepEqual(copyProblems(JSON.stringify(local)).filter((p) => /dash/i.test(JSON.stringify(p))), [], `${lang} ${key}`);
      }
    }
  });

  it("says what was filed, in one line", () => {
    const lang = "en-US";
    assert.equal(eventTitle(event({}), say, lang), "3 insiders made open market purchases, $4.2M");
    assert.equal(eventTitle(event({ kind: "sale_cluster", value: null }), say, lang), "3 insiders made sales outside 10b5-1 plans");
    assert.equal(
      eventTitle(event({ kind: "large_purchase", insiders: 1, value: 1_200_000, roles: ["ceo"] }), say, lang),
      "CEO open market purchase, $1.2M, holding up 25%",
    );
    assert.equal(
      eventTitle(event({ kind: "large_purchase", insiders: 1, value: 60_000, roles: ["director"], trades: [trade({ role: "director", sharesBefore: 0, firstPosition: true, increase: null })] }), say, lang),
      "Director open market purchase, $60K, from no prior holding",
    );
    assert.equal(eventTitle(event({ kind: "unplanned_sale", insiders: 1, value: 3_100_000, roles: ["cfo"] }), say, lang), "CFO sale outside a 10b5-1 plan, $3.1M");
    assert.equal(
      eventTitle(
        event({ kind: "large_unplanned_sale", insiders: 1, value: 946_000_000, roles: ["director"], trades: [trade({ role: "director", code: "S", shares: 4_236_740, sharesBefore: 31_769_633, sharesAfter: 27_532_893 })] }),
        say,
        lang,
      ),
      "Director sales outside a 10b5-1 plan, $946M, 13% of holding",
    );
    const filing = { form: "SC 13D", filer: "Example Partners LP", filedAt: "2026-10-12", accession: "d1", url: "https://www.sec.gov/x", percent: 7.2 };
    assert.equal(eventTitle(event({ kind: "activist_13d", trades: [], insiders: 0, value: null, roles: [], filing }), say, lang), "Example Partners LP filed a 13D, 7.2% of shares");
    assert.equal(
      eventTitle(event({ kind: "new_holder_13g", trades: [], insiders: 0, value: null, roles: [], filing: { ...filing, form: "SC 13G", percent: null } }), say, lang),
      "Example Partners LP reported a stake of 5% or more in a 13G",
    );
    assert.equal(
      eventTitle(event({ kind: "activist_13d_amendment", trades: [], insiders: 0, value: null, roles: [], filing: { ...filing, filer: null } }), say, lang),
      "A holder restated its purpose in a 13D amendment",
    );
  });

  it("names the path to a linked company and the trades behind a row", () => {
    const linked = event({ ticker: "TSM", scope: "linked", via: { holding: "NVDA", relation: "supplier", tier: "critical", namedBy: "NVDA", sourceUrl: null } });
    assert.equal(pathText(linked, say), "TSM supplier of NVDA");
    assert.equal(pathText(event({}), say), null);
    assert.equal(tradeLine(trade(), say, "en-US"), "Huang Jen Hsun, CEO · Oct 1 · 10,000 shares · $1.2M");
    assert.equal(displayName("O'BRIEN MARY-KATE"), "O'Brien Mary-Kate");
    assert.equal(displayName("Doe Jane"), "Doe Jane");
  });
});
