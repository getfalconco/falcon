import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bootstrapMedianCI,
  deciles,
  equityCurve,
  hitRate,
  maxDrawdown,
  mean,
  median,
  percentile,
  seeded,
  sharpe,
  sortino,
  stdDev,
} from "./stats.js";

const close = (a: number | null, b: number, tol = 1e-9) => {
  assert.ok(a != null, "expected a number, got null");
  assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (tol ${tol})`);
};

describe("quantlab/stats — central tendency goldens", () => {
  it("mean and median on a hand-computed vector", () => {
    // sum = 15, n = 5 -> mean 3; sorted middle -> 3
    close(mean([1, 2, 3, 4, 5]), 3);
    close(median([1, 2, 3, 4, 5]), 3);
    // even n: midpoint of 2 and 3
    close(median([1, 2, 3, 4]), 2.5);
    assert.equal(mean([]), null);
    assert.equal(median([]), null);
  });

  it("percentile interpolates linearly between neighbours", () => {
    const sorted = [0, 10, 20, 30, 40];
    close(percentile(sorted, 0), 0);
    close(percentile(sorted, 1), 40);
    close(percentile(sorted, 0.5), 20);
    // pos = 4 * 0.25 = 1.0 -> exactly the second element
    close(percentile(sorted, 0.25), 10);
    // pos = 4 * 0.3 = 1.2 -> 10 + (20-10)*0.2
    close(percentile(sorted, 0.3), 12);
    assert.equal(percentile([], 0.5), null);
    close(percentile([7], 0.9), 7);
  });

  it("sample stdDev uses n-1", () => {
    // [2,4,4,4,5,5,7,9]: mean 5, squared devs sum 32, /7 = 4.5714...
    close(stdDev([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7), 1e-12);
    assert.equal(stdDev([1]), null);
  });

  it("hitRate counts strictly positive returns", () => {
    close(hitRate([1, -1, 0, 2]), 0.5, 1e-12);
    assert.equal(hitRate([]), null);
    close(hitRate([0, 0, 0]), 0);
  });

  it("deciles returns p10..p90", () => {
    const d = deciles([...Array(11).keys()]); // 0..10
    assert.equal(d.length, 9);
    // pos = 10 * 0.1 = 1 -> 1 ; p90 -> 9
    close(d[0], 1);
    close(d[8], 9);
    assert.deepEqual(deciles([]), []);
  });
});

describe("quantlab/stats — risk-adjusted goldens", () => {
  // Four 5-session returns. mean = 0.01, stdDev = sqrt(sum sq dev / 3).
  const xs = [0.02, -0.01, 0.03, 0.0];
  const input = { holdSessions: 5, sessionsPerYear: 252, riskFreeRate: 0 };

  it("sharpe matches the hand-computed value", () => {
    const m = 0.01;
    const ss = (0.02 - m) ** 2 + (-0.01 - m) ** 2 + (0.03 - m) ** 2 + (0 - m) ** 2;
    const sd = Math.sqrt(ss / 3);
    const expected = (m / sd) * Math.sqrt(252 / 5);
    close(sharpe(xs, input), expected, 1e-12);
  });

  it("sortino only penalises the downside, so it exceeds sharpe on this vector", () => {
    // shortfalls below 0: -0.01 and 0.0 -> only (-0.01)^2 counts
    const downside = Math.sqrt(0.0001 / 4);
    const expected = (0.01 / downside) * Math.sqrt(252 / 5);
    close(sortino(xs, input), expected, 1e-12);
    assert.ok(sortino(xs, input)! > sharpe(xs, input)!);
  });

  it("a non-zero risk-free rate is charged per period, not per year", () => {
    const rf = { holdSessions: 5, sessionsPerYear: 252, riskFreeRate: 0.0504 };
    // periodsPerYear = 50.4, so the per-period hurdle is 0.001
    const m = 0.01;
    const ss = (0.02 - m) ** 2 + (-0.01 - m) ** 2 + (0.03 - m) ** 2 + (0 - m) ** 2;
    const sd = Math.sqrt(ss / 3);
    close(sharpe(xs, rf), ((m - 0.001) / sd) * Math.sqrt(50.4), 1e-12);
  });

  it("returns null rather than infinity when there is no dispersion", () => {
    assert.equal(sharpe([0.01, 0.01, 0.01], input), null);
    // never negative -> downside deviation is zero -> not computable
    assert.equal(sortino([0.01, 0.02, 0.03], input), null);
    assert.equal(sharpe([0.01], input), null);
    assert.equal(sortino([0.01], input), null);
  });

  it("a longer hold annualises by a smaller factor", () => {
    const short = sharpe(xs, { holdSessions: 1, sessionsPerYear: 252, riskFreeRate: 0 })!;
    const long = sharpe(xs, { holdSessions: 63, sessionsPerYear: 252, riskFreeRate: 0 })!;
    assert.ok(short > long, "1-session holds annualise up more than quarterly ones");
  });
});

describe("quantlab/stats — drawdown", () => {
  it("compounds sequentially and reports the worst peak-to-trough", () => {
    // 1 -> 1.5 -> 0.75 -> 0.9 ; peak 1.5, trough 0.75 -> -50%
    close(maxDrawdown([0.5, -0.5, 0.2]), -0.5, 1e-12);
  });

  it("is zero for a monotonically rising curve", () => {
    close(maxDrawdown([0.1, 0.1, 0.1]), 0);
  });

  it("order matters — the same returns rearranged give a different drawdown", () => {
    // Losses after a peak bite harder than the same losses taken first.
    // [-0.1, 0.2, -0.1]: 0.9 (-10%), 1.08 (new peak), 0.972 (-10% off 1.08)
    // [0.2, -0.1, -0.1]: 1.2 (peak), 1.08 (-10%), 0.972 (-19% off 1.2)
    const lossFirst = maxDrawdown([-0.1, 0.2, -0.1])!;
    const gainFirst = maxDrawdown([0.2, -0.1, -0.1])!;
    close(lossFirst, -0.1, 1e-12);
    close(gainFirst, 0.972 / 1.2 - 1, 1e-12);
    assert.ok(gainFirst < lossFirst, "the drawdown is path-dependent");
  });

  it("equityCurve compounds", () => {
    const curve = equityCurve([0.1, -0.1]);
    close(curve[0], 1.1, 1e-12);
    close(curve[1], 0.99, 1e-12);
  });

  it("is not computable with no signals", () => {
    assert.equal(maxDrawdown([]), null);
  });
});

describe("quantlab/stats — bootstrap", () => {
  const xs = [-0.05, -0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.04, 0.06, 0.08];

  it("brackets the sample median", () => {
    const ci = bootstrapMedianCI(xs, 2000, seeded(42))!;
    const m = median(xs)!;
    assert.ok(ci.low <= m && m <= ci.high, `median ${m} outside [${ci.low}, ${ci.high}]`);
    assert.ok(ci.low < ci.high, "a real interval, not a point");
  });

  it("is reproducible for a given seed and moves for another", () => {
    const a = bootstrapMedianCI(xs, 500, seeded(7))!;
    const b = bootstrapMedianCI(xs, 500, seeded(7))!;
    assert.deepEqual(a, b, "same seed must give the same interval");
    const c = bootstrapMedianCI(xs, 500, seeded(8))!;
    assert.notDeepEqual(a, c);
  });

  it("narrows as the sample grows — the width is the honesty", () => {
    const small = bootstrapMedianCI(xs, 2000, seeded(1))!;
    const big = bootstrapMedianCI([...xs, ...xs, ...xs, ...xs, ...xs, ...xs], 2000, seeded(1))!;
    assert.ok(big.high - big.low < small.high - small.low);
  });

  it("refuses a single observation", () => {
    assert.equal(bootstrapMedianCI([0.01], 100, seeded(1)), null);
  });
});

describe("quantlab/stats — seeded rng", () => {
  it("is deterministic and stays in [0,1)", () => {
    const a = seeded(123);
    const b = seeded(123);
    for (let i = 0; i < 100; i++) {
      const v = a();
      assert.equal(v, b());
      assert.ok(v >= 0 && v < 1);
    }
  });
});
