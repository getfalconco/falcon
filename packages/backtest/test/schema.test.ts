import test from "node:test";
import assert from "node:assert/strict";
import { describeStrategy, isAdviceLike, neutralize, plainStyle, validateRunConfig, validateStrategy } from "../src/index";
import { strategy } from "./helpers";

const now = new Date("2026-11-12T12:00:00Z");

test("validateStrategy: upper-cases tickers and checks spelling, duplicates and the ticker cap", () => {
  const ok = validateStrategy(strategy({ universe: ["spy"] }));
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.value.universe, ["SPY"]);

  const bad = validateStrategy(strategy({ universe: ["SP Y"] }));
  assert.ok(!bad.ok && bad.errors.some((e) => e.includes("not a valid symbol")));

  const dup = validateStrategy(strategy({ universe: ["AAA", "aaa"] }));
  assert.ok(!dup.ok && dup.errors.some((e) => e.includes("repeat")));

  const many = Array.from({ length: 25 }, (_, i) => `T${i}`);
  const withRef = strategy({
    universe: many,
    entry: { mode: "all", conditions: [{ type: "price_vs_ma", ticker: "SPY", ma: "sma", period: 200, op: "above" }] },
  });
  const capped = validateStrategy(withRef);
  assert.ok(!capped.ok && capped.errors.some((e) => e.includes("at most 25 tickers")));

  const cross = validateStrategy(
    strategy({
      entry: {
        mode: "all",
        conditions: [{ type: "ma_cross", ticker: null, fastMa: "sma", fastPeriod: 200, slowMa: "sma", slowPeriod: 50, op: "crosses_above" }],
      },
    }),
  );
  assert.ok(!cross.ok);
});

test("validateStrategy: rejects wrong shapes with readable paths", () => {
  const r = validateStrategy({ ...strategy(), entry: { mode: "all", conditions: [{ type: "rsi", period: 1, op: "below", value: 10 }] } });
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.startsWith("entry.conditions.0")), r.errors.join(" | "));
  assert.ok(!validateStrategy({ ...strategy(), exit: { ...strategy().exit, maxHoldingDays: 1000 } }).ok);
  assert.ok(!validateStrategy(null).ok);
});

test("validateRunConfig: defaults to the last 10 years and enforces the window", () => {
  const d = validateRunConfig(undefined, now);
  assert.ok(d.ok);
  assert.deepEqual(d.ok && [d.value.start, d.value.end, d.value.initialCapital], ["2016-11-12", "2026-11-12", 100_000]);
  const long = validateRunConfig({ start: "2010-01-01", end: "2026-01-01" }, now);
  assert.ok(!long.ok && long.errors.some((e) => e.includes("10 years")));
  assert.ok(!validateRunConfig({ start: "2026-01-01", end: "2027-01-01" }, now).ok);
  assert.ok(!validateRunConfig({ start: "1990-01-01", end: "1999-01-01" }, now).ok);
  assert.ok(!validateRunConfig({ start: "2024-02-30", end: "2025-01-01" }, now).ok);
  assert.ok(!validateRunConfig({ start: "2024-01-01", end: "2025-01-01", slippageBps: 5000 }, now).ok);
  assert.ok(validateRunConfig({ start: "2016-11-12", end: "2026-11-12" }, now).ok);
});

test("describeStrategy: the rules in plain words", () => {
  const lines = describeStrategy(
    strategy({
      universe: ["SPY"],
      entry: { mode: "all", conditions: [{ type: "price_vs_ma", ticker: null, ma: "sma", period: 200, op: "above" }] },
      exit: { conditions: [{ type: "price_vs_ma", ticker: null, ma: "sma", period: 200, op: "below" }], stopLossPct: 8, takeProfitPct: null, maxHoldingDays: null },
    }),
  );
  assert.deepEqual(lines, [
    "Trades SPY.",
    "Enters at the next open when, on the close, SPY closes above its 200-day simple moving average.",
    "Exits at the next open when, on the close, SPY closes below its 200-day simple moving average.",
    "Stop loss 8% below the entry price.",
    "One position at a time, 100% of equity.",
  ]);
  const earn = describeStrategy(
    strategy({
      universe: ["NVDA", "AMD"],
      entry: { mode: "all", conditions: [{ type: "earnings_surprise", ticker: null, op: "above", pct: 5, daysAfter: 1 }] },
      exit: { conditions: [], stopLossPct: null, takeProfitPct: null, maxHoldingDays: 10 },
      sizing: { maxPositions: 2, positionPct: null },
    }),
  );
  assert.ok(earn[1]!.includes("1 trading day after the stock reports earnings with an EPS surprise above +5%"));
  assert.ok(earn.includes("Exits at the open after 10 trading days held."));
  for (const l of [...lines, ...earn]) assert.ok(!/[\u2014\u2013]/.test(l));
});

test("neutralize: drops advice-like sentences, keeps information, strips em dashes and emoji", () => {
  assert.ok(isAdviceLike("You should buy NVDA now."));
  assert.ok(isAdviceLike("This strategy will make money."));
  assert.ok(isAdviceLike("Guaranteed returns every year."));
  assert.ok(isAdviceLike("We recommend holding through earnings."));
  assert.ok(!isAdviceLike("RSI period set to 14."));
  assert.ok(!isAdviceLike("Buy when the close is above the 200-day average."));
  const n = neutralize("RSI period set to 14. You should buy this now! Positions are held to the end of the test.");
  assert.equal(n.text, "RSI period set to 14. Positions are held to the end of the test.");
  assert.equal(n.removed, 1);
  assert.equal(plainStyle("Semis \u2014 15 names \u{1F680}"), "Semis, 15 names");
});

test("validateRunConfig: wrong types are errors, never exceptions", () => {
  for (const bad of [{ end: 123 }, { end: "2024-13-45" }, { start: "x", end: "2024-01-01" }, { initialCapital: "lots" }]) {
    const r = validateRunConfig(bad as never, now);
    assert.ok(!r.ok, JSON.stringify(bad));
  }
});
