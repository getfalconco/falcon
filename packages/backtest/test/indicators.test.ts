import test from "node:test";
import assert from "node:assert/strict";
import { ema, gapPct, nDayReturn, priorExtreme, rsi, sma } from "../src/index";

const same = (a: number[], b: number[]) => {
  assert.equal(a.length, b.length);
  a.forEach((v, i) => (Number.isNaN(b[i]!) ? assert.ok(Number.isNaN(v), `index ${i}`) : assert.ok(Math.abs(v - b[i]!) < 1e-9, `index ${i}: ${v} vs ${b[i]}`)));
};

test("sma: rolling mean, NaN until the window is full", () => {
  same(sma([1, 2, 3, 4, 5], 3), [NaN, NaN, 2, 3, 4]);
  same(sma([5], 2), [NaN]);
});

test("ema: seeded with the simple mean, alpha 2/(n+1)", () => {
  same(ema([1, 2, 3, 4, 5], 3), [NaN, NaN, 2, 3, 4]);
  same(ema([2, 4, 6, 8], 1), [2, 4, 6, 8]);
});

test("rsi: Wilder smoothing, hand-computed values", () => {
  // changes +1 -1 +1 +1; first avg gain .5 loss .5 -> 50; then (.75,.25) -> 75; (.875,.125) -> 87.5
  same(rsi([10, 11, 10, 11, 12], 2), [NaN, NaN, 50, 75, 87.5]);
  assert.equal(rsi([1, 2, 3, 4, 5, 6], 3).at(-1), 100);
  assert.equal(rsi([5, 5, 5, 5], 2).at(-1), 50);
  assert.ok(rsi([6, 5, 4, 3, 2, 1], 3).at(-1)! < 1e-9);
});

test("n-day return, gap and prior extremes", () => {
  same(nDayReturn([100, 110, 99], 1), [NaN, 10, -10]);
  same(nDayReturn([100, 110, 121], 2), [NaN, NaN, 21]);
  same(gapPct([100, 102, 99], [100, 100, 100]), [NaN, 2, -1]);
  same(priorExtreme([1, 3, 2, 5, 4], 2, "max"), [NaN, NaN, 3, 3, 5]);
  same(priorExtreme([1, 3, 2, 5, 4], 2, "min"), [NaN, NaN, 1, 2, 2]);
});

test("indicators never read the future: value i is unchanged when later inputs change", () => {
  const a = [10, 12, 11, 13, 15, 14, 16, 18, 17, 19];
  const b = [...a.slice(0, 6), 1, 1000, 3, 2];
  for (const f of [(x: number[]) => sma(x, 3), (x: number[]) => ema(x, 3), (x: number[]) => rsi(x, 3), (x: number[]) => priorExtreme(x, 3, "max")]) {
    same(f(a).slice(0, 6), f(b).slice(0, 6));
  }
});
