import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { copyProblems, textProblems } from "../../../../shared/copy-rules";
import * as readthrough from "../../../lib/i18n/messages/areas/readthrough";
import * as stocktab from "../../../lib/i18n/messages/areas/stocktab";
import { interpolate } from "../../../lib/i18n/translate";
import { focusLine, focusRows, focusWhen } from "../../../../shared/readthrough-view";
import type { ReadthroughRow, ReadthroughStats } from "../../../../shared/readthrough-types";
import type { ReadthroughAnswer } from "../../../lib/readthrough-store";
import { ReadthroughRows } from "./ReadthroughSection";

/**
 * The Stock tab's Read-through section: the house copy rules over its lines
 * (`readthrough.focus.*` and the section heading) in every language, the
 * sentences a reader meets, the order (by measured sensitivity) and the
 * rendered rows: plain text tickers, the sample always there, no figure
 * below three reports, a date only for a report inside the window.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWN = /^readthrough\.focus\./;
const LANGS = ["tr", "de", "fr", "es", "it", "ptBR", "ja", "zhCN", "ko"] as const;
const say = (key: string, params?: Record<string, string | number>) => interpolate((readthrough.en as Record<string, string>)[key] ?? key, params ?? {});
const TODAY = "2026-10-15";

function stats(withIt: number, events: number, abnormal: number, normal: number | null): ReadthroughStats {
  return {
    events,
    withIt,
    avgAbsMove: abnormal + 0.004,
    avgAbsAbnormal: abnormal,
    avgFollow: 0.006,
    avgNextFollow: 0.001,
    nextEvents: events,
    normalAbsAbnormal: normal,
    sensitivity: normal ? abnormal / normal : null,
    surpriseEvents: 0,
    withSurprise: 0,
    beta: 1.4,
    betaFallback: false,
    from: "2024-10-17",
    to: "2026-07-17",
  };
}

function row(counterparty: string, extra: Partial<ReadthroughRow> = {}): ReadthroughRow {
  return {
    id: `${counterparty}>NVDA`,
    counterparty,
    counterpartyName: null,
    holding: "NVDA",
    held: true,
    watchlist: false,
    relation: "supplier",
    tier: "critical",
    namedBy: "NVDA",
    form: "10-K",
    filingDate: "2026-02-26",
    sourceUrl: "https://www.sec.gov/Archives/x.htm",
    kind: "later",
    date: null,
    time: "unknown",
    status: null,
    report: null,
    sample: 8,
    stats: stats(6, 8, 0.024, 0.011),
    events: [],
    weight: 1,
    score: 0,
    ...extra,
  };
}

const ROWS: ReadthroughRow[] = [
  row("MU", { relation: "competitor", sample: 2, stats: null }),
  row("AVGO", { stats: stats(4, 5, 0.012, 0.01), sample: 5, kind: "later", date: "2026-12-11" }),
  row("TSM", { kind: "upcoming", date: "2026-10-16", time: "bmo" }),
  row("SMCI", { relation: "customer", sample: 0, stats: null }),
  row("AMD", { relation: "competitor", stats: stats(5, 7, 0.02, null), sample: 7, kind: "recent", date: "2026-10-14", time: "amc" }),
];

function answer(rows: ReadthroughRow[], extra: Partial<ReadthroughAnswer> = {}): ReadthroughAnswer {
  return { ok: true, today: TODAY, builtAt: `${TODAY}T14:00:00.000Z`, rows, links: rows.length, truncated: false, degraded: [], ...extra };
}

describe("stock tab read-through: copy", () => {
  const own = Object.entries(readthrough.en).filter(([key]) => OWN.test(key));

  it("has its lines in the table", () => {
    assert.ok(own.length >= 9);
    assert.equal(stocktab.en["stocktab.tab.section.readthrough"], "Read-through");
  });

  it("the English lines follow the copy rules, risk words included", () => {
    const problems = [...own, ["stocktab.tab.section.readthrough", stocktab.en["stocktab.tab.section.readthrough"]] as const].flatMap(([key, text]) =>
      textProblems(text, { riskWords: true }).map((p) => `${key}: ${p}`),
    );
    assert.deepEqual(problems, []);
  });

  it("every language has the lines, keeps the placeholders, with no dashes and no exclamation marks", () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    for (const lang of LANGS) {
      const tables: Array<[string, string, Record<string, string | undefined>]> = [
        ...own.map(([key, text]) => [key, text, readthrough[lang] as Record<string, string | undefined>] as [string, string, Record<string, string | undefined>]),
        ["stocktab.tab.section.readthrough", stocktab.en["stocktab.tab.section.readthrough"], stocktab[lang] as Record<string, string | undefined>],
      ];
      for (const [key, text, table] of tables) {
        const tr = table[key];
        assert.ok(tr, `${lang} ${key} missing`);
        assert.equal(placeholders(tr!), placeholders(text), `${lang} ${key}`);
        assert.ok(!/[‒–—―－〜～⸺⸻]/.test(tr!), `${lang} ${key} has a dash`);
        assert.ok(!/[!！]/.test(tr!), `${lang} ${key} has an exclamation mark`);
      }
    }
  });

  it("the component carries no line of its own that breaks the rules", () => {
    const src = fs.readFileSync(path.join(HERE, "ReadthroughSection.tsx"), "utf8");
    assert.deepEqual(copyProblems(src, { jsxText: true, riskWords: true }), []);
  });
});

describe("stock tab read-through: sentences and order", () => {
  it("says what was measured, the sample always in it", () => {
    assert.equal(focusLine(row("TSM"), say, "en-US"), "Moves with TSM reports 6 of last 8 times · 2.4% on the day vs 1.1% on a normal day");
    assert.equal(focusLine(row("AMD", { stats: stats(5, 7, 0.02, null), sample: 7 }), say, "en-US"), "Moves with AMD reports 5 of last 7 times · 2.0% on the day");
  });

  it("gives only the count below three reports", () => {
    const two = focusLine(row("MU", { sample: 2, stats: null }), say, "en-US");
    assert.equal(two, "2 past reports measured, too few for figures");
    assert.doesNotMatch(two, /%/);
    assert.equal(focusLine(row("MU", { sample: 1, stats: null }), say, "en-US"), "1 past report measured, too few for figures");
    assert.equal(focusLine(row("MU", { sample: 0, stats: null }), say, "en-US"), "No past reports measured");
  });

  it("dates a report only inside the window", () => {
    assert.equal(focusWhen(row("TSM", { kind: "upcoming", date: "2026-10-16" }), TODAY, say, "en-US"), "Reports tomorrow");
    assert.equal(focusWhen(row("AMD", { kind: "recent", date: "2026-10-14" }), TODAY, say, "en-US"), "Reported yesterday");
    assert.equal(focusWhen(row("TSM", { kind: "upcoming", date: "2026-10-22" }), TODAY, say, "en-US"), "Reports Thu, Oct 22");
    assert.equal(focusWhen(row("AVGO", { kind: "later", date: "2026-12-11" }), TODAY, say, "en-US"), null);
  });

  it("puts measured rows first, by sensitivity, then the larger samples", () => {
    assert.deepEqual(
      focusRows(ROWS).map((r) => r.counterparty),
      ["TSM", "AVGO", "AMD", "MU", "SMCI"],
    );
  });
});

describe("stock tab read-through: rendering", () => {
  it("draws one title line per company, tickers as plain text, in sensitivity order", () => {
    const html = renderToStaticMarkup(createElement(ReadthroughRows, { answer: answer(ROWS), ticker: "NVDA" }));
    const order = ["TSM", "AVGO", "AMD", "MU", "SMCI"].map((t) => html.indexOf(`>${t}</button>`));
    assert.ok(order.every((i) => i >= 0), "every ticker is a button");
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(html, /Moves with TSM reports 6 of last 8 times · 2\.4% on the day vs 1\.1% on a normal day/);
    assert.match(html, /2 past reports measured, too few for figures/);
    assert.match(html, /No past reports measured/);
    assert.match(html, />Reports tomorrow</);
    assert.match(html, />Reported yesterday</);
    assert.doesNotMatch(html, /Dec 11/);
    assert.match(html, />Supplier</);
    assert.match(html, />Competitor</);
    assert.doesNotMatch(html, /rounded-full/, "no pills");
    assert.match(html, /last 8 reports on record, at least 3 for figures/);
  });

  it("folds rows past the limit behind a count, and notes a partial answer", () => {
    const html = renderToStaticMarkup(createElement(ReadthroughRows, { answer: answer(ROWS, { truncated: true, degraded: ["prices"] }), ticker: "NVDA", limit: 3 }));
    assert.match(html, /Show 2 more/);
    assert.doesNotMatch(html, />SMCI</);
    assert.match(html, /Only the closest links are measured\./);
    assert.match(html, /Some figures could not be read this time\./);
  });

  it("draws nothing for a stock with no measured links", () => {
    assert.equal(renderToStaticMarkup(createElement(ReadthroughRows, { answer: answer([]), ticker: "NVDA" })), "");
    assert.equal(renderToStaticMarkup(createElement(ReadthroughRows, { answer: answer(ROWS), ticker: "AAPL" })), "");
  });
});
