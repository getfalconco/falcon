// Run: node --import tsx --test apps/web/lib/prices-api.test.ts (tsx from packages/engine)
import assert from "node:assert/strict";
import { test } from "node:test";
import { adjustBars, historyOf, isPriceRange, latestOf, normalizeTicker, rangeStart, splitFactor, type StoredBar } from "./prices-api";

const bar = (date: string, close: number, volume = 100): StoredBar => ({ date, open: close, high: close + 1, low: close - 1, close, volume });

test("tickers and ranges", () => {
  assert.equal(normalizeTicker(" brk.b "), "BRK-B");
  assert.equal(normalizeTicker("NVDA"), "NVDA");
  assert.equal(normalizeTicker("1ABC"), null);
  assert.equal(normalizeTicker(""), null);
  assert.ok(isPriceRange("5y"));
  assert.ok(!isPriceRange("2y"));
});

test("range starts count back from the newest bar", () => {
  assert.equal(rangeStart("1y", "2026-11-13"), "2025-11-14");
  assert.equal(rangeStart("1m", "2026-03-31"), "2026-03-01");
  assert.equal(rangeStart("3m", "2026-11-13"), "2026-08-14");
  assert.equal(rangeStart("5y", "2026-11-13"), "2021-11-14");
  assert.equal(rangeStart("max", "2026-11-13"), null);
});

test("split adjustment: earlier prices divided, volumes multiplied", () => {
  const splits = [{ date: "2026-06-10", ratio: 10 }, { date: "2026-09-01", ratio: 2 }];
  assert.equal(splitFactor(splits, "2026-06-09"), 20);
  assert.equal(splitFactor(splits, "2026-06-10"), 2);
  assert.equal(splitFactor(splits, "2026-09-01"), 1);
  const bars = adjustBars([bar("2026-09-01", 50), bar("2026-06-09", 1000), bar("2026-06-10", 100)], splits);
  assert.deepEqual(bars.map((b) => b[0]), ["2026-06-09", "2026-06-10", "2026-09-01"]);
  assert.deepEqual(bars.map((b) => b[4]), [50, 50, 50]);
  assert.deepEqual(bars.map((b) => b[5]), [2000, 200, 100]);
});

test("history payload: dates, count, only the splits inside the series", () => {
  const h = historyOf("NVDA", "1y", [bar("2026-06-09", 1000), bar("2026-06-10", 100)], [{ date: "2024-06-10", ratio: 10 }, { date: "2026-06-10", ratio: 10 }]);
  assert.equal(h.asOf, "2026-06-10");
  assert.equal(h.from, "2026-06-09");
  assert.equal(h.count, 2);
  assert.deepEqual(h.splits, [{ date: "2026-06-10", ratio: 10 }]);
  assert.deepEqual(h.columns, ["date", "open", "high", "low", "close", "volume"]);
  assert.equal(h.source, "EQUS.SUMMARY via Databento");
  assert.equal(historyOf("X", "1m", [], []).asOf, null);
});

test("latest: change against the previous close, split-adjusted", () => {
  const l = latestOf("AAPL", [bar("2026-11-12", 200, 5), bar("2026-11-13", 210, 7)], []);
  assert.equal(l.date, "2026-11-13");
  assert.equal(l.prevDate, "2026-11-12");
  assert.equal(l.close, 210);
  assert.equal(l.change, 10);
  assert.equal(l.changePct, 5);
  assert.equal(l.volume, 7);
  // A 4-for-1 on the latest session: the previous 800 is 200 in today's shares.
  const s = latestOf("AAPL", [bar("2026-11-12", 800), bar("2026-11-13", 202)], [{ date: "2026-11-13", ratio: 4 }]);
  assert.equal(s.prevClose, 200);
  assert.equal(s.changePct, 1);
  // One bar: no change.
  const one = latestOf("NEW", [bar("2026-11-13", 10)], []);
  assert.equal(one.prevClose, null);
  assert.equal(one.change, null);
  assert.equal(latestOf("NONE", [], []).date, null);
});
