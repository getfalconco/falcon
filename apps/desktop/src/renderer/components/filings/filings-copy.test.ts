import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems, textProblems } from "../../../shared/copy-rules";
import * as area from "../../lib/i18n/messages/areas/filings";
import { interpolate } from "../../lib/i18n/translate";
import { changeLabel, filingDate, groupOf, safeSecUrl, sharePct } from "../../../shared/filing-changes-view";
import { FILING_CHANGE_KINDS, overviewRows, parseOverviewRequest, type FilingChangeItem, type FilingChanges } from "../../../shared/filing-changes";

/**
 * The house copy rules over Filing changes (no advice words, no
 * forward-looking words, no dash, no "edge" or "AI"), held over the English
 * table, every language's placeholders, the card and section source, and the
 * lines a reader meets, built from the table as the views build them.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "..", "..");
const FILES = [
  path.join(HERE, "FilingChangesCard.tsx"),
  path.join(HERE, "..", "stock-tab", "sections", "FilingChangesSection.tsx"),
  path.join(SRC, "shared", "filing-changes-view.ts"),
  path.join(SRC, "shared", "filing-changes.ts"),
];
const LANGS = ["tr", "de", "fr", "es", "it", "ptBR", "ja", "zhCN", "ko"] as const;
const WIDE_DASHES = /[\u2012\u2013\u2014\u2015\uff0d\u301c\uff5e\u2e3a\u2e3b]/;

const say = (key: string, params?: Record<string, string | number>) => interpolate((area.en as Record<string, string>)[key] ?? key, params ?? {});

function item(extra: Partial<FilingChangeItem>): FilingChangeItem {
  return {
    id: "x",
    kind: "risk_new",
    form: "10-K",
    date: "2026-02-20",
    url: "https://www.sec.gov/Archives/edgar/data/1/x.htm",
    text: "We depend on Umbrella Materials as the sole source of our wafers.",
    previous: null,
    name: null,
    pct: null,
    previousPct: null,
    detail: null,
    notable: true,
    repeat: false,
    ...extra,
  };
}

describe("filings copy", () => {
  it("the components follow the copy rules", () => {
    for (const file of FILES) assert.deepEqual(copyProblems(fs.readFileSync(file, "utf8"), { riskWords: true, jsxText: true }), [], path.basename(file));
  });

  it("the English table follows the copy rules, risk words included", () => {
    const problems = Object.entries(area.en).flatMap(([key, text]) => textProblems(text, { riskWords: true }).map((p) => `${key}: ${p}`));
    assert.deepEqual(problems, []);
  });

  for (const lang of LANGS) {
    it(`${lang}: every key, the same placeholders, no dashes, no exclamation marks`, () => {
      const table = area[lang] as Record<string, string | undefined>;
      const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      for (const [key, en] of Object.entries(area.en)) {
        const text = table[key];
        assert.ok(text, `${lang} lacks ${key}`);
        assert.deepEqual(placeholders(text!), placeholders(en), `${lang} ${key}`);
        assert.ok(!WIDE_DASHES.test(text!), `${lang} ${key} has a dash`);
        assert.ok(!/[!\uff01]/.test(text!), `${lang} ${key} has an exclamation mark`);
      }
    });
  }

  it("every kind has its line, and every line reads plainly", () => {
    for (const kind of FILING_CHANGE_KINDS) {
      const line = changeLabel(item({ kind, name: "Globex Corporation", pct: 24, previousPct: 18, previous: "Ernst & Young LLP", detail: kind === "late_filing" ? "NT 10-K" : "revenue" }), say, "en-US");
      assert.ok(!line.includes("filings."), `${kind}: ${line}`);
      assert.deepEqual(textProblems(line, { riskWords: true }), [], line);
      assert.ok(["flags", "risks", "relations"].includes(groupOf(kind)));
    }
  });

  it("says what changed, with the filing's own figures", () => {
    assert.equal(changeLabel(item({}), say, "en-US"), "New risk factor");
    assert.equal(changeLabel(item({}), say, "en-US", 3), "3 new risk factors");
    assert.equal(changeLabel(item({ kind: "auditor_name", previous: "Ernst & Young LLP", name: "KPMG LLP" }), say, "en-US"), "Auditor changed from Ernst & Young LLP to KPMG LLP");
    assert.equal(
      changeLabel(item({ kind: "customer_share", name: "Apple", pct: 29.8, previousPct: 30.8, detail: "revenue" }), say, "en-US"),
      "Apple: 29.8% of revenue, 30.8% the year before",
    );
    assert.equal(changeLabel(item({ kind: "late_filing", form: "NT 10-Q", detail: "NT 10-Q" }), say, "en-US"), "Late filing notice, NT 10-Q");
    assert.equal(changeLabel(item({ kind: "restatement", form: "8-K" }), say, "en-US", 2), "Past financial statements no longer to be relied on, 8-K Item 4.02");
    assert.equal(filingDate("2026-02-20", "en-US"), "Feb 20, 2026");
    assert.equal(sharePct(11, "en-US"), "11%");
  });

  it("opens only SEC links", () => {
    assert.equal(safeSecUrl("https://www.sec.gov/Archives/x.htm#a"), "https://www.sec.gov/Archives/x.htm#a");
    assert.equal(safeSecUrl("javascript:alert(1)"), null);
    assert.equal(safeSecUrl("https://sec.gov.example.com/x"), null);
  });
});

describe("overview rows", () => {
  const changes = (ticker: string, items: FilingChangeItem[]): FilingChanges => ({
    ticker,
    checkedAt: "2026-10-15T15:00:00.000Z",
    latest: null,
    previous: null,
    quarter: null,
    quarterRisk: null,
    riskCount: null,
    relationships: "none",
    items,
    missing: [],
  });

  it("one line per kind per filing, newest first, without repeats, old items or quiet kinds", () => {
    const rows = overviewRows(
      [
        {
          held: true,
          watchlist: false,
          changes: changes("ACME", [
            item({ id: "a" }),
            item({ id: "b" }),
            item({ id: "c", kind: "risk_reworded", notable: false }),
            item({ id: "d", kind: "material_weakness", repeat: true, notable: false }),
            item({ id: "e", kind: "auditor_change", form: "8-K", date: "2026-03-10" }),
            item({ id: "f", kind: "late_filing", form: "NT 10-K", date: "2024-03-10" }),
          ]),
        },
        { held: false, watchlist: true, changes: changes("INIT", [item({ id: "g", kind: "going_concern", date: "2026-02-20" })]) },
      ],
      "2026-10-15",
    );
    assert.deepEqual(
      rows.map((r) => [r.ticker, r.item.kind, r.count]),
      [
        ["ACME", "auditor_change", 1],
        ["INIT", "going_concern", 1],
        ["ACME", "risk_new", 2],
      ],
    );
  });

  it("reads the request: tickers upper-cased, held names not repeated as watched", () => {
    assert.deepEqual(parseOverviewRequest({ held: ["nvda", "AAPL"], watchlist: ["NVDA", "msft", "bad ticker"] }), { held: ["NVDA", "AAPL"], watchlist: ["MSFT"] });
    assert.equal(parseOverviewRequest({ held: "NVDA" }), null);
  });
});
