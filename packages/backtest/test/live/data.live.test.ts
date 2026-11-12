// Network: real Yahoo data. Run with `pnpm --filter @falcon/backtest test:live`.
import test from "node:test";
import assert from "node:assert/strict";
import { JsonCache, YahooEarningsSource, YahooPriceSource } from "../../src/data/index";

test("Yahoo: adjusted SPY bars for a month", async () => {
  const bars = await new YahooPriceSource(new JsonCache(null)).dailyBars("SPY", "2024-03-01", "2024-03-31");
  assert.ok(bars.length >= 19 && bars.length <= 21, String(bars.length));
  for (const b of bars) assert.ok(b.low <= b.open && b.open <= b.high && b.low <= b.close && b.close <= b.high);
});

test("Yahoo: an unknown ticker is empty, not an error", async () => {
  assert.deepEqual(await new YahooPriceSource(new JsonCache(null)).dailyBars("ZZZZZZQ", "2024-01-01", "2024-02-01"), []);
});

test("Yahoo: NVDA earnings history goes back years", async () => {
  const ev = await new YahooEarningsSource(new JsonCache(null)).earnings("NVDA", "2016-01-01", "2026-12-31");
  assert.ok(ev.length >= 30, String(ev.length));
  assert.ok(ev.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)));
});
