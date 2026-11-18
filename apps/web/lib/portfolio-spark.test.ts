// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/portfolio-spark.test.ts
// The "Last 7 Days" lines: closes from the last 7 calendar days, gaps dropped, thinned; symbols checked and capped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SPARK_SYMBOLS, sparkFromChart, sparkSymbols } from "./portfolio-spark";

const NOW = Date.UTC(2026, 10, 17, 20);
const H = 3_600;

test("closes from the last 7 days only, nulls and zeros dropped, nothing invented", () => {
  const t0 = NOW / 1000;
  const chart = {
    meta: {},
    timestamp: [t0 - 8 * 24 * H, t0 - 6 * 24 * H, t0 - 5 * 24 * H, t0 - 3 * H, t0 - H],
    indicators: { quote: [{ close: [90, 100, null, 0, 104] }] },
  };
  assert.deepEqual(sparkFromChart(chart, NOW), [100, 104]);
  assert.deepEqual(sparkFromChart(null, NOW), []);
  assert.deepEqual(sparkFromChart({ meta: {} }, NOW), []);
});

test("a long series is thinned evenly to the cap, keeping the first and last close", () => {
  const t0 = NOW / 1000;
  const n = 168;
  const chart = { meta: {}, timestamp: Array.from({ length: n }, (_, i) => t0 - (n - i) * H + 60), indicators: { quote: [{ close: Array.from({ length: n }, (_, i) => 100 + i) }] } };
  const line = sparkFromChart(chart, NOW, { points: 60 });
  assert.equal(line.length, 60);
  assert.deepEqual([line[0], line[59]], [100, 100 + n - 1]);
  assert.ok(line.every((v, i) => i === 0 || v > line[i - 1]!), "order kept");
});

test("symbols: quote symbols only, upper-cased, deduplicated, capped", () => {
  assert.deepEqual(sparkSymbols(" aapl,BRK-B,BTC-USD,aapl,NVDA261218C00150000,<x>,,^VIX"), ["AAPL", "BRK-B", "BTC-USD", "NVDA261218C00150000", "^VIX"]);
  assert.equal(sparkSymbols(null).length, 0);
  assert.equal(sparkSymbols(Array.from({ length: 100 }, (_, i) => `S${i}`).join(",")).length, MAX_SPARK_SYMBOLS);
});
