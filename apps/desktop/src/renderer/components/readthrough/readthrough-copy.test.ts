import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems } from "../../../shared/copy-rules";
import { en } from "../../lib/i18n/messages/areas/readthrough";
import { cardRows, headLine, sinceLine, statsLine, whenText } from "../../../shared/readthrough-view";
import type { ReadthroughRow, ReadthroughStats } from "../../../shared/readthrough-types";
import { interpolate } from "../../lib/i18n/translate";

/**
 * The house copy rules over the Read-through card and section (no advice
 * words, no forward-looking words, no dash, no "edge" or "AI"), held over
 * the English table and whatever literals the components keep, and the
 * sentences a reader meets, built from the table as the views build them.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = ["ReadthroughCard.tsx", "ReadthroughSection.tsx", "readthrough-ui.tsx"].map((f) => [f, fs.readFileSync(path.join(HERE, f), "utf8")] as const);
const TABLE = Object.values(en)
  .map((text) => JSON.stringify(text))
  .join("\n");

const say = (key: string, params?: Record<string, string | number>) => interpolate((en as Record<string, string>)[key] ?? key, params ?? {});

function stats(withIt: number, events: number): ReadthroughStats {
  return {
    events,
    withIt,
    avgAbsMove: 0.021,
    avgAbsAbnormal: 0.014,
    avgFollow: 0.006,
    avgNextFollow: 0.001,
    nextEvents: events,
    normalAbsAbnormal: 0.009,
    sensitivity: 1.6,
    surpriseEvents: 4,
    withSurprise: 3,
    beta: 1.4,
    betaFallback: false,
    from: "2024-10-17",
    to: "2026-07-17",
  };
}

function row(extra: Partial<ReadthroughRow>): ReadthroughRow {
  return {
    id: "TSM>NVDA",
    counterparty: "TSM",
    counterpartyName: "Taiwan Semiconductor",
    holding: "NVDA",
    held: true,
    watchlist: false,
    relation: "supplier",
    tier: "critical",
    namedBy: "NVDA",
    form: "10-K",
    filingDate: "2026-02-26",
    sourceUrl: "https://www.sec.gov/Archives/x.htm",
    kind: "upcoming",
    date: "2026-10-16",
    time: "bmo",
    status: "confirmed",
    report: null,
    sample: 8,
    stats: stats(6, 8),
    events: [],
    weight: 1,
    score: 1.6,
    ...extra,
  };
}

describe("readthrough copy", () => {
  it("follows the copy rules", () => {
    for (const [file, src] of FILES) assert.deepEqual(copyProblems(src, { riskWords: true, jsxText: true }), [], file);
    assert.deepEqual(copyProblems(TABLE, { riskWords: true }), []);
  });

  it("says what was measured, in plain words", () => {
    const today = "2026-10-15";
    assert.equal(headLine(row({}), today, say, "en-US"), "TSM reports tomorrow, before the open");
    assert.equal(headLine(row({ date: "2026-10-22", time: "unknown" }), today, say, "en-US"), "TSM reports Thu, Oct 22");
    assert.equal(statsLine(row({}), say, "en-US"), "NVDA moved with it 6 of the last 8 times · average 2.1% on the day");
    assert.equal(statsLine(row({ stats: null, sample: 2 }), say, "en-US"), "NVDA: 2 past reports measured, 3 needed for figures");
    const recent = row({
      kind: "recent",
      date: "2026-10-14",
      report: { epsActual: 2.92, epsEstimate: 2.61, surprisePct: 11.88, reactionDay: "2026-10-14", counterpartyMove: 0.031, holdingOnDay: 0.012, holdingSince: 0.018, sinceTo: "2026-10-15" },
    });
    assert.equal(headLine(recent, today, say, "en-US"), "TSM reported yesterday · EPS 2.92 vs 2.61");
    assert.equal(sinceLine(recent, say, "en-US"), "NVDA +1.2% on the day, +1.8% since");
    assert.equal(whenText("2026-10-13", today, say, "en-US"), "Tue, Oct 13");
  });

  it("puts one row per linked company on the card, and nothing without a date in view", () => {
    const rows = [row({}), row({ id: "TSM>AMD", holding: "AMD" }), row({ id: "INTC>NVDA", counterparty: "INTC", kind: "later" }), row({ id: "MU>NVDA", counterparty: "MU" })];
    assert.deepEqual(
      cardRows(rows, 4).map((r) => r.id),
      ["TSM>NVDA", "MU>NVDA"],
    );
  });
});
